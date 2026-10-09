/**
 * T6.1 — Model Telemetry Layer: Pipeline Orchestrator
 *
 * Coordinates the full T6.1 pipeline:
 * 1. Initialize schema
 * 2. Attribute commits
 * 3. Calculate change weights
 * 4. Accumulate into cohorts
 * 5. Detect correction cycles
 * 6. Compute reliability (on closed cohorts)
 * 7. Generate telemetry summaries for T6 UI
 *
 * Position in DAG: T5-EL → T6.1 → T6 → T7
 * Non-blocking: does NOT modify policy or block merges.
 */

import {
  DEFAULT_T61_CONFIG,
  type ModelCommit,
  type T61Deps,
  type T61Config,
  type T61PipelineResult,
  type ModelTelemetrySummary,
} from "./test-gate-t61-types";
import { initT61Schema, getActiveCohort, getClosedCohorts, getDistinctModels, upsertCohort, getCommitsByModel } from "./test-gate-t61-storage";
import {
  attributeCommit,
  calculateCommitWeight,
  shouldAccumulateWeight,
} from "./test-gate-t61-attribution";
import {
  accumulateIntoCohort,
  incrementCorrectionCycles,
  type CohortAccumulation,
} from "./test-gate-t61-cohorts";
import {
  detectCorrectionCycle,
  getCohortFiles,
  type MetricSnapshot,
} from "./test-gate-t61-corrections";
import {
  applyReliabilityToCohort,
} from "./test-gate-t61-reliability";
import type { StabilityContext } from "./test-gate-t61-reliability";


// ─── Pipeline Input ─────────────────────────────────────────────────

/** Input for processing a single commit through the T6.1 pipeline. */
export interface T61CommitInput {
  commit: Omit<ModelCommit, "modelId"> & { modelId?: string };
  /** Mutation testing results for this commit. */
  totalMutants: number;
  survived: number;
  criticalSurvivors: number;
  structuralViolations: number;
  rawScore: number;
  adjustedScore: number;
  /** Metrics BEFORE this commit (for correction detection). */
  beforeMetrics?: MetricSnapshot;
  /** Metrics AFTER this commit (for correction detection). */
  afterMetrics?: MetricSnapshot;
}

// ─── Pipeline ───────────────────────────────────────────────────────

/**
 * Initialize the T6.1 pipeline. Must be called once before processing.
 */
export function initT61Pipeline(deps: T61Deps): void {
  initT61Schema(deps);
  deps.log("[T6.1] Pipeline initialized");
}

/**
 * Process a batch of commits through the T6.1 pipeline.
 *
 * For each commit:
 * 1. Attribute to model
 * 2. Calculate change weight
 * 3. Accumulate into active cohort (if not human)
 * 4. Check for correction cycles
 * 5. Close cohort if threshold met
 * 6. Compute reliability on closed cohorts
 */
export function processCommits(
  deps: T61Deps,
  inputs: T61CommitInput[],
  config: T61Config = { ...DEFAULT_T61_CONFIG },
): T61PipelineResult {
  const result: T61PipelineResult = {
    commitsProcessed: 0,
    cohortsUpdated: [],
    cohortsClosed: [],
    correctionsDetected: 0,
    errors: [],
  };

  for (const input of inputs) {
    try {
      processSingleCommit(deps, input, config, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Commit ${input.commit.commitHash}: ${msg}`);
      deps.log(`[T6.1] Error processing ${input.commit.commitHash}: ${msg}`);
    }
  }

  deps.log(
    `[T6.1] Processed ${result.commitsProcessed} commits, ` +
      `${result.cohortsClosed.length} cohorts closed, ` +
      `${result.correctionsDetected} corrections`,
  );

  return result;
}

function processSingleCommit(
  deps: T61Deps,
  input: T61CommitInput,
  config: T61Config,
  result: T61PipelineResult,
): void {
  const modelId = input.commit.modelId || "human";

  // 1. Attribute
  const fullCommit: ModelCommit = { ...input.commit, modelId };
  attributeCommit(deps, fullCommit);
  result.commitsProcessed++;

  // 2. Calculate CW
  const weight = calculateCommitWeight(
    fullCommit,
    input.totalMutants,
    input.structuralViolations,
  );

  // 3. Accumulate into cohort (only non-human)
  if (shouldAccumulateWeight(modelId)) {
    const accumulation: CohortAccumulation = {
      commitHash: fullCommit.commitHash,
      weight,
      rawScore: input.rawScore,
      adjustedScore: input.adjustedScore,
      totalMutants: input.totalMutants,
      survived: input.survived,
      criticalSurvivors: input.criticalSurvivors,
      structuralViolations: input.structuralViolations,
    };

    const { cohort, closed } = accumulateIntoCohort(
      deps,
      modelId,
      accumulation,
      config,
    );

    if (!result.cohortsUpdated.includes(modelId)) {
      result.cohortsUpdated.push(modelId);
    }

    // 5. Close + compute reliability
    if (closed) {
      const closedForCtx = getClosedCohorts(deps, cohort.modelId).filter(c => c.closed);
      const stabilityCtx: StabilityContext = { closedCohorts: closedForCtx };
      const withReliability = applyReliabilityToCohort(cohort, stabilityCtx);
      upsertCohort(deps, withReliability);
      result.cohortsClosed.push(modelId);
    }
  }

  // 4. Check for corrections (applies to ALL commits including human)
  if (input.beforeMetrics && input.afterMetrics) {
    checkCorrections(deps, fullCommit, input, result);
  }
}

function checkCorrections(
  deps: T61Deps,
  commit: ModelCommit,
  input: T61CommitInput,
  result: T61PipelineResult,
): void {
  // Check all active cohorts for correction cycles
  const models = getDistinctModels(deps);
  for (const mid of models) {
    const activeCohort = getActiveCohort(deps, mid);
    if (!activeCohort || activeCohort.closed) continue;

    const cohortFiles = getCohortFiles(deps, activeCohort);
    const correction = detectCorrectionCycle(
      deps,
      commit,
      activeCohort,
      input.beforeMetrics!,
      input.afterMetrics!,
      cohortFiles,
    );

    if (correction) {
      incrementCorrectionCycles(deps, mid, activeCohort.cohortIndex);
      result.correctionsDetected++;
    }
  }
}

// ─── Query Interface (for T6 UI) ────────────────────────────────────

/**
 * Get telemetry summary for all models.
 * This is the query interface T6 consumes for UI rendering.
 */
export function getModelTelemetrySummaries(
  deps: T61Deps,
): ModelTelemetrySummary[] {
  const models = getDistinctModels(deps);
  return models.map((modelId) => getModelSummary(deps, modelId));
}

/**
 * Get telemetry summary for a single model.
 */
export function getModelSummary(
  deps: T61Deps,
  modelId: string,
): ModelTelemetrySummary {
  const commits = getCommitsByModel(deps, modelId);
  const closed = getClosedCohorts(deps, modelId);
  const closedTotalWeight = closed.reduce((s, c) => s + c.accumulatedWeight, 0);
  const closedTotalMutants = closed.reduce((s, c) => s + c.totalMutants, 0);
  const active = getActiveCohort(deps, modelId) ?? null;

  const totalWeight = commits.reduce(
    (sum, c) => sum + c.linesAdded + c.linesRemoved,
    0,
  );

  const latestClosed = closed.length > 0 ? closed[closed.length - 1] : null;
  const totalCorrections =
    closed.reduce((sum, c) => sum + c.correctionCycles, 0) +
    (active?.correctionCycles ?? 0);

  return {
    modelId,
    totalCommits: commits.length,
    totalWeight,
    closedCohorts: closed.length,
    activeCohort: active,
    latestReliability: latestClosed?.reliabilityIndex ?? null,
    latestConfidence: latestClosed?.confidenceLevel ?? null,
    correctionCyclesTotal: totalCorrections,
    meetsIntegrityFilter: closed.length >= 1 && closedTotalWeight >= 300 && closedTotalMutants >= 10,
    volatilityFlag: latestClosed?.volatilityFlag ?? false,
    stabilityStatus: latestClosed?.stabilityStatus ?? "insufficient-data",
  };
}
