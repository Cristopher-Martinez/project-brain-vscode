/**
 * Opinion Bank — Neuroplasticity through evolving beliefs.
 *
 * Inspired by OpenClaw's "Retain/Recall/Reflect" cycle and Hindsight's
 * confidence-bearing opinions. Each opinion has a confidence score that
 * evolves with evidence — strengthened by success, weakened by contradiction.
 *
 * Persisted in .project-brain/memory/14_OPINIONS.md (Markdown, human-readable).
 *
 * Split into modules:
 * - opinion-types.ts    → types, constants, utilities
 * - opinion-persistence.ts → serialize/parse/fillDefaults
 * - opinion-reflect.ts  → reflect + healthCheck logic
 * - opinion-bank.ts     → OpinionBank class (this file)
 */

import * as fs from "fs";
import * as path from "path";

import { parseOpinions, serializeOpinions } from "./opinion-persistence";
import { opinionHealthCheck, reflectOpinions } from "./opinion-reflect";
import {
  CONTRADICT_DELTA_STRONG,
  CONTRADICT_DELTA_WEAK,
  type HealthReport,
  MAX_CONFIDENCE,
  MAX_OPINIONS,
  MIN_CONFIDENCE,
  OPINIONS_FILE,
  type Opinion,
  type OpinionDomain,
  REINFORCE_DELTA,
  type ReflectReport,
  areSimilarStatements,
  clamp,
  extractWords,
  isPolarityOpposite,
} from "./opinion-types";

// ─── Re-exports for backward compatibility ──────────────────────────────────

export { OPINIONS_FILE, areSimilarStatements, isPolarityOpposite };
export type { HealthReport, Opinion, OpinionDomain, ReflectReport };

// ─── OpinionBank ────────────────────────────────────────────────────────────

export class OpinionBank {
  private opinions: Opinion[] = [];
  private dirty = false;
  private sessionReinforcements = new Map<string, number>();
  private static readonly MAX_REINFORCEMENTS_PER_SESSION = 3;
  private _reflecting = false;

  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {
    this.load();
  }

  resetSessionCaps(): void {
    this.sessionReinforcements.clear();
    this.log("[OpinionBank] Session reinforcement caps reset");
  }

  // ─── Core API ─────────────────────────────────────────────────────

  addOpinion(
    statement: string,
    confidence: number,
    domain: OpinionDomain,
    evidence?: string,
  ): Opinion {
    const existing = this.findSimilar(statement);
    if (existing) {
      if (isPolarityOpposite(statement, existing.statement)) {
        this.contradict(
          existing.id,
          evidence || "polarity-contradiction-detected",
          false,
        );
        this.log(
          `[OpinionBank] Polarity contradiction: "${statement.substring(0, 50)}" vs "${existing.statement.substring(0, 50)}"`,
        );
      } else {
        this.reinforce(existing.id, evidence);
        return existing;
      }
    }

    const opinion: Opinion = {
      id: this.generateId(),
      statement: statement.trim(),
      confidence: clamp(confidence, MIN_CONFIDENCE, MAX_CONFIDENCE),
      domain,
      evidence: {
        supporting: evidence ? [evidence] : [],
        contradicting: [],
      },
      createdAt: new Date().toISOString().split("T")[0],
      lastUpdated: new Date().toISOString().split("T")[0],
    };

    this.opinions.push(opinion);
    this.dirty = true;
    this.pruneIfNeeded();
    this.log(
      `[OpinionBank] New opinion (c=${opinion.confidence.toFixed(2)}): "${statement.substring(0, 60)}"`,
    );
    return opinion;
  }

  reinforce(id: string, evidence?: string): void {
    const op = this.opinions.find((o) => o.id === id);
    if (!op) return;

    const count = this.sessionReinforcements.get(id) ?? 0;
    if (count >= OpinionBank.MAX_REINFORCEMENTS_PER_SESSION) {
      this.log(
        `[OpinionBank] Reinforce capped for "${op.statement.substring(0, 40)}" (${count}/${OpinionBank.MAX_REINFORCEMENTS_PER_SESSION})`,
      );
      return;
    }
    this.sessionReinforcements.set(id, count + 1);

    op.confidence = clamp(
      op.confidence + REINFORCE_DELTA,
      MIN_CONFIDENCE,
      MAX_CONFIDENCE,
    );
    op.lastUpdated = new Date().toISOString().split("T")[0];
    if (evidence) op.evidence.supporting.push(evidence);
    this.dirty = true;

    this.log(
      `[OpinionBank] Reinforced "${op.statement.substring(0, 40)}" → c=${op.confidence.toFixed(2)}`,
    );
  }

  contradict(id: string, evidence: string, strong = false): void {
    const op = this.opinions.find((o) => o.id === id);
    if (!op) return;

    const delta = strong ? CONTRADICT_DELTA_STRONG : CONTRADICT_DELTA_WEAK;
    op.confidence = clamp(
      op.confidence + delta,
      MIN_CONFIDENCE,
      MAX_CONFIDENCE,
    );
    op.lastUpdated = new Date().toISOString().split("T")[0];
    op.evidence.contradicting.push(evidence);
    this.dirty = true;

    this.log(
      `[OpinionBank] Contradicted "${op.statement.substring(0, 40)}" → c=${op.confidence.toFixed(2)}`,
    );
  }

  getOpinions(domain?: string): Opinion[] {
    let result = [...this.opinions];
    if (domain) result = result.filter((o) => o.domain === domain);
    return result.sort((a, b) => b.confidence - a.confidence);
  }

  getContextString(n = 10, domain?: string): string {
    const ops = this.getOpinions(domain).slice(0, n);
    if (ops.length === 0) return "";

    return ops
      .map(
        (o) => `• [${o.domain}] (c=${o.confidence.toFixed(2)}) ${o.statement}`,
      )
      .join("\n");
  }

  findById(id: string): Opinion | undefined {
    return this.opinions.find((o) => o.id === id);
  }

  search(query: string): Opinion[] {
    const lower = query.toLowerCase();
    return this.opinions
      .filter(
        (o) =>
          o.statement.toLowerCase().includes(lower) ||
          o.domain.toLowerCase().includes(lower),
      )
      .sort((a, b) => b.confidence - a.confidence);
  }

  get count(): number {
    return this.opinions.length;
  }

  save(): void {
    if (!this.dirty) return;
    const filePath = path.join(this.memoryPath, OPINIONS_FILE);
    const content = serializeOpinions(this.opinions);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    this.dirty = false;
  }

  flush(): { saved: number; dirty: boolean } {
    const wasDirty = this.dirty;
    if (wasDirty) {
      this.dirty = true;
      this.save();
    }
    this.log(
      `[OpinionBank] Flush: ${this.opinions.length} opinions, wasDirty=${wasDirty}`,
    );
    return { saved: this.opinions.length, dirty: wasDirty };
  }

  // ─── Reflect (delegates to opinion-reflect.ts) ────────────────────

  reflect(dryRun: boolean = false): ReflectReport {
    if (this._reflecting) {
      this.log("[OpinionBank] Reflect reentrant call — skipping (mutex)");
      return {
        total: this.opinions.length,
        pruned: [],
        merged: [],
        contradictions: [],
        stale: [],
        lowConfidence: [],
        testArtifacts: [],
        dryRun,
      };
    }
    this._reflecting = true;

    try {
      const { report, toRemove } = reflectOpinions(
        this.opinions,
        {
          log: this.log,
          markDirty: () => {
            this.dirty = true;
          },
        },
        dryRun,
      );

      if (!dryRun && toRemove.size > 0) {
        this.opinions = this.opinions.filter((o) => !toRemove.has(o.id));
        this.dirty = true;
        this.save();
      }

      report.total = dryRun ? this.opinions.length : this.opinions.length;

      return report;
    } finally {
      this._reflecting = false;
    }
  }

  healthCheck(): HealthReport {
    return opinionHealthCheck(this.opinions);
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private load(): void {
    const filePath = path.join(this.memoryPath, OPINIONS_FILE);
    if (!fs.existsSync(filePath)) {
      this.opinions = [];
      return;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this.opinions = parseOpinions(content);
      this.log(`[OpinionBank] Loaded ${this.opinions.length} opinions`);
    } catch (err) {
      this.log(`[OpinionBank] Failed to load opinions: ${err}`);
      this.opinions = [];
    }
  }

  private findSimilar(statement: string): Opinion | undefined {
    const words = extractWords(statement);
    if (words.size === 0) return undefined;

    for (const op of this.opinions) {
      const opWords = extractWords(op.statement);
      let overlap = 0;
      for (const w of words) {
        if (opWords.has(w)) overlap++;
      }
      const similarity = overlap / Math.min(words.size, opWords.size);
      if (similarity >= 0.6) return op;
    }

    return undefined;
  }

  private generateId(): string {
    const rand = Math.random().toString(36).substring(2, 8);
    return `op_${rand}`;
  }

  private pruneIfNeeded(): void {
    if (this.opinions.length <= MAX_OPINIONS) return;

    this.opinions.sort((a, b) => b.confidence - a.confidence);
    const pruned = this.opinions.length - MAX_OPINIONS;
    this.opinions = this.opinions.slice(0, MAX_OPINIONS);
    this.log(`[OpinionBank] Pruned ${pruned} low-confidence opinions`);
  }
}
