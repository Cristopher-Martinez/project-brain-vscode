/**
 * T6 — Shared Test Helpers
 *
 * DRY helper factories for all T6 test files.
 */

import {
  DEFAULT_T5EL_CONFIG,
  type FinalT5Result,
  type MutationRun,
} from "./test-gate-mutation-el-types";
import type { T6Deps, T6Config, T6GovernanceConfig } from "./test-gate-t6-types";

export function makeEngineResult(): FinalT5Result["engineResult"] {
  return {
    name: "mutation-testing",
    passed: true,
    blocking: false,
    skipped: false,
    globalScore: 80,
    rawGlobalScore: 85,
    moduleScores: [],
    totalMutants: 10,
    killed: 8,
    survived: 2,
    timeout: 0,
    equivalentExcluded: 0,
    invalid: 0,
    capped: false,
    mutantsSkippedDueToCap: 0,
    criticalSurvivors: [],
    highSurvivors: [],
    complexityAdjusted: true,
    executionTimeMs: 1000,
    filesAnalyzed: 3,
    ready_for_T6: true,
    mode: "report",
    mutantReports: [],
    hashVerified: true,
  };
}

export function makeFinalT5Result(
  overrides: Partial<FinalT5Result> = {},
): FinalT5Result {
  return {
    mode: "report",
    policyApplied: "report",
    baselineActive: false,
    maturityLevel: "growing",
    rawScore: 85,
    adjustedScore: 80,
    deltaScore: 5,
    trend: "improving",
    criticalSurvivors: [],
    blocking: false,
    blockingReason: null,
    wouldBlockInEnforce: false,
    recoveredFromDirtyState: false,
    engineResult: makeEngineResult(),
    moduleScores: {},
    hashVerified: true,
    baselineDrifted: false,
    volumeDriftSuspicious: false,
    policyConsistent: true,
    historyIntegrity: "healthy",
    ...overrides,
  };
}

export function makeDeps(overrides: Partial<T6Deps> = {}): T6Deps {
  const fs = new Map<string, string>();
  return {
    readFile: async (path: string) => fs.get(path) ?? null,
    writeFile: async (path: string, content: string) => {
      fs.set(path, content);
    },
    listDir: async () => [],
    ensureDir: async () => {},
    log: () => {},
    ...overrides,
  };
}

export function makeT6Config(): T6Config {
  return {
    configHistoryDir: ".t6-config-history",
    governanceConfigPath: ".t6-governance.json",
    elConfig: { ...DEFAULT_T5EL_CONFIG },
    showAdvancedMetrics: false,
  };
}

export function makeGovConfig(
  overrides: Partial<T6GovernanceConfig> = {},
): T6GovernanceConfig {
  return {
    policyMode: "report",
    globalMinScore: 65,
    coreMinScore: 55,
    maxMutantsPerFile: 30,
    maxTotalMutants: 150,
    mutationTimeout: 30000,
    ...overrides,
  };
}

export function makeArtifact(
  overrides: Partial<MutationRun> = {},
): MutationRun {
  return {
    commit: "abc123",
    timestamp: new Date().toISOString(),
    rawScore: 85,
    adjustedScore: 80,
    moduleScores: {},
    totalMutants: 10,
    killed: 8,
    survived: 2,
    timeout: 0,
    equivalent: 0,
    invalid: 0,
    criticalSurvivors: [],
    capped: false,
    mutantsSkippedDueToCap: 0,
    ...overrides,
  };
}

export const T5_CONFIG = {
  maxMutantsPerFile: 30,
  maxTotalMutantsPerRun: 150,
  mutationTimeoutMs: 30000,
};
