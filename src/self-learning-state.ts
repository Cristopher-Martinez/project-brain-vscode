/**
 * Self-Learning state — global event emitter for TreeView & UI consumption.
 *
 * Mirrors the pattern of `swarm-state.ts`: a singleton state that both
 * `SelfLearningManager` pushes to and `BrainTreeDataProvider` reads from.
 *
 * @module self-learning-state
 */

import * as vscode from "vscode";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SLPhase =
  | "cloning"
  | "vectorizing"
  | "analyzing"
  | "done"
  | "error";

export interface SLRepoProgress {
  repoId: number;
  name: string;
  phase: SLPhase;
  detail: string;
  percent?: number;
  startedAt: number;
  updatedAt: number;
}

export interface SLTreeState {
  /** Active repo operations (keyed by repoId) */
  repos: Map<number, SLRepoProgress>;
  /** Epoch ms of last global update */
  updatedAt: number;
}

// ─── Singleton state ─────────────────────────────────────────────────────────

let state: SLTreeState = {
  repos: new Map(),
  updatedAt: Date.now(),
};

const emitter = new vscode.EventEmitter<SLTreeState>();

/** Subscribe to self-learning state changes (for TreeView, etc.) */
export const onDidChangeSLState = emitter.event;

/** Read current state snapshot */
export function getSLState(): SLTreeState {
  return state;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Report progress on a repo operation */
export function slProgress(opts: {
  repoId: number;
  name: string;
  phase: SLPhase;
  detail: string;
  percent?: number;
}): void {
  const now = Date.now();
  const existing = state.repos.get(opts.repoId);
  const entry: SLRepoProgress = {
    repoId: opts.repoId,
    name: opts.name,
    phase: opts.phase,
    detail: opts.detail,
    percent: opts.percent,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  const repos = new Map(state.repos);
  repos.set(opts.repoId, entry);
  state = { repos, updatedAt: now };
  emitter.fire(state);
}

/** Mark a repo operation as done (auto-clears after delay) */
export function slDone(repoId: number, name: string): void {
  slProgress({ repoId, name, phase: "done", detail: "Complete" });
  setTimeout(() => slClear(repoId), 10_000);
}

/** Mark a repo operation as errored */
export function slError(repoId: number, name: string, detail: string): void {
  slProgress({ repoId, name, phase: "error", detail });
  setTimeout(() => slClear(repoId), 30_000);
}

/** Remove a repo from the progress tracker */
export function slClear(repoId: number): void {
  if (!state.repos.has(repoId)) return;
  const repos = new Map(state.repos);
  repos.delete(repoId);
  state = { repos, updatedAt: Date.now() };
  emitter.fire(state);
}
