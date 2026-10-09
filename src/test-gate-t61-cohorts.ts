/**
 * T6.1 — Model Telemetry Layer: Dynamic Cohort Aggregation
 *
 * Each model maintains ONE active cohort.
 * Cohort closes when: accumulatedWeight >= COHORT_THRESHOLD
 * Where: COHORT_THRESHOLD = max(300, avgWeightLast20 * 5, medianWeightLast20 * 5)
 * If insufficient history: COHORT_THRESHOLD = 300
 *
 * HARDENING: Median protects against outlier anchoring.
 * Closed cohorts are immutable — never recalculated.
 */

import type {
  ModelCohort,
  CohortThreshold,
  T61Deps,
  T61Config,
} from "./test-gate-t61-types";
import { DEFAULT_T61_CONFIG } from "./test-gate-t61-types";
import {
  getActiveCohort,
  upsertCohort,
  getRecentCohortWeights,
  getNextCohortIndex,
} from "./test-gate-t61-storage";

// ─── Threshold Calculation ──────────────────────────────────────────

/**
 * Calculate the cohort close threshold for a model.
 *
 * HARDENED: threshold = max(default, avg * multiplier, median * multiplier)
 * Median protects against single outlier anchoring the threshold.
 */
export function calculateCohortThreshold(
  deps: T61Deps,
  modelId: string,
  config: T61Config = { ...DEFAULT_T61_CONFIG },
): CohortThreshold {
  const recentWeights = getRecentCohortWeights(
    deps,
    modelId,
    config.dynamicThresholdWindow,
  );

  if (recentWeights.length === 0) {
    return { value: config.defaultCohortThreshold, source: "default" };
  }

  const avg =
    recentWeights.reduce((sum, w) => sum + w, 0) / recentWeights.length;
  const median = calculateMedian(recentWeights);
  const dynamicAvg = avg * config.dynamicThresholdMultiplier;
  const dynamicMedian = median * config.dynamicThresholdMultiplier;
  const threshold = Math.max(
    config.defaultCohortThreshold,
    dynamicAvg,
    dynamicMedian,
  );

  return {
    value: Math.round(threshold),
    source: threshold > config.defaultCohortThreshold ? "dynamic" : "default",
  };
}

// ─── Cohort Management ──────────────────────────────────────────────

/**
 * Get or create the active cohort for a model.
 * If no active cohort exists, creates a new one.
 */
export function getOrCreateActiveCohort(
  deps: T61Deps,
  modelId: string,
): ModelCohort {
  const existing = getActiveCohort(deps, modelId);
  if (existing) return existing;

  const newIndex = getNextCohortIndex(deps, modelId);
  const cohort: ModelCohort = {
    modelId,
    cohortIndex: newIndex,
    commits: [],
    accumulatedWeight: 0,
    rawScoreAvg: 0,
    adjustedScoreAvg: 0,
    totalMutants: 0,
    survived: 0,
    criticalSurvivors: 0,
    structuralViolations: 0,
    correctionCycles: 0,
    reliabilityIndex: null,
    confidenceLevel: "insufficient-data",
    closed: false,
    volatilityFlag: false,
    stabilityStatus: "insufficient-data",
  };

  upsertCohort(deps, cohort);
  deps.log(`[T6.1-Cohorts] Created cohort ${modelId}#${newIndex}`);
  return cohort;
}

/** Data to accumulate into a cohort from a single commit. */
export interface CohortAccumulation {
  commitHash: string;
  weight: number;
  rawScore: number;
  adjustedScore: number;
  totalMutants: number;
  survived: number;
  criticalSurvivors: number;
  structuralViolations: number;
}

/**
 * Accumulate commit data into the active cohort.
 * Returns the updated cohort and whether it was closed.
 */
export function accumulateIntoCohort(
  deps: T61Deps,
  modelId: string,
  data: CohortAccumulation,
  config: T61Config = { ...DEFAULT_T61_CONFIG },
): { cohort: ModelCohort; closed: boolean } {
  const cohort = getOrCreateActiveCohort(deps, modelId);

  // Accumulate
  cohort.commits.push(data.commitHash);
  cohort.accumulatedWeight += data.weight;
  cohort.totalMutants += data.totalMutants;
  cohort.survived += data.survived;
  cohort.criticalSurvivors += data.criticalSurvivors;
  cohort.structuralViolations += data.structuralViolations;

  // Running average for scores
  const n = cohort.commits.length;
  cohort.rawScoreAvg = updateAverage(cohort.rawScoreAvg, data.rawScore, n);
  cohort.adjustedScoreAvg = updateAverage(
    cohort.adjustedScoreAvg,
    data.adjustedScore,
    n,
  );

  // Check if threshold met
  const threshold = calculateCohortThreshold(deps, modelId, config);
  const shouldClose = cohort.accumulatedWeight >= threshold.value;

  if (shouldClose) {
    cohort.closed = true;
    deps.log(
      `[T6.1-Cohorts] Closed cohort ${modelId}#${cohort.cohortIndex} ` +
        `(weight=${cohort.accumulatedWeight}, threshold=${threshold.value})`,
    );
  }

  upsertCohort(deps, cohort);
  return { cohort, closed: shouldClose };
}

/**
 * Increment the correction cycle count on a cohort.
 * Only valid for open cohorts per spec.
 */
export function incrementCorrectionCycles(
  deps: T61Deps,
  modelId: string,
  cohortIndex: number,
): void {
  const cohort = getActiveCohort(deps, modelId);
  if (!cohort || cohort.cohortIndex !== cohortIndex) {
    deps.log(
      `[T6.1-Cohorts] Cannot increment corrections: ` +
        `cohort ${modelId}#${cohortIndex} not active`,
    );
    return;
  }

  cohort.correctionCycles++;
  upsertCohort(deps, cohort);
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Incremental average: newAvg = oldAvg + (newVal - oldAvg) / n */
function updateAverage(oldAvg: number, newVal: number, n: number): number {
  if (n <= 0) return newVal;
  return oldAvg + (newVal - oldAvg) / n;
}

/**
 * Calculate median of a numeric array.
 * Even-length: average of two middle values.
 * No external libraries. Deterministic sorting.
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
