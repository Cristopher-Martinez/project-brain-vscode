/**
 * Auto-Capture — Extract learnings from sessions automatically.
 *
 * Inspired by OpenClaw's "Retain" phase: learns from REAL experience,
 * not synthetic datasets. Captures patterns from actual LLM responses
 * and lets confidence evolve via reinforcement/contradiction.
 *
 * Quality control via:
 * - 12 selective regex patterns (error resolution, decisions, learnings)
 * - OpinionBank dedup (>60% word overlap)
 * - Confidence evolution (reinforced when useful, contradicted when wrong)
 *
 * Split into:
 * - capture-patterns.ts  — Pattern definitions + safety validation
 * - learning-router.ts   — Secondary persistence (04_LEARNINGS.md etc.)
 * - auto-capture.ts      — This file: AutoCapture class (orchestrator)
 */

import { appendToDiary } from "./agent-diary";
import {
  CAPTURE_PATTERNS,
  cleanStatement,
  isCaptureSafe,
  MAX_CAPTURES_PER_HOUR,
} from "./capture-patterns";
import { LearningRouter } from "./learning-router";
import { OpinionBank } from "./opinion-bank";
import type { ReflectionValidator } from "./reflection-validator";

// ─── Re-exports for backward compatibility ──────────────────────────────────

export { LearningRouter } from "./learning-router";

// ─── AutoCapture ────────────────────────────────────────────────────────────

export class AutoCapture {
  private pendingTexts: { text: string; source: string }[] = [];
  /** SECURITY (HIGH-07): Rate limit tracking — timestamps of captures this hour */
  private captureTimestamps: number[] = [];
  /** Optional secondary persistence via LearningRouter */
  private learningRouter: LearningRouter | null = null;
  private globalKnowledge:
    | import("./global-knowledge").GlobalKnowledgeManager
    | null = null;
  /** Optional BERT quality gate for captured opinions */
  private validator: ReflectionValidator | null = null;
  /** Agent diary: path + current mode for per-agent learning persistence */
  private diaryMemoryPath: string | null = null;
  private diaryCurrentMode: string | null = null;

  constructor(
    private opinionBank: OpinionBank,
    private log: (msg: string) => void,
  ) {}

  /** Configure diary persistence for agent-specific learnings. */
  setDiaryConfig(memoryPath: string): void {
    this.diaryMemoryPath = memoryPath;
  }

  /** Set current agent mode (e.g. "reviewer", "planner"). */
  setCurrentAgentMode(mode: string | null): void {
    this.diaryCurrentMode = mode;
  }

  /** Inject GlobalKnowledgeManager for cross-project learning propagation. */
  setGlobalKnowledge(
    gk: import("./global-knowledge").GlobalKnowledgeManager,
  ): void {
    this.globalKnowledge = gk;
  }

  /**
   * Attach a LearningRouter for secondary persistence.
   * Called from extension.ts after both AutoCapture and LearningRouter are instantiated.
   */
  setLearningRouter(router: LearningRouter): void {
    this.learningRouter = router;
  }

  /**
   * Attach a ReflectionValidator for BERT-powered quality gating.
   * When attached, captured text is validated before saving.
   * Fail-open: if model unavailable, all captures pass through.
   */
  setValidator(validator: ReflectionValidator): void {
    this.validator = validator;
  }

  /**
   * Scan text for capturable patterns and create opinions.
   * Called after session save or when processing user messages.
   *
   * @returns Number of opinions captured
   */
  async capture(text: string, source?: string): Promise<number> {
    if (!text || text.length < 20) return 0;

    let captured = 0;
    const evidenceSource =
      source || `session-${new Date().toISOString().split("T")[0]}`;

    for (const pattern of CAPTURE_PATTERNS) {
      const matches = text.matchAll(new RegExp(pattern.pattern, "gi"));

      for (const match of matches) {
        const statement = pattern.extract(match, text);
        if (!statement || statement.length < 10) continue;

        const cleaned = cleanStatement(statement);
        if (!cleaned) continue;

        // SECURITY (HIGH-07): Validate content before persisting
        if (!isCaptureSafe(cleaned)) {
          this.log(
            `[AutoCapture] Blocked unsafe opinion: "${cleaned.substring(0, 50)}..."`,
          );
          continue;
        }

        // SECURITY (HIGH-07): Rate limit captures per hour
        if (!this.checkRateLimit()) break;

        // BERT quality gate — skip mechanical/low-quality captures
        if (this.validator) {
          const { isGenuine, score } = await this.validator.validate(cleaned);
          if (!isGenuine) {
            this.log(
              `[AutoCapture] BERT rejected (score=${score.toFixed(3)}): "${cleaned.substring(0, 50)}..."`,
            );
            continue;
          }
        }

        // Direct save — quality via regex selectivity + confidence evolution
        this.opinionBank.addOpinion(
          cleaned,
          pattern.confidence,
          pattern.domain,
          evidenceSource,
        );

        // Secondary persistence (isolated — never breaks primary path)
        this.routeToSecondary(cleaned, pattern.domain, evidenceSource);

        // Promote high-confidence captures to global knowledge mid-session
        this.promoteToGlobal(cleaned, pattern.confidence, evidenceSource);

        captured++;

        // Cap at 5 captures per text to avoid noise
        if (captured >= 5) break;
      }

      if (captured >= 5) break;
    }

    if (captured > 0) {
      this.opinionBank.save();
      this.log(
        `[AutoCapture] Extracted ${captured} opinion(s) from ${evidenceSource}`,
      );

      // Route captured learnings to agent diary if mode is active
      this.routeToDiary(text, evidenceSource);
    }

    return captured;
  }

  /**
   * Buffer text for later flush. Use when you want to capture but defer processing.
   */
  buffer(text: string, source: string): void {
    if (text && text.length >= 20) {
      this.pendingTexts.push({ text, source });
    }
  }

  /**
   * Flush all pending captures + force-save opinion bank.
   * Called before session spawn (OpenClaw pre-compaction flush pattern).
   * Returns total opinions captured during flush.
   */
  async flushPending(): Promise<number> {
    let total = 0;
    const pending = this.pendingTexts.splice(0); // drain buffer
    for (const { text, source } of pending) {
      total += await this.capture(text, source);
    }
    // Force-save opinion bank regardless
    const stats = this.opinionBank.flush();
    this.log(
      `[AutoCapture] Pre-spawn flush: ${total} new captures, ${stats.saved} total opinions saved`,
    );
    return total;
  }

  /**
   * Capture from a session handoff (structured data).
   * Extracts from goals, decisions, and completed items.
   */
  async captureFromSession(sessionData: {
    goals?: string[];
    completed?: string[];
    decisions?: string[];
    pending?: string[];
  }): Promise<number> {
    let total = 0;

    // Decisions are high-value captures (with safety validation)
    if (sessionData.decisions) {
      for (const decision of sessionData.decisions) {
        if (decision.length > 10 && isCaptureSafe(decision)) {
          if (!this.checkRateLimit()) {
            this.log(`[AutoCapture] Rate limit reached during session capture`);
            break;
          }
          this.opinionBank.addOpinion(
            decision,
            0.8,
            "architecture",
            "session-decision",
          );
          total++;
        }
      }
    }

    // Completed goals can become pattern opinions
    if (sessionData.completed) {
      const text = sessionData.completed.join(". ");
      total += await this.capture(text, "session-completed");
    }

    return total;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /** Check and enforce per-hour rate limit. Returns true if under limit. */
  private checkRateLimit(): boolean {
    const now = Date.now();
    this.captureTimestamps = this.captureTimestamps.filter(
      (t) => now - t < 3600_000,
    );
    if (this.captureTimestamps.length >= MAX_CAPTURES_PER_HOUR) {
      this.log(
        `[AutoCapture] Rate limit reached (${MAX_CAPTURES_PER_HOUR}/hour)`,
      );
      return false;
    }
    this.captureTimestamps.push(now);
    return true;
  }

  /** Route to LearningRouter if attached (isolated failure). */
  private routeToSecondary(
    statement: string,
    domain: string,
    source: string,
  ): void {
    if (!this.learningRouter) return;
    try {
      this.learningRouter.routeLearning(
        statement,
        domain as import("./opinion-types").OpinionDomain,
        source,
      );
    } catch {
      /* isolation: never break OpinionBank flow */
    }
  }

  /** Promote high-confidence captures to global knowledge. */
  private promoteToGlobal(
    statement: string,
    confidence: number,
    source: string,
  ): void {
    if (!this.globalKnowledge || confidence < 0.7) return;
    try {
      this.globalKnowledge.addLearning(statement, source);
    } catch {
      /* isolation */
    }
  }

  /** Route captured learning summary to the active agent's diary. */
  private routeToDiary(text: string, source: string): void {
    if (!this.diaryMemoryPath || !this.diaryCurrentMode) return;
    try {
      // Extract a compact title from the first meaningful line
      const firstLine = text.split("\n").find((l) => l.trim().length > 10);
      const title = firstLine
        ? firstLine.trim().substring(0, 80)
        : `Auto-capture from ${source}`;

      appendToDiary(this.diaryMemoryPath, this.diaryCurrentMode, {
        date: new Date().toISOString().split("T")[0],
        title,
        context: `Captured from: ${source}`,
        learning: text.substring(0, 500),
        confidence: "medium",
      });
    } catch {
      /* isolation: never break primary capture path */
    }
  }
}
