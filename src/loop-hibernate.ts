/**
 * Loop Hibernate — STRAT-9
 *
 * Persist a loop session to disk so the user can close VS Code and
 * resume the loop another day. The git branch + worktree survive
 * process death — we just need to save the loop metadata.
 *
 * Hibernate = snapshot loop state → write JSON → signal agent to exit
 * Resume   = read JSON → restore state to memory → agent re-connects
 *
 * Storage: `.project-brain/loops/hibernated/{sessionId}.json`
 */

import * as fs from "fs";
import * as path from "path";
import { getHibernatedDir } from "./brain-paths";
import { getIsolationInfo } from "./fork-queries";
import { log, logError, logWarn } from "./logger";
import type { LoopIteration, LoopUiState } from "./loop-engine";
import {
  cleanupLoopSessionMemory,
  getLoopState,
  loopSendFeedback,
  loopStart,
  setLoopSessionOpen,
} from "./loop-engine";
import { removeActiveLoopSignal } from "./loop-signal";
import { buildTranscriptSummary } from "./vscode-chat-reader";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HibernatedLoop {
  sessionId: string;
  goal: string;
  iterations: LoopIteration[];
  currentRound: number;
  lastSynthesis?: string;
  branchName?: string;
  forkPath?: string;
  originalBranch?: string;
  hibernatedAt: number;
  repoRoot: string;
  /** Summary of what was being worked on (for display). */
  summary: string;
  /** User-configured max iterations. */
  maxCycles?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Hibernation dir resolved via brain-paths (supports legacy fallback).
/** Hibernated loops older than 30 days are auto-pruned. */
const HIBERNATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Persistence ────────────────────────────────────────────────────────────

function hibernateDir(repoRoot: string): string {
  return getHibernatedDir(repoRoot);
}

function hibernatePath(repoRoot: string, sessionId: string): string {
  return path.join(hibernateDir(repoRoot), `${sessionId}.json`);
}

// ─── Hibernate ──────────────────────────────────────────────────────────────

/**
 * Hibernate a loop session: snapshot state → write to disk → signal agent.
 * The branch and worktree are NOT deleted — they hold the work-in-progress.
 */
export function hibernateLoop(
  repoRoot: string,
  sessionId: string,
): HibernatedLoop | null {
  const state = getLoopState(sessionId);
  if (!state || state.state === "idle" || state.state === "completed") {
    logWarn(
      `[Hibernate] Cannot hibernate session ${sessionId.substring(0, 8)} — not active (state: ${state?.state ?? "none"})`,
    );
    return null;
  }

  const isolation = getIsolationInfo(sessionId);
  const lastIteration = state.iterations[state.iterations.length - 1];
  const summary = buildSummary(state, lastIteration, sessionId);

  const snapshot: HibernatedLoop = {
    sessionId,
    goal: state.goal || "Unknown goal",
    iterations: state.iterations,
    currentRound: state.iterations.length,
    lastSynthesis: state.pendingSynthesis ?? lastIteration?.synthesis,
    branchName: isolation?.branchName,
    forkPath: isolation?.forkPath,
    originalBranch: isolation?.originalBranch,
    hibernatedAt: Date.now(),
    repoRoot,
    summary,
    maxCycles: state.maxCycles,
  };

  // Write to hibernation storage
  try {
    fs.mkdirSync(hibernateDir(repoRoot), { recursive: true });
    fs.writeFileSync(
      hibernatePath(repoRoot, sessionId),
      JSON.stringify(snapshot, null, 2),
      "utf-8",
    );
  } catch (err) {
    logError(`[Hibernate] Failed to persist: ${err}`);
    return null;
  }

  // Signal the agent to exit cleanly
  loopSendFeedback(sessionId, "__HIBERNATED__");
  removeActiveLoopSignal(sessionId);

  // Remove from active loops in webview (fires loopEmitter → webview updates)
  cleanupLoopSessionMemory(sessionId);

  log(
    `[Hibernate] 💤 Session ${sessionId.substring(0, 8)} hibernated ` +
      `(${state.iterations.length} iterations, branch: ${isolation?.branchName ?? "none"})`,
  );

  return snapshot;
}

// ─── Resume ─────────────────────────────────────────────────────────────────

/**
 * Resume a hibernated loop: read from disk → restore state to memory.
 * Returns the snapshot so the caller can launch a new chat with context.
 */
export async function resumeHibernatedLoop(
  repoRoot: string,
  sessionId: string,
): Promise<HibernatedLoop | null> {
  const fp = hibernatePath(repoRoot, sessionId);
  if (!fs.existsSync(fp)) {
    logWarn(
      `[Hibernate] No hibernated session found: ${sessionId.substring(0, 8)}`,
    );
    return null;
  }

  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const snapshot = JSON.parse(raw) as HibernatedLoop;

    // Restore loop state in memory
    await loopStart(sessionId, snapshot.goal);
    setLoopSessionOpen(sessionId, true);

    // Remove the hibernation file (no longer hibernated)
    fs.unlinkSync(fp);

    log(
      `[Hibernate] ☀️ Session ${sessionId.substring(0, 8)} resumed ` +
        `(${snapshot.currentRound} iterations, hibernated ${formatAge(snapshot.hibernatedAt)})`,
    );

    return snapshot;
  } catch (err) {
    logError(`[Hibernate] Failed to resume: ${err}`);
    return null;
  }
}

// ─── Listing ────────────────────────────────────────────────────────────────

/**
 * List all hibernated loops for a repository.
 */
export function listHibernatedLoops(repoRoot: string): HibernatedLoop[] {
  const dir = hibernateDir(repoRoot);
  if (!fs.existsSync(dir)) return [];

  const results: HibernatedLoop[] = [];
  const now = Date.now();

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const snapshot = JSON.parse(raw) as HibernatedLoop;

        // Auto-prune old hibernated sessions
        if (now - snapshot.hibernatedAt > HIBERNATE_TTL_MS) {
          fs.unlinkSync(path.join(dir, file));
          log(
            `[Hibernate] Pruned old session: ${snapshot.sessionId.substring(0, 8)} (${formatAge(snapshot.hibernatedAt)})`,
          );
          continue;
        }

        results.push(snapshot);
      } catch {
        /* skip malformed files */
      }
    }
  } catch (err) {
    logWarn(`[Hibernate] Failed to list: ${err}`);
  }

  return results.sort((a, b) => b.hibernatedAt - a.hibernatedAt);
}

/**
 * Delete a specific hibernated loop (and optionally its branch).
 */
export function deleteHibernatedLoop(
  repoRoot: string,
  sessionId: string,
): boolean {
  const fp = hibernatePath(repoRoot, sessionId);
  if (!fs.existsSync(fp)) return false;

  try {
    fs.unlinkSync(fp);
    log(`[Hibernate] Deleted hibernated session: ${sessionId.substring(0, 8)}`);
    return true;
  } catch (err) {
    logError(`[Hibernate] Failed to delete: ${err}`);
    return false;
  }
}

// ─── Format ─────────────────────────────────────────────────────────────────

/**
 * Format a hibernated session into a context prompt for the agent.
 * This is injected when the agent re-connects via `loop` tool.
 */
export function formatResumeContext(snapshot: HibernatedLoop): string {
  const age = formatAge(snapshot.hibernatedAt);
  const lastIter = snapshot.iterations[snapshot.iterations.length - 1];

  const parts = [
    `## ☀️ FAST RESUME — Sesión restaurada (hibernada hace ${age})`,
    "",
    `**Objetivo original:** ${snapshot.goal}`,
    `**Iteraciones completadas:** ${snapshot.currentRound}`,
    `**Branch:** ${snapshot.branchName ?? "(sin branch)"}`,
    "",
  ];

  // AI-first transcript context (structured for LLM consumption)
  if (snapshot.summary && snapshot.summary.length > 80) {
    parts.push("### Contexto de sesión anterior:");
    parts.push(snapshot.summary.substring(0, 2000));
    parts.push("");
  }

  if (snapshot.lastSynthesis) {
    parts.push("### Última síntesis antes de hibernar:");
    parts.push(snapshot.lastSynthesis.substring(0, 1000));
    parts.push("");
  }

  if (lastIter?.feedback) {
    parts.push("### Último feedback del usuario:");
    parts.push(lastIter.feedback.substring(0, 500));
    parts.push("");
  }

  parts.push(
    "---",
    "⚡ **FAST RESUME** — Tu contexto está completo arriba.",
    "NO necesitas buscar en memoria ni re-leer archivos.",
    "Ve DIRECTO a procesar y llama `loopAwaitInput` con tu plan de acción.",
  );

  return parts.join("\n");
}

// ─── Internal ───────────────────────────────────────────────────────────────

function buildSummary(
  state: LoopUiState,
  lastIter?: LoopIteration,
  sessionId?: string,
): string {
  // Try rich summary from VS Code chat transcript first
  if (sessionId) {
    try {
      const richSummary = buildTranscriptSummary(sessionId);
      if (richSummary) {
        log(`[Hibernate] Rich summary extracted from chat transcript`);
        return richSummary;
      }
    } catch {
      /* fall through to basic summary */
    }
  }

  // Fallback: basic summary from loop state
  const goal = state.goal || "Unknown";
  const rounds = state.iterations.length;
  const lastPrompt = lastIter?.prompt?.substring(0, 100) || "";
  return `Goal: ${goal} | ${rounds} rounds | Last: ${lastPrompt}`;
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "menos de 1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
