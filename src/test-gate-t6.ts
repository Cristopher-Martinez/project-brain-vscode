/**
 * T6 — Observability & Governance Layer (Main Orchestrator)
 *
 * Runs T6-0 through T6-9 in DAG order:
 *   T6-0 (preconditions) → T6-1 (normalize) → T6-2/3/4 (protection/evolution/confidence)
 *   → T6-5 (governance) → T6-8 (advanced) → T6-9 (integrity) → FinalT6ViewModel
 *
 * T6 is an observatory, not an engine.
 * It MUST NOT modify T5 or T5-EL internals.
 * It MUST NOT recalculate mutation metrics.
 */

import type { FinalT5Result } from "./test-gate-mutation-el-types";
import {
  extractGovernanceConfig,
  loadGovernanceConfig,
} from "./test-gate-t6-governance";
import { crossCheckIntegrity } from "./test-gate-t6-integrity";
import {
  buildConfidenceModel,
  buildEvolutionSummary,
  buildProtectionSummary,
} from "./test-gate-t6-normalize";
import { checkPreconditions } from "./test-gate-t6-preconditions";
import type {
  FinalT6ViewModel,
  T6Config,
  T6Deps,
  T6GovernanceConfig,
  T6IntegrityResult,
  T6PreconditionResult,
} from "./test-gate-t6-types";

// ——— T6 Result ————————————————————————————————————————————

/** T5 engine config subset needed by T6 */
export interface T6T5ConfigRef {
  maxMutantsPerFile: number;
  maxTotalMutantsPerRun: number;
  mutationTimeoutMs: number;
}

/** Complete T6 execution result */
export interface T6ExecutionResult {
  /** Whether T6 completed successfully */
  success: boolean;
  /** T6-0 precondition check result */
  preconditions: T6PreconditionResult;
  /** Final view model (null if preconditions failed) */
  viewModel: FinalT6ViewModel | null;
  /** T6-9 integrity result (null if preconditions failed) */
  integrity: T6IntegrityResult | null;
}

// ——— Main Orchestrator —————————————————————————————————————

/**
 * Run the complete T6 Observability & Governance pipeline.
 *
 * @param input - FinalT5Result from T5-EL (may be null)
 * @param t5Config - T5 engine config (for governance field mapping)
 * @param config - T6-specific configuration
 * @param deps - DI dependencies for I/O
 */
export async function runT6ObservabilityGate(
  input: FinalT5Result | null | undefined,
  t5Config: T6T5ConfigRef,
  config: T6Config,
  deps: T6Deps,
): Promise<T6ExecutionResult> {
  deps.log("[T6] Starting Observability & Governance Layer");

  const preconditions = await checkPreconditions(
    input,
    config.elConfig.historyDir,
    config.elConfig.baselinePath,
    deps,
  );

  if (!preconditions.ready) {
    deps.log(`[T6] Preconditions failed: ${preconditions.failures.join("; ")}`);
    return { success: false, preconditions, viewModel: null, integrity: null };
  }

  const finalInput = input as FinalT5Result;
  deps.log("[T6] Preconditions passed — processing data");

  return processT6Pipeline(finalInput, t5Config, config, deps, preconditions);
}

// ——— Pipeline Processing ——————————————————————————————————

async function processT6Pipeline(
  input: FinalT5Result,
  t5Config: T6T5ConfigRef,
  config: T6Config,
  deps: T6Deps,
  preconditions: T6PreconditionResult,
): Promise<T6ExecutionResult> {
  const protection = buildProtectionSummary(input);
  deps.log(
    `[T6] Protection: ${protection.preventedCriticalErrors} critical, ` +
      `integrity=${protection.integrityState}`,
  );

  const evolution = buildEvolutionSummary(input);
  deps.log(
    `[T6] Evolution: trend=${evolution.trend}, maturity=${evolution.maturity}`,
  );

  const confidence = buildConfidenceModel(input);
  deps.log(`[T6] Confidence: ${confidence.confidenceLabel}`);

  const governance = await resolveGovernanceConfig(
    input,
    t5Config,
    config,
    deps,
  );

  const advancedMetrics = config.showAdvancedMetrics
    ? {
        rawScore: input.rawScore,
        adjustedScore: input.adjustedScore,
        deltaScore: input.deltaScore,
      }
    : undefined;

  const integrity = await crossCheckIntegrity(
    input,
    config.elConfig.historyDir,
    config.elConfig.baselinePath,
    deps,
  );
  if (integrity.warnings.length > 0) {
    deps.log(`[T6] Integrity warnings: ${integrity.warnings.join("; ")}`);
  }

  const viewModel: FinalT6ViewModel = {
    protection,
    evolution,
    confidence,
    governance,
    historyIntegrity: integrity.overallState,
    advancedMetrics,
  };

  deps.log("[T6] Observability gate complete");
  return { success: true, preconditions, viewModel, integrity };
}

// ——— Governance Resolution ————————————————————————————————

async function resolveGovernanceConfig(
  _input: FinalT5Result,
  t5Config: T6T5ConfigRef,
  config: T6Config,
  deps: T6Deps,
): Promise<T6GovernanceConfig> {
  const persisted = await loadGovernanceConfig(
    config.governanceConfigPath,
    deps,
  );
  if (persisted) {
    return persisted;
  }

  return extractGovernanceConfig(
    config.elConfig,
    t5Config.maxMutantsPerFile,
    t5Config.maxTotalMutantsPerRun,
    t5Config.mutationTimeoutMs,
  );
}
