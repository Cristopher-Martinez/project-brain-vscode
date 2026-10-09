/**
 * T5-EL — Main Orchestrator
 *
 * Consumes T5 Engine output and applies evolution layer:
 * persistence → trend → maturity → policy → final result.
 *
 * Engine is NOT modified. EL is a pure consumer.
 */

import {
  computeMaturity,
  computeTrend,
  detectBaselineDrift,
  detectVolumeDrift,
} from "./test-gate-mutation-el-analysis";
import {
  autoCreateBaseline,
  buildArtifact,
  loadBaseline,
  loadRecentHistory,
  pruneHistory,
  saveArtifact,
} from "./test-gate-mutation-el-persistence";
import {
  applyPolicy,
  assertPolicyConsistency,
  generateRecommendation,
} from "./test-gate-mutation-el-policy";
import type {
  FinalT5Result,
  HistoryIntegrity,
  MaturityInfo,
  MutationRun,
  T5ELConfig,
  T5ELDeps,
  TrendInfo,
} from "./test-gate-mutation-el-types";
import {
  DEFAULT_T5EL_CONFIG,
  toModuleScoreMap,
  toMutantDetails,
} from "./test-gate-mutation-el-types";
import type { T5Result } from "./test-gate-mutation-types";

// ——— Fail-Safe Integrity ————————————————————————————————————

/**
 * Verify no source files were left in a mutated state.
 * Called before EL processing begins.
 */
export async function verifyIntegrity(
  sourceFiles: string[],
  expectedHashes: Map<string, string>,
  deps: T5ELDeps,
): Promise<{ clean: boolean; corrupted: string[]; recovered: string[] }> {
  const corrupted: string[] = [];
  const recovered: string[] = [];

  for (const file of sourceFiles) {
    const content = await deps.readFile(file);
    if (!content) {
      continue;
    }

    const expectedHash = expectedHashes.get(file);
    if (!expectedHash) {
      continue;
    }

    const actualHash = simpleHash(content);
    if (actualHash !== expectedHash) {
      deps.log(`[T5-EL] INTEGRITY FAIL: ${file}, attempting recovery...`);
      const restored = await deps.restoreFile(file);
      if (restored) {
        const newContent = await deps.readFile(file);
        if (newContent && simpleHash(newContent) === expectedHash) {
          recovered.push(file);
          deps.log(`[T5-EL] Recovered: ${file}`);
          continue;
        }
      }
      corrupted.push(file);
      deps.log(`[T5-EL] UNRECOVERABLE: ${file}`);
    }
  }

  return { clean: corrupted.length === 0, corrupted, recovered };
}

/** Quick hash for integrity checks (not cryptographic) */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `${content.length}:${hash}`;
}

// ——— Main Orchestrator ——————————————————————————————————————

/**
 * Run the T5 Evolution Layer on an engine result.
 *
 * Flow: persist → load history → trend → maturity → baseline → policy → result
 */
export async function runT5EvolutionLayer(
  engineResult: T5Result,
  modifiedFiles: string[],
  deps: T5ELDeps,
  config: T5ELConfig = DEFAULT_T5EL_CONFIG,
): Promise<FinalT5Result> {
  // Skip if engine was skipped
  if (engineResult.skipped) {
    return buildSkippedResult(engineResult, config);
  }

  // 1. Build and persist artifact
  const commit = await deps.getCommitHash();
  const branch = await deps.getBranch();
  const artifact = buildArtifact(engineResult, commit, branch);
  await saveArtifact(artifact, config.historyDir, deps);

  // 1b. Prune old history entries
  await pruneHistory(config.historyDir, config.maxHistoryEntries, deps);

  // 2. Load history for trend + maturity
  const historyResult = await loadRecentHistory(
    config.historyDir,
    deps,
    config.maturityWindowSize + 1,
  );
  const recentHistory = historyResult.runs;
  const previousRun = findPreviousRun(recentHistory, commit);

  // 3. Compute trend
  const trend = computeTrend(artifact, previousRun);

  // 4. Compute maturity
  const t4PassStreak = await deps.getT4PassStreak();
  const maturity = computeMaturity(recentHistory, t4PassStreak, {
    minAvgScore: config.maturityMinAvgScore,
    minT4Streak: config.maturityMinT4Streak,
    windowSize: config.maturityWindowSize,
    minMutationVolume: config.minMutationVolume,
  });

  // 5. Baseline management (FIX 1: returns AutoBaselineResult)
  const autoResult = await autoCreateBaseline(
    artifact,
    config.globalMinScore,
    config.baselinePath,
    deps,
  );
  const baseline =
    autoResult.baseline ?? (await loadBaseline(config.baselinePath, deps));

  // 6. Apply policy
  const decision = applyPolicy(
    artifact,
    config.mode,
    baseline,
    maturity.level,
    config,
    modifiedFiles,
  );

  // 6b. FIX 13: Verify policy consistency
  const consistency = assertPolicyConsistency(
    decision,
    artifact,
    config.mode,
    config,
  );
  if (!consistency.consistent) {
    deps.log(
      `[T5-EL] POLICY INCONSISTENCY: ${consistency.violations.join("; ")}`,
    );
  }

  // 6c. FIX 10: Detect baseline drift
  const drift = detectBaselineDrift(artifact.adjustedScore, baseline);

  // 6d. FIX 12: Detect volume drift (avg of last 3 runs)
  const previousRuns = recentHistory.filter((r) => r.commit !== commit);
  const volumeDrift = detectVolumeDrift(artifact, previousRuns);
  if (volumeDrift.suspicious) {
    deps.log(
      `[T5-EL] WARNING: Mutant volume dropped ${volumeDrift.dropPercent}% (avg ${volumeDrift.averageVolume}\u2192${volumeDrift.currentVolume})`,
    );
  }

  // 7. Generate recommendation
  const recommendation = generateRecommendation(
    decision,
    config.mode,
    maturity.level,
    trend?.direction ?? null,
  );

  // 8. Build final result
  return buildFinalResult(
    engineResult,
    artifact,
    config,
    trend,
    maturity,
    decision,
    baseline !== null,
    recommendation,
    drift.drifted,
    volumeDrift.suspicious,
    consistency.consistent,
    historyResult.integrity,
  );
}

// ——— Result Builders ————————————————————————————————————————

function buildSkippedResult(
  engineResult: T5Result,
  config: T5ELConfig,
): FinalT5Result {
  return {
    mode: config.mode,
    policyApplied: config.mode,
    baselineActive: false,
    maturityLevel: "legacy",
    rawScore: null,
    adjustedScore: null,
    deltaScore: null,
    trend: null,
    criticalSurvivors: [],
    blocking: false,
    blockingReason: null,
    wouldBlockInEnforce: false,
    recoveredFromDirtyState: false,
    engineResult,
    moduleScores: {},
    hashVerified: engineResult.hashVerified,
    baselineDrifted: false,
    volumeDriftSuspicious: false,
    policyConsistent: true,
    historyIntegrity: "healthy",
  };
}

function buildFinalResult(
  engineResult: T5Result,
  artifact: MutationRun,
  config: T5ELConfig,
  trend: TrendInfo | null,
  maturity: MaturityInfo,
  decision: {
    blocking: boolean;
    wouldBlockInEnforce: boolean;
    blockingReason: import("./test-gate-mutation-el-types").BlockingReason;
  },
  baselineActive: boolean,
  recommendation: string | undefined,
  baselineDrifted: boolean,
  volumeDriftSuspicious: boolean,
  policyConsistent: boolean,
  historyIntegrity: HistoryIntegrity,
): FinalT5Result {
  return {
    mode: config.mode,
    policyApplied: config.mode,
    baselineActive,
    maturityLevel: maturity.level,
    rawScore: artifact.rawScore,
    adjustedScore: artifact.adjustedScore,
    deltaScore: trend?.deltaScore ?? null,
    trend: trend?.direction ?? null,
    criticalSurvivors: toMutantDetails(engineResult.criticalSurvivors),
    blocking: decision.blocking,
    blockingReason: decision.blockingReason,
    wouldBlockInEnforce: decision.wouldBlockInEnforce,
    recoveredFromDirtyState: false,
    recommendation,
    engineResult,
    moduleScores: toModuleScoreMap(engineResult.moduleScores),
    hashVerified: engineResult.hashVerified,
    baselineDrifted,
    volumeDriftSuspicious,
    policyConsistent,
    historyIntegrity,
  };
}

// ——— Helpers ————————————————————————————————————————————————

/** Find the most recent artifact that isn't the current commit */
function findPreviousRun(
  history: MutationRun[],
  currentCommit: string,
): MutationRun | null {
  for (const run of history) {
    if (run.commit !== currentCommit) {
      return run;
    }
  }
  return null;
}
