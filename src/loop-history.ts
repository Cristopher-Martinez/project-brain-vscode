/**
 * Loop History — Per-loop iteration history persisted to `.project-brain/loops/{sessionId}/history.json`.
 *
 * Records every iteration's prompt, synthesis, feedback, and timestamps.
 * Append-only during loop execution. Survives extension restarts.
 * Used for post-loop analysis, debugging, and session continuity.
 *
 * @module loop-history
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLoopDir as _getLoopDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";

// ——— Constants ———————————————————————————————————————————

const HISTORY_FILENAME = "history.json";

// ——— Types ———————————————————————————————————————————————
/** A single recorded iteration in the history. */
export interface HistoryIteration {
  /** 1-based iteration index. */
  index: number;
  /** Prompt/instruction sent to the agent. */
  prompt: string;
  /** Agent's synthesis response. */
  synthesis?: string;
  /** User's feedback for this iteration. */
  feedback?: string;
  /** Number of images attached in feedback. */
  imageCount?: number;
  /** When the iteration started (ISO timestamp). */
  startedAt: string;
  /** When the iteration completed (ISO timestamp). */
  completedAt?: string;
}

/** Root structure of history.json. */
export interface LoopHistory {
  /** Session identifier. */
  sessionId: string;
  /** The loop's goal. */
  goal: string;
  /** All recorded iterations in order. */
  iterations: HistoryIteration[];
  /** Total number of recorded iterations. */
  totalIterations: number;
  /** When the loop started (ISO timestamp). */
  startedAt: string;
  /** Last time the history was updated (ISO timestamp). */
  lastUpdatedAt: string;
}

// ——— Path helpers ————————————————————————————————————————
function getRepoRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function getHistoryPath(sessionId: string, repoRoot?: string): string | null {
  const root = repoRoot ?? getRepoRoot();
  if (!root) return null;
  return path.join(_getLoopDir(root, sessionId), HISTORY_FILENAME);
}

// ——— Initialize ——————————————————————————————————————————
/**
 * Create an empty history file for a new loop.
 * Idempotent: if history already exists, returns existing.
 */
export function initLoopHistory(
  sessionId: string,
  goal: string,
  repoRoot?: string,
): LoopHistory | null {
  const histPath = getHistoryPath(sessionId, repoRoot);
  if (!histPath) {
    logWarn("[LoopHistory] No workspace root — cannot init history");
    return null;
  }

  // Idempotent
  if (fs.existsSync(histPath)) {
    const existing = readLoopHistory(sessionId, repoRoot);
    if (existing) return existing;
  }

  const dir = path.dirname(histPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const history: LoopHistory = {
      sessionId,
      goal,
      iterations: [],
      totalIterations: 0,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(histPath, JSON.stringify(history, null, 2), "utf-8");
    log(
      `[LoopHistory] Initialized history for session ${sessionId.substring(0, 8)}`,
    );
    return history;
  } catch (err) {
    logError(`[LoopHistory] Failed to init history: ${err}`);
    return null;
  }
}

// ——— Append ——————————————————————————————————————————————
/**
 * Append a completed iteration to the history file.
 * Creates the history file if it doesn't exist (defensive).
 */
export function appendIteration(
  sessionId: string,
  iteration: HistoryIteration,
  repoRoot?: string,
): void {
  const histPath = getHistoryPath(sessionId, repoRoot);
  if (!histPath) return;

  try {
    let history: LoopHistory;

    if (fs.existsSync(histPath)) {
      const raw = fs.readFileSync(histPath, "utf-8");
      history = JSON.parse(raw) as LoopHistory;
    } else {
      // Defensive: create if missing
      const dir = path.dirname(histPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      history = {
        sessionId,
        goal: "",
        iterations: [],
        totalIterations: 0,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    history.iterations.push(iteration);
    history.totalIterations = history.iterations.length;
    history.lastUpdatedAt = new Date().toISOString();

    fs.writeFileSync(histPath, JSON.stringify(history, null, 2), "utf-8");
    log(
      `[LoopHistory] Appended iteration ${iteration.index} for session ${sessionId.substring(0, 8)}`,
    );
  } catch (err) {
    logError(`[LoopHistory] Failed to append iteration: ${err}`);
  }
}

// ——— Read ————————————————————————————————————————————————
/**
 * Read the full history for a session.
 * Returns null if no history exists.
 */
export function readLoopHistory(
  sessionId: string,
  repoRoot?: string,
): LoopHistory | null {
  const histPath = getHistoryPath(sessionId, repoRoot);
  if (!histPath || !fs.existsSync(histPath)) return null;

  try {
    const raw = fs.readFileSync(histPath, "utf-8");
    return JSON.parse(raw) as LoopHistory;
  } catch (err) {
    logError(`[LoopHistory] Failed to read history: ${err}`);
    return null;
  }
}

/**
 * Get the number of completed iterations from history file.
 * Returns 0 if no history exists.
 */
export function getHistoryIterationCount(
  sessionId: string,
  repoRoot?: string,
): number {
  const history = readLoopHistory(sessionId, repoRoot);
  return history?.totalIterations ?? 0;
}

// ——— Update feedback ————————————————————————————————————
/**
 * Update the last iteration in history with user feedback.
 * Called when feedback arrives after the iteration was already completed.
 */
export function updateLastIterationFeedback(
  sessionId: string,
  feedback: string,
  imageCount?: number,
  repoRoot?: string,
): void {
  const histPath = getHistoryPath(sessionId, repoRoot);
  if (!histPath || !fs.existsSync(histPath)) return;

  try {
    const raw = fs.readFileSync(histPath, "utf-8");
    const history = JSON.parse(raw) as LoopHistory;

    if (history.iterations.length === 0) return;

    const last = history.iterations[history.iterations.length - 1];
    last.feedback = feedback;
    if (imageCount !== undefined) last.imageCount = imageCount;
    history.lastUpdatedAt = new Date().toISOString();

    fs.writeFileSync(histPath, JSON.stringify(history, null, 2), "utf-8");
    log(
      `[LoopHistory] Updated feedback on iteration ${last.index} for session ${sessionId.substring(0, 8)}`,
    );
  } catch (err) {
    logError(`[LoopHistory] Failed to update feedback: ${err}`);
  }
}
