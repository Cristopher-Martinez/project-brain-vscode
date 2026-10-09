// ─── Neuroplasticity Layer Initialization (extracted from extension.ts) ──────
// Responsibility: OpinionBank, AutoCapture, AutoRecall, SessionDB, LearningRouter,
// LearningIngester, periodic flush/reflect timers
import * as vscode from "vscode";
import { AutoCapture, LearningRouter } from "./auto-capture";
import { AutoRecall } from "./auto-recall";
import { LearningIngester } from "./learning-ingester";
import { OpinionBank } from "./opinion-bank";
import { SessionDB } from "./session-db";
import type { AdminDB } from "./admin-db";
import type { SkillManager } from "./skill-manager";

export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
export const REFLECT_INTERVAL_MS = 30 * 60 * 1000;

export interface NeuroInitOpts {
  memoryPath: string;
  log: (msg: string) => void;
  getSkillManager: () => SkillManager | null;
  getAdminDb: () => AdminDB | null;
  getSessionDb: () => SessionDB | null;
}

export interface NeuroInitResult {
  opinionBank: OpinionBank;
  autoCapture: AutoCapture;
  autoRecall: AutoRecall;
  learningIngester: LearningIngester;
  sessionDb: SessionDB | null;
  flushInterval: ReturnType<typeof setInterval>;
  reflectInterval: ReturnType<typeof setInterval>;
}

/** Initialize the neuroplasticity layer (opinions, auto-capture, auto-recall) */
export function initializeNeuroplasticity(
  opts: NeuroInitOpts,
): NeuroInitResult {
  const { memoryPath, log } = opts;

  const opinionBank = new OpinionBank(memoryPath, log);
  const autoCapture = new AutoCapture(opinionBank, log);
  const autoRecall = new AutoRecall(memoryPath, opinionBank, log);
  autoRecall.setSkillManagerRef({ get: opts.getSkillManager });
  autoRecall.setAdminDbRef({ get: opts.getAdminDb });
  autoRecall.setSessionDbRef({ get: opts.getSessionDb });

  // LearningRouter + LearningIngester
  const learningRouter = new LearningRouter(memoryPath, log);
  autoCapture.setLearningRouter(learningRouter);
  learningRouter.generateKnowledgeSummary();
  const learningIngester = new LearningIngester(memoryPath, opinionBank, log);
  learningIngester.start();

  log(
    "[Brain] Neuroplasticity layer initialized (opinions + capture + recall)",
  );

  // Periodic flush: every 5 min, drain pending captures + save opinions
  const flushInterval = setInterval(async () => {
    try {
      const flushed = await autoCapture.flushPending();
      if (flushed > 0)
        log(`[Flush] Periodic: ${flushed} pending captures drained`);
    } catch (e) {
      log(`[Flush] Periodic flush error: ${e}`);
    }
    // Reconcile fallback .md files back to SQLite
    const sdb = opts.getSessionDb();
    if (sdb) {
      try {
        const recovered = await sdb.reconcile();
        if (recovered > 0) {
          log(
            `[SessionDB] Reconciled ${recovered} fallback .md files into SQLite`,
          );
        }
      } catch (e) {
        log(`[SessionDB] Reconcile error (non-fatal): ${e}`);
      }
    }
  }, FLUSH_INTERVAL_MS);

  // Periodic reflect: every 30 min, opinion maintenance
  const reflectInterval = setInterval(() => {
    try {
      if (opinionBank.count > 0) {
        const report = opinionBank.reflect();
        if (
          report.pruned.length > 0 ||
          report.merged.length > 0 ||
          report.testArtifacts.length > 0
        ) {
          log(
            `[Reflect] Auto-maintenance: ${report.pruned.length} pruned, ` +
              `${report.merged.length} merged, ${report.testArtifacts.length} test artifacts, ` +
              `${report.total} remaining`,
          );
        }
      }
    } catch (e) {
      log(`[Reflect] Auto-maintenance error: ${e}`);
    }
  }, REFLECT_INTERVAL_MS);

  return {
    opinionBank,
    autoCapture,
    autoRecall,
    learningIngester,
    sessionDb: null, // Set by SessionDB init (async, separate)
    flushInterval,
    reflectInterval,
  };
}

/** Initialize SessionDB with retry logic (WASM can fail) */
export async function initializeSessionDB(opts: {
  memoryPath: string;
  log: (msg: string) => void;
}): Promise<SessionDB | null> {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sdb = new SessionDB(opts.memoryPath, opts.log);
      await sdb.init();
      const imported = await sdb.importFromMarkdown();
      if (imported > 0) {
        opts.log(
          `[SessionDB] Migrated ${imported} summary files from .md to SQLite`,
        );
      }
      opts.log(
        `[SessionDB] Initialized${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`,
      );
      return sdb;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        opts.log(
          `[SessionDB] Init attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms: ${e}`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        opts.log(
          `[SessionDB] Init failed after ${MAX_RETRIES + 1} attempts (non-fatal): ${e}`,
        );
      }
    }
  }
  return null;
}
