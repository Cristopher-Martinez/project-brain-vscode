/**
 * T6.1 — Model Telemetry Layer: Commit Attribution & Change Weight
 *
 * Handles:
 * - Commit attribution to LLM models (or "human")
 * - Change Weight (CW) impact metric calculation
 *
 * CW = linesAdded + linesRemoved + totalMutants + structuralViolations
 * All components have equal weight. No exponential scaling.
 */

import type {
  ModelCommit,
  ChangeWeightInput,
  T61Deps,
} from "./test-gate-t61-types";
import { insertCommit, getCommit } from "./test-gate-t61-storage";

// ─── Attribution ────────────────────────────────────────────────────

/**
 * Attribute a commit to a model. If no modelId, defaults to "human".
 * Commits without modelId are stored but do NOT accumulate cohort weight.
 *
 * @returns true if the commit was new, false if already existed
 */
export function attributeCommit(
  deps: T61Deps,
  commit: Omit<ModelCommit, "modelId"> & { modelId?: string },
): boolean {
  const existing = getCommit(deps, commit.commitHash);
  if (existing) {
    deps.log(`[T6.1-Attribution] Commit ${commit.commitHash} already attributed`);
    return false;
  }

  const attributed: ModelCommit = {
    ...commit,
    modelId: commit.modelId || "human",
  };

  insertCommit(deps, attributed);
  deps.log(
    `[T6.1-Attribution] Attributed ${attributed.commitHash} → ${attributed.modelId}`,
  );
  return true;
}

/**
 * Batch-attribute multiple commits.
 * @returns number of new commits attributed
 */
export function attributeCommits(
  deps: T61Deps,
  commits: Array<Omit<ModelCommit, "modelId"> & { modelId?: string }>,
): number {
  let count = 0;
  for (const commit of commits) {
    if (attributeCommit(deps, commit)) {
      count++;
    }
  }
  deps.log(`[T6.1-Attribution] Batch: ${count}/${commits.length} new`);
  return count;
}

// ─── Change Weight ──────────────────────────────────────────────────

/**
 * Calculate Change Weight (CW) for a commit.
 *
 * CW = linesAdded + linesRemoved + totalMutants + structuralViolations
 *
 * All components have equal weight. No exponential scaling.
 * No special weighting for core files.
 */
export function calculateChangeWeight(input: ChangeWeightInput): number {
  return (
    input.linesAdded +
    input.linesRemoved +
    input.totalMutants +
    input.structuralViolations
  );
}

/**
 * Calculate CW from a ModelCommit + mutation/structural data.
 * Convenience wrapper that combines commit stats with mutation data.
 */
export function calculateCommitWeight(
  commit: ModelCommit,
  totalMutants: number,
  structuralViolations: number,
): number {
  return calculateChangeWeight({
    linesAdded: commit.linesAdded,
    linesRemoved: commit.linesRemoved,
    totalMutants,
    structuralViolations,
  });
}

/**
 * Check if a commit should accumulate cohort weight.
 * Human commits do NOT accumulate weight per spec.
 */
export function shouldAccumulateWeight(modelId: string): boolean {
  return modelId !== "human";
}
