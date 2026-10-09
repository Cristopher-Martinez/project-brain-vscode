/**
 * Reactive Recall — contextual memory that surfaces relevant past solutions.
 *
 * Unlike AutoRecall (which fires once per session with general context),
 * ReactiveRecall monitors every tool call for problem-related patterns
 * and auto-injects relevant troubleshooting entries when they match.
 * Also surfaces relevant learned opinions on a cadenced basis.
 *
 * Think of it as the ship's lookout — always watching, only alerting
 * when there's actually something on the horizon.
 */

import * as fs from "fs";
import * as path from "path";
import type { OpinionBank } from "./opinion-bank";
import {
  PROBLEM_INDICATORS,
  calculateMatchScore,
  extractSearchableText,
  parseTroubleshootingEntries,
  tokenize,
} from "./reactive-recall-parser";

// Re-export parser for backward compat
export { parseTroubleshootingEntries } from "./reactive-recall-parser";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TroubleshootEntry {
  title: string;
  keywords: string[];
  solutionPreview: string;
  severity: string;
  lineNumber: number;
}

export interface ReactiveRecallConfig {
  /** Min keyword overlap score to trigger injection (default: 3) */
  minMatchScore: number;
  /** Max entries to inject per call (default: 2) */
  maxHints: number;
  /** Max recent injections to track for deduplication (default: 8) */
  dedupeWindow: number;
  /** Max opinion hints to inject per call (default: 3) */
  maxOpinionHints: number;
  /** Inject opinions every N tool calls (prevents context bloat) */
  opinionInjectionCadence: number;
}

const DEFAULT_CONFIG: ReactiveRecallConfig = {
  minMatchScore: 3,
  maxHints: 2,
  dedupeWindow: 8,
  maxOpinionHints: 3,
  opinionInjectionCadence: 5,
};

// ─── ReactiveRecall ─────────────────────────────────────────────────────────

export class ReactiveRecall {
  private index: TroubleshootEntry[] = [];
  private indexMtime = 0;
  private recentInjections: string[] = [];
  private config: ReactiveRecallConfig;
  private opinionBank: OpinionBank | null = null;
  private callCounter = 0;
  private recentOpinionIds: string[] = [];

  constructor(
    private memoryDir: string,
    private logFn: (msg: string) => void,
    config?: Partial<ReactiveRecallConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Attach OpinionBank for contextual opinion injection. */
  setOpinionBank(bank: OpinionBank): void {
    this.opinionBank = bank;
  }

  /**
   * Get contextual hints for a tool call, if relevant.
   * Returns empty string if no relevant context found.
   * Now includes both troubleshooting AND opinion-based hints.
   */
  getContextualHints(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): string {
    try {
      this.callCounter++;
      const parts: string[] = [];

      // 1. Extract searchable text from tool params
      const inputText = extractSearchableText(toolInput);
      if (!inputText) return "";

      // 2. Troubleshooting hints (problem-triggered)
      const troubleHints = this.getTroubleHints(inputText, toolName);
      if (troubleHints) parts.push(troubleHints);

      // 3. Opinion hints (cadence-based — every N calls)
      const opinionHints = this.getOpinionHints(inputText);
      if (opinionHints) parts.push(opinionHints);

      return parts.join("\n");
    } catch (err) {
      this.logFn(`[ReactiveRecall] Error: ${err}`);
      return "";
    }
  }

  /** Force rebuild of the index (e.g., after troubleshooting file changes). */
  invalidateCache(): void {
    this.indexMtime = 0;
    this.index = [];
  }

  /** Current index size (for diagnostics). */
  get entryCount(): number {
    return this.index.length;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /** Troubleshooting hints — only when problem indicators detected. */
  private getTroubleHints(inputText: string, toolName: string): string | null {
    const lowerText = inputText.toLowerCase();
    const hasProblem = [...PROBLEM_INDICATORS].some((p) =>
      lowerText.includes(p),
    );
    if (!hasProblem) return null;

    this.ensureIndex();
    if (this.index.length === 0) return null;

    const inputKeywords = tokenize(inputText);
    if (inputKeywords.length === 0) return null;

    const scored = this.index
      .map((entry) => ({
        entry,
        score: calculateMatchScore(inputKeywords, entry.keywords),
      }))
      .filter((s) => s.score >= this.config.minMatchScore)
      .filter((s) => !this.recentInjections.includes(s.entry.title))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxHints);

    if (scored.length === 0) return null;

    const hints = scored.map((s) => {
      this.trackInjection(s.entry.title);
      return `**${s.entry.title}** (${s.entry.severity})\n${s.entry.solutionPreview}`;
    });

    this.logFn(
      `[ReactiveRecall] Injected ${hints.length} trouble hint(s) for "${toolName}"`,
    );

    return (
      "\n\n---\n**Reactive Recall** — Relevant past solutions:\n\n" +
      hints.join("\n\n") +
      "\n---"
    );
  }

  /** Opinion hints — surfaces relevant opinions on a cadence. */
  private getOpinionHints(inputText: string): string | null {
    if (!this.opinionBank) return null;
    if (this.callCounter % this.config.opinionInjectionCadence !== 0) {
      return null;
    }

    const results = this.opinionBank.search(inputText);
    if (results.length === 0) return null;

    // Filter already-injected opinions + low confidence
    const fresh = results
      .filter((o) => !this.recentOpinionIds.includes(o.id))
      .filter((o) => o.confidence >= 0.5)
      .slice(0, this.config.maxOpinionHints);

    if (fresh.length === 0) return null;

    // Track for dedup
    for (const o of fresh) {
      this.recentOpinionIds.push(o.id);
      if (this.recentOpinionIds.length > 20) {
        this.recentOpinionIds.shift();
      }
    }

    const lines = fresh
      .map(
        (o) => `- [${o.domain}] (c=${o.confidence.toFixed(2)}) ${o.statement}`,
      )
      .join("\n");

    this.logFn(`[ReactiveRecall] Injected ${fresh.length} opinion hint(s)`);

    return `\n**Learned opinions** (relevant to current context):\n${lines}`;
  }

  private trackInjection(title: string): void {
    this.recentInjections.push(title);
    if (this.recentInjections.length > this.config.dedupeWindow) {
      this.recentInjections.shift();
    }
  }

  private ensureIndex(): void {
    const tsPath = path.join(this.memoryDir, "05_TROUBLESHOOTING.md");
    try {
      const stat = fs.statSync(tsPath);
      if (stat.mtimeMs === this.indexMtime && this.index.length > 0) return;

      const content = fs.readFileSync(tsPath, "utf-8");
      this.index = parseTroubleshootingEntries(content);
      this.indexMtime = stat.mtimeMs;
      this.logFn(
        `[ReactiveRecall] Indexed ${this.index.length} troubleshooting entries`,
      );
    } catch {
      // File doesn't exist yet — that's fine
      this.index = [];
    }
  }
}
