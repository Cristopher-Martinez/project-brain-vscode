/**
 * T6.1 — Model Telemetry Layer: Reliability Index & Confidence
 *
 * Reliability Index (after cohort closure):
 * R = 100 - (mutationSurvivalRate * 40) - (criticalRegressionRate * 30)
 *         - (structuralViolationRate * 20) - (normalizedCorrectionCycles * 10)
 * Clamped to [0, 100].
 *
 * HARDENING — Minimum Stability Rule:
 *   R is NOT computed unless: >=2 closed cohorts, combined weight >=300, mutants >=10
 *   Otherwise: reliabilityIndex = null, confidenceLevel = "insufficient-data"
 *
 * HARDENING — Volatility Guard:
 *   If |R_current - R_previous| > 25 -> volatilityFlag = true
 *
 * Confidence Level (based on accumulated weight):
 * < 300  -> low
 * 300-1000 -> medium
 * > 1000 -> high
 */

import type {
  ModelCohort,
  ReliabilityComponents,
  ConfidenceLevel,
  StabilityStatus,
} from "./test-gate-t61-types";

/** Minimum closed cohorts before reliability is computed. */
const MIN_CLOSED_COHORTS = 2;
/** Minimum combined accumulated weight. */
const MIN_COMBINED_WEIGHT = 300;
/** Minimum total mutants across closed cohorts. */
const MIN_TOTAL_MUTANTS = 10;
/** Volatility threshold for flagging instability. */
const VOLATILITY_THRESHOLD = 25;

// --- Reliability ---

/**
 * Extract reliability components from a closed cohort.
 * All rates are 0-1 (fractions, not percentages).
 */
export function extractReliabilityComponents(
  cohort: ModelCohort,
): ReliabilityComponents {
  const totalMutants = Math.max(cohort.totalMutants, 1); // avoid div/0

  return {
    mutationSurvivalRate: cohort.survived / totalMutants,
    criticalRegressionRate: cohort.criticalSurvivors / totalMutants,
    structuralViolationRate:
      cohort.structuralViolations / Math.max(cohort.commits.length, 1),
    normalizedCorrectionCycles:
      cohort.correctionCycles / Math.max(cohort.commits.length, 1),
  };
}

/**
 * Compute the Reliability Index from components.
 * Clamped to [0, 100].
 */
export function computeReliabilityIndex(
  components: ReliabilityComponents,
): number {
  const raw =
    100 -
    components.mutationSurvivalRate * 40 -
    components.criticalRegressionRate * 30 -
    components.structuralViolationRate * 20 -
    components.normalizedCorrectionCycles * 10;

  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute the reliability index for a closed cohort.
 */
export function computeCohortReliability(cohort: ModelCohort): number {
  const components = extractReliabilityComponents(cohort);
  return computeReliabilityIndex(components);
}

// --- Confidence ---

/**
 * Determine confidence level based on accumulated weight.
 */
export function getConfidenceLevel(accumulatedWeight: number): ConfidenceLevel {
  if (accumulatedWeight > 1000) return "high";
  if (accumulatedWeight >= 300) return "medium";
  return "low";
}

// --- Hardened Stability Checks ---

/** Context for hardened reliability: previous closed cohorts. */
export interface StabilityContext {
  closedCohorts: ModelCohort[];
}

/**
 * Check if minimum stability conditions are met for R computation.
 * Requires: >=2 closed cohorts, combined weight >=300, total mutants >=10.
 */
export function meetsMinimumStability(ctx: StabilityContext): boolean {
  if (ctx.closedCohorts.length < MIN_CLOSED_COHORTS) return false;
  const totalWeight = ctx.closedCohorts.reduce(
    (sum, c) => sum + c.accumulatedWeight, 0,
  );
  if (totalWeight < MIN_COMBINED_WEIGHT) return false;
  const totalMutants = ctx.closedCohorts.reduce(
    (sum, c) => sum + c.totalMutants, 0,
  );
  return totalMutants >= MIN_TOTAL_MUTANTS;
}

/**
 * Detect volatility between current and previous reliability scores.
 * Returns true if |R_current - R_previous| > 25.
 */
export function detectVolatility(
  current: number,
  previous: number | null,
): boolean {
  if (previous === null) return false;
  return Math.abs(current - previous) > VOLATILITY_THRESHOLD;
}

/**
 * Determine stability status for a cohort given context.
 */
export function computeStabilityStatus(
  ctx: StabilityContext,
  current: number | null,
  previous: number | null,
): StabilityStatus {
  if (!meetsMinimumStability(ctx) || current === null) {
    return "insufficient-data";
  }
  if (detectVolatility(current, previous)) return "unstable";
  return "stable";
}

/**
 * Apply hardened reliability to a closed cohort.
 * Gates on minimum stability, detects volatility, sets stability status.
 */
export function applyReliabilityToCohort(
  cohort: ModelCohort,
  ctx?: StabilityContext,
): ModelCohort {
  if (!cohort.closed) return cohort;

  // Without context, apply basic reliability (backward-compat)
  if (!ctx) {
    const r = computeCohortReliability(cohort);
    return {
      ...cohort,
      reliabilityIndex: r,
      confidenceLevel: getConfidenceLevel(cohort.accumulatedWeight),
      stabilityStatus: "insufficient-data",
      volatilityFlag: false,
    };
  }

  // HARDENED: check minimum stability
  const allClosed = [...ctx.closedCohorts, cohort];
  const evalCtx: StabilityContext = { closedCohorts: allClosed };

  if (!meetsMinimumStability(evalCtx)) {
    return {
      ...cohort,
      reliabilityIndex: null,
      confidenceLevel: "insufficient-data",
      stabilityStatus: "insufficient-data",
      volatilityFlag: false,
    };
  }

  const r = computeCohortReliability(cohort);
  const prevR = ctx.closedCohorts.length > 0
    ? ctx.closedCohorts[ctx.closedCohorts.length - 1].reliabilityIndex
    : null;
  const volatile = detectVolatility(r, prevR);
  const status = volatile ? "unstable" : "stable";

  return {
    ...cohort,
    reliabilityIndex: r,
    confidenceLevel: getConfidenceLevel(cohort.accumulatedWeight),
    volatilityFlag: volatile,
    stabilityStatus: status,
  };
}
