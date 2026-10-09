/**
 * T6.1 — Model Telemetry Layer: Type Definitions
 *
 * All types for the model telemetry pipeline.
 * T6.1 is a non-blocking telemetry layer that:
 * - Attributes commits to LLM models
 * - Aggregates performance metrics via dynamic cohorts
 * - Tracks correction cycles and reliability
 * - Persists model telemetry for UI consumption (T6)
 *
 * Position in DAG: T5-EL → T6.1 → T6 → T7
 */

// ─── Commit Attribution ─────────────────────────────────────────────

/** A single commit attributed to a model (or "human"). */
export interface ModelCommit {
  commitHash: string;
  modelId: string; // "human" if no model attribution
  timestamp: string; // ISO 8601
  linesAdded: number;
  linesRemoved: number;
  filesModified: string[];
}

// ─── Change Weight ──────────────────────────────────────────────────

/**
 * Impact metric per commit.
 * CW = linesAdded + linesRemoved + totalMutants + structuralViolations
 * All components have equal weight. No exponential scaling.
 */
export interface ChangeWeightInput {
  linesAdded: number;
  linesRemoved: number;
  totalMutants: number;
  structuralViolations: number;
}

// ─── Cohort ─────────────────────────────────────────────────────────

/** Dynamic cohort for a single model. */
export interface ModelCohort {
  modelId: string;
  cohortIndex: number;
  commits: string[]; // commit hashes
  accumulatedWeight: number;
  rawScoreAvg: number;
  adjustedScoreAvg: number;
  totalMutants: number;
  survived: number;
  criticalSurvivors: number;
  structuralViolations: number;
  correctionCycles: number;
  reliabilityIndex: number | null;
  confidenceLevel: ConfidenceLevel;
  closed: boolean;
  /** True when |R_current - R_previous| > 25. */
  volatilityFlag: boolean;
  /** Stability classification for UI narrative. */
  stabilityStatus: StabilityStatus;
}

/** Stability status for hardened telemetry. */
export type StabilityStatus = "stable" | "unstable" | "insufficient-data";

/** Threshold for closing a cohort. */
export interface CohortThreshold {
  value: number;
  source: "default" | "dynamic";
}

// ─── Correction Cycle ───────────────────────────────────────────────

/** A detected correction cycle. */
export interface CorrectionCycle {
  correctorCommitHash: string;
  correctorModelId: string;
  targetCohortModelId: string;
  targetCohortIndex: number;
  reducedMetrics: CorrectionMetricDelta[];
  timestamp: string;
}

/** Which metric was reduced by the correction. */
export interface CorrectionMetricDelta {
  metric: "survived" | "criticalSurvivors" | "structuralViolations";
  before: number;
  after: number;
}

// ─── Reliability ────────────────────────────────────────────────────

/**
 * Reliability index components.
 * R = 100 - (mutationSurvivalRate * 40) - (criticalRegressionRate * 30)
 *         - (structuralViolationRate * 20) - (normalizedCorrectionCycles * 10)
 * Clamped to [0, 100].
 */
export interface ReliabilityComponents {
  mutationSurvivalRate: number;
  criticalRegressionRate: number;
  structuralViolationRate: number;
  normalizedCorrectionCycles: number;
}

export type ConfidenceLevel = "low" | "medium" | "high" | "insufficient-data";

// ─── DI Interface ───────────────────────────────────────────────────

/**
 * Dependency injection for T6.1. Abstracts SQLite for testability.
 * In production: backed by sql.js Database.
 * In tests: backed by in-memory arrays/maps.
 */
export interface T61Deps {
  /** Execute a write SQL statement (INSERT, UPDATE, CREATE). */
  dbRun: (sql: string, params?: unknown[]) => void;
  /** Execute a read SQL statement, return all rows. */
  dbAll: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T[];
  /** Execute a read SQL statement, return first row or undefined. */
  dbGet: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => T | undefined;
  /** Log a message. */
  log: (msg: string) => void;
}

// ─── Config ─────────────────────────────────────────────────────────

/** T6.1 configuration. */
export interface T61Config {
  /** Default cohort threshold when insufficient history. */
  defaultCohortThreshold: number;
  /** Multiplier for dynamic threshold: avgWeightLast20 * multiplier. */
  dynamicThresholdMultiplier: number;
  /** Number of recent cohorts to average for dynamic threshold. */
  dynamicThresholdWindow: number;
}

/** Default T6.1 configuration. */
export const DEFAULT_T61_CONFIG: T61Config = {
  defaultCohortThreshold: 300,
  dynamicThresholdMultiplier: 5,
  dynamicThresholdWindow: 20,
};

// ─── Pipeline Result ────────────────────────────────────────────────

/** Result of the full T6.1 pipeline execution. */
export interface T61PipelineResult {
  commitsProcessed: number;
  cohortsUpdated: string[]; // modelIds that had cohorts updated
  cohortsClosed: string[]; // modelIds that had cohorts closed
  correctionsDetected: number;
  errors: string[];
}

/** Model telemetry summary for UI consumption. */
export interface ModelTelemetrySummary {
  modelId: string;
  totalCommits: number;
  totalWeight: number;
  closedCohorts: number;
  activeCohort: ModelCohort | null;
  latestReliability: number | null;
  latestConfidence: ConfidenceLevel | null;
  correctionCyclesTotal: number;
  /** True when sample is sufficient for comparison. */
  meetsIntegrityFilter: boolean;
  /** Volatility flag from latest closed cohort. */
  volatilityFlag: boolean;
  /** Stability status from latest closed cohort. */
  stabilityStatus: StabilityStatus;
}
