/**
 * bridge-loop-state-resolver — Resolves the worker loop state for Bridge UI.
 *
 * Maps loop-engine internals to a simplified view state for the webview.
 */

import * as vscode from "vscode";
import { getAllLoopStates, getLoopState, loopHasPendingFeedback } from "./loop-engine";
import { readLoopConfig } from "./loop-config";

export type WorkerLoopViewState = "active" | "awaiting" | "completed" | "error" | "disconnected";

function getRepoRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve all loop IDs linked to a bridge loop, including reconnect children.
 */
export function resolveBridgeLinkedLoopIds(loopSessionId: string): string[] {
  const repoRoot = getRepoRoot();
  const linked = new Set<string>([loopSessionId]);

  const currentCfg = readLoopConfig(loopSessionId, repoRoot);
  if (currentCfg?.sourceSessionId) {
    linked.add(currentCfg.sourceSessionId);
  }

  const loopStates = getAllLoopStates();
  for (const [candidateId] of loopStates) {
    const cfg = readLoopConfig(candidateId, repoRoot);
    if (!cfg?.sourceSessionId) {
      continue;
    }
    if (linked.has(cfg.sourceSessionId) || cfg.sourceSessionId === loopSessionId) {
      linked.add(candidateId);
    }
  }

  return Array.from(linked);
}

/**
 * Pick the active pending-feedback loop for a bridge, if any.
 */
export function resolveFeedbackTargetLoopSessionId(
  bridgeLoopSessionId: string,
): string | null {
  const linkedIds = resolveBridgeLinkedLoopIds(bridgeLoopSessionId);
  for (const loopId of linkedIds) {
    if (loopHasPendingFeedback(loopId)) {
      return loopId;
    }
  }
  return null;
}

/**
 * Resolve the current state of a worker loop for bridge display.
 * - "awaiting" = loop is waiting for user feedback (dispatch enabled)
 * - "active" = loop agent is currently processing
 * - "completed" = loop finished
 * - "disconnected" = loop not found or not running
 */
export function resolveWorkerLoopState(loopSessionId: string): WorkerLoopViewState {
  const linkedIds = resolveBridgeLinkedLoopIds(loopSessionId);

  for (const loopId of linkedIds) {
    if (loopHasPendingFeedback(loopId)) {
      return "awaiting";
    }
  }

  const states = linkedIds
    .map((loopId) => getLoopState(loopId))
    .filter((state) => !!state.sessionId);

  if (states.some((state) => state.state === "active" || state.state === "spawning" || state.state === "awaiting")) {
    return "active";
  }
  if (states.some((state) => state.state === "completed")) {
    return "completed";
  }
  if (states.some((state) => state.state === "disconnected")) {
    return "disconnected";
  }
  return "disconnected";
}
