/**
 * T5-EL — Analysis Module
 *
 * Trend computation and maturity model.
 * Pure functions — no I/O.
 */

import type {
  MaturityInfo,
  MaturityLevel,
  MutationBaseline,
  MutationRun,
  TrendDirection,
  TrendInfo,
} from "./test-gate-mutation-el-types";

// ——— Trend Computation ——————————————————————————————————————

/**
 * Compute trend between current run and previous run.
 * Returns null if no previous run available.
 */
export function computeTrend(
  current: MutationRun,
  previous: MutationRun | null,
): TrendInfo | null {
  if (!previous) {
    return null;
  }

  const deltaScore = current.adjustedScore - previous.adjustedScore;
  const deltaCritical =
    current.criticalSurvivors.length - previous.criticalSurvivors.length;

  let direction: TrendDirection;
  if (deltaScore > 2) {
    direction = "improving";
  } else if (deltaScore < -2) {
    direction = "regressing";
  } else {
    direction = "stable";
  }

  return { deltaScore, deltaCritical, direction };
}

/**
 * Classify a single run's trend direction by deltaScore.
 * Used for batch classification of multiple runs.
 */
export function classifyDelta(deltaScore: number): TrendDirection {
  if (deltaScore > 2) {
    return "improving";
  }
  if (deltaScore < -2) {
    return "regressing";
  }
  return "stable";
}

// ——— Maturity Model —————————————————————————————————————————

/**
 * Compute maturity level from recent run history.
 *
 * Mature requires ALL of:
 *   - avgScore >= maturityMinAvgScore (default 70)
 *   - 0 critical survivors in ALL window runs
 *   - trend never "regressing" in window
 *   - t4PassStreak >= maturityMinT4Streak (default 5)
 *
 * Growing: avgScore >= 55
 * Legacy: avgScore < 55
 */
export function computeMaturity(
  recentRuns: MutationRun[],
  t4PassStreak: number,
  opts: {
    minAvgScore: number;
    minT4Streak: number;
    windowSize: number;
    minMutationVolume: number;
  },
): MaturityInfo {
  const windowRuns = recentRuns.slice(0, opts.windowSize);
  const totalRuns = windowRuns.length;

  if (totalRuns === 0) {
    return {
      level: "legacy",
      avgScore: 0,
      avgTotalMutants: 0,
      criticalFreeRuns: 0,
      totalRuns: 0,
      neverRegressing: true,
    };
  }

  const avgScore =
    windowRuns.reduce((sum, r) => sum + r.adjustedScore, 0) / totalRuns;
  const avgTotalMutants =
    windowRuns.reduce((sum, r) => sum + r.totalMutants, 0) / totalRuns;
  const criticalFreeRuns = windowRuns.filter(
    (r) => r.criticalSurvivors.length === 0,
  ).length;
  const neverRegressing = !hasRegressingTrend(windowRuns);

  const level = classifyMaturity(
    avgScore,
    criticalFreeRuns,
    totalRuns,
    neverRegressing,
    t4PassStreak,
    avgTotalMutants,
    opts,
  );

  return {
    level,
    avgScore: Math.round(avgScore * 100) / 100,
    avgTotalMutants: Math.round(avgTotalMutants * 100) / 100,
    criticalFreeRuns,
    totalRuns,
    neverRegressing,
  };
}

/** Check if any consecutive pair in runs shows regression */
function hasRegressingTrend(runs: MutationRun[]): boolean {
  for (let i = 0; i < runs.length - 1; i++) {
    // runs are sorted newest-first, so runs[i] is "current", runs[i+1] is "previous"
    const delta = runs[i].adjustedScore - runs[i + 1].adjustedScore;
    if (classifyDelta(delta) === "regressing") {
      return true;
    }
  }
  return false;
}

/** Apply classification rules */
function classifyMaturity(
  avgScore: number,
  criticalFreeRuns: number,
  totalRuns: number,
  neverRegressing: boolean,
  t4PassStreak: number,
  avgTotalMutants: number,
  opts: {
    minAvgScore: number;
    minT4Streak: number;
    windowSize: number;
    minMutationVolume: number;
  },
): MaturityLevel {
  // Mature: all conditions met with full window + volume guard
  if (
    totalRuns >= opts.windowSize &&
    avgScore >= opts.minAvgScore &&
    criticalFreeRuns === totalRuns &&
    neverRegressing &&
    t4PassStreak >= opts.minT4Streak &&
    avgTotalMutants >= opts.minMutationVolume
  ) {
    return "mature";
  }

  // Growing: avg score above legacy threshold
  if (avgScore >= 55) {
    return "growing";
  }

  return "legacy";
}

// ——— FIX 10: Baseline Drift Detection ———————————————————————

export interface BaselineDriftResult {
  drifted: boolean;
  /** Current score minus baseline score */
  gap: number;
  /** Recommendation: deactivate baseline if drift > maxDrift */
  recommendation: string | null;
}

/**
 * Detect if score has drifted so far above baseline that the baseline
 * is no longer meaningful (e.g., project improved 20+ points).
 * maxDrift default = 25 points.
 */
export function detectBaselineDrift(
  currentScore: number,
  baseline: MutationBaseline | null,
  maxDrift: number = 25,
): BaselineDriftResult {
  if (!baseline) {
    return { drifted: false, gap: 0, recommendation: null };
  }
  const gap = currentScore - baseline.baselineScore;
  if (gap > maxDrift) {
    return {
      drifted: true,
      gap,
      recommendation: `Score ${currentScore} is ${gap} points above baseline ${baseline.baselineScore}. Consider re-establishing baseline or switching to enforce mode.`,
    };
  }
  return { drifted: false, gap, recommendation: null };
}

// ——— FIX 12: Volume Drift Detection —————————————————————————

export interface VolumeDriftResult {
  /** Volume dropped suspiciously */
  suspicious: boolean;
  /** Percentage drop (0-100) */
  dropPercent: number;
  /** Average volume from recent runs used as reference */
  averageVolume: number;
  /** Current run's total mutants */
  currentVolume: number;
}

/**
 * Detect if totalMutants dropped significantly vs average of last N runs.
 * Uses up to 3 most recent previous runs for the average.
 * A >30% drop suggests tests/source were removed.
 * maxDropPercent default = 30.
 */
export function detectVolumeDrift(
  current: MutationRun,
  recentHistory: MutationRun[],
  maxDropPercent: number = 30,
): VolumeDriftResult {
  const window = recentHistory.slice(0, 3);
  if (window.length === 0) {
    return {
      suspicious: false,
      dropPercent: 0,
      averageVolume: 0,
      currentVolume: current.totalMutants,
    };
  }
  const avgVolume =
    window.reduce((s, r) => s + r.totalMutants, 0) / window.length;
  if (avgVolume === 0) {
    return {
      suspicious: false,
      dropPercent: 0,
      averageVolume: 0,
      currentVolume: current.totalMutants,
    };
  }
  const drop = avgVolume - current.totalMutants;
  const dropPercent = (drop / avgVolume) * 100;
  return {
    suspicious: dropPercent > maxDropPercent,
    dropPercent: Math.round(dropPercent * 100) / 100,
    averageVolume: Math.round(avgVolume * 100) / 100,
    currentVolume: current.totalMutants,
  };
}
