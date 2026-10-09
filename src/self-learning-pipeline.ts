/**
 * Self-Learning Pipeline — Orchestrates clone → vectorize → ready.
 *
 * Extracted from SelfLearningManager to keep files under 400 lines.
 * Uses only public methods of the manager.
 *
 * @module self-learning-pipeline
 */

import { logError } from "./logger";
import { slProgress as slStateProgress, slDone, slError as slStateError } from "./self-learning-state";
import type { PipelinePhase } from "./self-learning-types";

// ─── Types ──────────────────────────────────────────────────────────────

type PostMessageFn = (msg: Record<string, unknown>) => void;

/** Dependencies for the pipeline — public surface of SelfLearningManager */
export interface PipelineDeps {
  getRepo(id: number): { status: string; sourceType: string; errorMessage: string | null; name: string } | null;
  retryClone(repoId: number): Promise<void>;
  vectorizeRepo(repoId: number): Promise<{ success: boolean; chunks: number; files: number; error?: string }>;
  getPostMessage(): PostMessageFn | null;
}

// ─── Progress Notification ──────────────────────────────────────────────

export function notifyProgress(
  postMessage: PostMessageFn | null,
  repoId: number,
  phase: PipelinePhase,
  detail: string,
  percent?: number,
  repoName?: string,
): void {
  const name = repoName ?? `repo-${repoId}`;
  // Always push to global state (for TreeView even without webview)
  if (phase === "done") slDone(repoId, name);
  else if (phase === "error") slStateError(repoId, name, detail);
  else slStateProgress({ repoId, name, phase, detail, percent });

  if (!postMessage) return;
  try {
    postMessage({ type: "sl:progress", repoId, phase, detail, percent });
  } catch {
    /* webview may be disposed */
  }
}

// ─── Pipeline Runner ────────────────────────────────────────────────────

/**
 * Run the full pipeline: clone (if needed) → vectorize → notify ready.
 * Analysis is triggered separately by the user after pipeline completes.
 */
export async function runSelfLearningPipeline(
  deps: PipelineDeps,
  repoId: number,
): Promise<void> {
  const repo = deps.getRepo(repoId);
  if (!repo) throw new Error("Repo not found");

  const post = deps.getPostMessage();
  const rName = repo.name;

  try {
    // Phase 1: Clone (only for GitHub repos that need it)
    if (repo.sourceType === "github" && (repo.status === "pending" || repo.status === "error")) {
      const label = repo.status === "error" ? "Retrying clone..." : "Cloning repository...";
      notifyProgress(post, repoId, "cloning", label, undefined, rName);
      await deps.retryClone(repoId);

      const updated = deps.getRepo(repoId);
      if (updated?.status === "error") {
        notifyProgress(post, repoId, "error", updated.errorMessage ?? "Clone failed", undefined, rName);
        return;
      }
    }

    // Phase 2: Vectorize (if not already indexed)
    const afterClone = deps.getRepo(repoId);
    if (!afterClone) return;

    const needsVectorize = afterClone.status === "cloned"
      || afterClone.status === "error"
      || (afterClone.sourceType !== "github" && afterClone.status === "pending");

    if (needsVectorize) {
      notifyProgress(post, repoId, "vectorizing", "Vectorizing with local embeddings...", undefined, rName);
      const result = await deps.vectorizeRepo(repoId);
      if (!result.success) {
        notifyProgress(post, repoId, "error", result.error ?? "Vectorization failed", undefined, rName);
        return;
      }
      notifyProgress(post, repoId, "vectorizing", `Indexed ${result.chunks} chunks from ${result.files} files`, undefined, rName);
    }

    // Phase 3: Signal ready for analysis
    notifyProgress(post, repoId, "done", "Pipeline complete — ready for analysis", undefined, rName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyProgress(post, repoId, "error", msg, undefined, rName);
    logError(`[SelfLearning] Pipeline failed for repo ${repoId}: ${msg}`);
  }
}
