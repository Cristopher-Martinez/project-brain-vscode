/**
 * T6.1 — Model Telemetry Layer: Correction Cycle Detection
 *
 * A correction cycle is recorded if:
 * 1. A later commit REDUCES: survived, criticalSurvivors, or structuralViolations
 * 2. It modifies files touched by the cohort
 * 3. It occurs before the next cohort closes
 *
 * Human commits CAN count as corrections.
 */

import type {
  ModelCohort,
  ModelCommit,
  CorrectionCycle,
  CorrectionMetricDelta,
  T61Deps,
} from "./test-gate-t61-types";
import { insertCorrection } from "./test-gate-t61-storage";
import { getCommitsByModel } from "./test-gate-t61-storage";

// ─── Correction Detection ───────────────────────────────────────────

/** Mutation/structural metrics at a point in time for comparison. */
export interface MetricSnapshot {
  survived: number;
  criticalSurvivors: number;
  structuralViolations: number;
}

/**
 * Detect if a commit constitutes a correction cycle for a cohort.
 *
 * Conditions (ALL must be true):
 * 1. The commit reduces at least one metric (survived, criticalSurvivors, structuralViolations)
 * 2. The commit modifies files touched by the cohort
 * 3. The cohort is still open (not closed)
 *
 * @returns CorrectionCycle if detected, null otherwise
 */
export function detectCorrectionCycle(
  deps: T61Deps,
  commit: ModelCommit,
  cohort: ModelCohort,
  beforeMetrics: MetricSnapshot,
  afterMetrics: MetricSnapshot,
  cohortFiles: Set<string>,
): CorrectionCycle | null {
  // Condition 3: cohort must be open
  if (cohort.closed) {
    return null;
  }

  // Condition 2: commit must modify files touched by the cohort
  const overlappingFiles = commit.filesModified.filter((f) =>
    cohortFiles.has(f),
  );
  if (overlappingFiles.length === 0) {
    return null;
  }

  // Condition 1: at least one metric must be reduced
  const deltas = detectMetricReductions(beforeMetrics, afterMetrics);
  if (deltas.length === 0) {
    return null;
  }

  const correction: CorrectionCycle = {
    correctorCommitHash: commit.commitHash,
    correctorModelId: commit.modelId,
    targetCohortModelId: cohort.modelId,
    targetCohortIndex: cohort.cohortIndex,
    reducedMetrics: deltas,
    timestamp: commit.timestamp,
  };

  insertCorrection(deps, correction);
  deps.log(
    `[T6.1-Corrections] Detected correction: ${commit.commitHash} → ` +
      `${cohort.modelId}#${cohort.cohortIndex} (${deltas.map((d) => d.metric).join(", ")})`,
  );

  return correction;
}

/**
 * Detect which metrics were reduced between two snapshots.
 */
export function detectMetricReductions(
  before: MetricSnapshot,
  after: MetricSnapshot,
): CorrectionMetricDelta[] {
  const deltas: CorrectionMetricDelta[] = [];

  if (after.survived < before.survived) {
    deltas.push({
      metric: "survived",
      before: before.survived,
      after: after.survived,
    });
  }

  if (after.criticalSurvivors < before.criticalSurvivors) {
    deltas.push({
      metric: "criticalSurvivors",
      before: before.criticalSurvivors,
      after: after.criticalSurvivors,
    });
  }

  if (after.structuralViolations < before.structuralViolations) {
    deltas.push({
      metric: "structuralViolations",
      before: before.structuralViolations,
      after: after.structuralViolations,
    });
  }

  return deltas;
}

/**
 * Get all files touched by commits in a cohort.
 * Used to check overlap condition for corrections.
 */
export function getCohortFiles(
  deps: T61Deps,
  cohort: ModelCohort,
): Set<string> {
  const files = new Set<string>();
  const commits = getCommitsByModel(deps, cohort.modelId);

  for (const commit of commits) {
    if (cohort.commits.includes(commit.commitHash)) {
      for (const f of commit.filesModified) {
        files.add(f);
      }
    }
  }

  return files;
}
