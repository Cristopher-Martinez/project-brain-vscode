/**
 * LearningIngester — Extension-side processor for staged learnings.
 *
 * Hooks write raw learnings to `sessions/pending-learnings.jsonl`.
 * This class (CJS, runs in extension host) periodically ingests them
 * into OpinionBank with dedup + safety checks.
 *
 * Architecture:
 *   Hooks (ESM child process) → JSONL staging file → LearningIngester (CJS) → OpinionBank
 *
 * This solves C1 (CJS/ESM barrier): hooks never call OpinionBank directly.
 *
 * @since 2026-02-18
 * @author Jasper 🏴‍☠️
 */

import * as fs from "fs";
import * as path from "path";
import { OpinionBank, OpinionDomain } from "./opinion-bank";
import { sanitizeContent } from "./security-utils";
import type { GlobalKnowledgeManager } from "./global-knowledge";

/** Max entries to process per ingestion cycle */
const MAX_ENTRIES_PER_CYCLE = 50;

/** Min interval between ingestion cycles (ms) */
const INGESTION_INTERVAL_MS = 60_000; // 1 minute

/** Valid learning types from hooks */
const VALID_TYPES = new Set(["learning", "fix", "decision", "insight"]);

/** Map learning types to opinion domains */
const TYPE_TO_DOMAIN: Record<string, OpinionDomain> = {
  learning: "general",
  fix: "debugging",
  decision: "architecture",
  insight: "patterns",
};

interface StagedLearning {
  t: string;
  type: string;
  text: string;
  agentId: string;
  agentType: string;
  verified: boolean;
}

export class LearningIngester {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private globalKnowledge: GlobalKnowledgeManager | null = null;

  constructor(
    private memoryPath: string,
    private opinionBank: OpinionBank,
    private log: (msg: string) => void,
  ) {}

  /** Inject GlobalKnowledgeManager for cross-project learning propagation. */
  setGlobalKnowledge(gk: GlobalKnowledgeManager): void {
    this.globalKnowledge = gk;
  }

  /**
   * Start periodic ingestion of staged learnings.
   */
  start(): void {
    if (this.timer) return;

    // Initial ingestion after 10s delay (let extension fully activate)
    setTimeout(() => this.ingest(), 10_000);

    this.timer = setInterval(() => this.ingest(), INGESTION_INTERVAL_MS);
    this.log("[LearningIngester] Started (interval: 60s)");
  }

  /**
   * Stop the ingester and clean up.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log("[LearningIngester] Stopped");
    }
  }

  /**
   * Process pending-learnings.jsonl → OpinionBank.
   * Idempotent: rename → parse → ingest → cleanup.
   */
  async ingest(): Promise<number> {
    if (this.processing) return 0;
    this.processing = true;

    try {
      const sessionsDir = path.join(this.memoryPath, "sessions");
      const stagingFile = path.join(sessionsDir, "pending-learnings.jsonl");

      if (!fs.existsSync(stagingFile)) {
        return 0;
      }

      const stats = fs.statSync(stagingFile);
      if (stats.size === 0) return 0;

      // Atomic claim
      const processingFile = stagingFile + ".ingesting";
      try {
        fs.renameSync(stagingFile, processingFile);
      } catch {
        // Another process is handling it
        return 0;
      }

      const raw = fs.readFileSync(processingFile, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      let ingested = 0;
      const seen = new Set<string>();
      const accepted: string[] = []; // Track accepted sanitized texts for global forwarding

      for (const line of lines.slice(0, MAX_ENTRIES_PER_CYCLE)) {
        try {
          const entry: StagedLearning = JSON.parse(line);

          // Validate
          if (!entry.text || typeof entry.text !== "string") continue;
          if (entry.text.length < 10 || entry.text.length > 500) continue;
          if (!VALID_TYPES.has(entry.type || "")) continue;

          // Dedup within this batch
          const normalized = entry.text.toLowerCase().trim();
          if (seen.has(normalized)) continue;
          seen.add(normalized);

          // Security: sanitize before persisting
          const sanitized = sanitizeContent(entry.text);
          if (sanitized.includes("[FILTERED]")) {
            this.log(
              `[LearningIngester] Rejected injection attempt: "${sanitized.slice(0, 50)}..."`,
            );
            continue;
          }

          // addOpinion already deduplicates internally via findSimilar + reinforce
          const domain: OpinionDomain = TYPE_TO_DOMAIN[entry.type] || "general";
          this.opinionBank.addOpinion(
            sanitized,
            0.5, // Lower confidence for auto-captured from hooks
            domain,
            `subagent-${entry.agentId || "unknown"}`,
          );

          accepted.push(sanitized);
          ingested++;
        } catch {
          // Skip malformed lines
          continue;
        }
      }

      // Save if we ingested anything
      if (ingested > 0) {
        this.opinionBank.save();
        this.log(
          `[LearningIngester] Ingested ${ingested} learnings from staging`,
        );

        // Forward accepted entries to global knowledge for cross-project inheritance
        if (this.globalKnowledge) {
          const projectSource = path.basename(this.memoryPath);
          for (const text of accepted) {
            try {
              this.globalKnowledge.addLearning(text, projectSource);
            } catch { /* isolation: never break main flow */ }
          }
        }
      }

      // Cleanup
      try {
        // If there were lines beyond MAX_ENTRIES_PER_CYCLE, write them back
        if (lines.length > MAX_ENTRIES_PER_CYCLE) {
          const remaining =
            lines.slice(MAX_ENTRIES_PER_CYCLE).join("\n") + "\n";
          fs.writeFileSync(stagingFile, remaining, "utf8");
          this.log(
            `[LearningIngester] ${lines.length - MAX_ENTRIES_PER_CYCLE} entries deferred to next cycle`,
          );
        }
        fs.unlinkSync(processingFile);
      } catch {
        /* skip cleanup failure */
      }

      return ingested;
    } catch (err) {
      this.log(`[LearningIngester] Error: ${(err as Error).message}`);
      return 0;
    } finally {
      this.processing = false;
    }
  }

  /**
   * Dispose — stop ingester and do final flush.
   */
  dispose(): void {
    this.stop();
  }
}
