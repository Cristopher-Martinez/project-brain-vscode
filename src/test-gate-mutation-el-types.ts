/**
 * T5-EL — Mutation Evolution Layer Types
 *
 * Types for persistence, baseline, trend, maturity, and policy.
 * This layer CONSUMES T5 Engine output — never modifies it.
 */

import { createHash } from "crypto";
import type {
  ModuleScore,
  MutantResult,
  T5Result,
} from "./test-gate-mutation-types";

// ——— Mutation Mode ——————————————————————————————————————————

/** Policy modes from least to most strict */
export type MutationMode = "report" | "baseline-lock" | "adaptive" | "enforce";

// ——— Persisted Artifact —————————————————————————————————————

/** Critical survivor detail for persistence */
export interface MutantDetail {
  /** Stable identity: hash(file:line:operator) */
  mutantId: string;
  file: string;
  line: number;
  column: number;
  operator: string;
  functionName: string;
  astNodeKind: string;
}

/** Persisted per-commit mutation run artifact */
export interface MutationRun {
  commit: string;
  timestamp: string;
  branch?: string;
  rawScore: number;
  adjustedScore: number;
  moduleScores: Record<string, number>;
  totalMutants: number;
  killed: number;
  survived: number;
  timeout: number;
  equivalent: number;
  invalid: number;
  criticalSurvivors: MutantDetail[];
  capped: boolean;
  mutantsSkippedDueToCap: number;
}

// ——— Baseline ———————————————————————————————————————————————

/** Persisted baseline snapshot */
export interface MutationBaseline {
  baselineScore: number;
  baselineCritical: number;
  /** Stable mutant IDs for identity-based comparison */
  baselineMutantIds: string[];
  createdAt: string;
  commit?: string;
}

// ——— Trend ——————————————————————————————————————————————————

export type TrendDirection = "improving" | "stable" | "regressing";

export interface TrendInfo {
  deltaScore: number;
  deltaCritical: number;
  direction: TrendDirection;
}

// ——— Maturity ———————————————————————————————————————————————

export type MaturityLevel = "legacy" | "growing" | "mature";

export interface MaturityInfo {
  level: MaturityLevel;
  avgScore: number;
  avgTotalMutants: number;
  criticalFreeRuns: number;
  totalRuns: number;
  neverRegressing: boolean;
}

// ——— Policy Result ——————————————————————————————————————————

/** Typed blocking reason for T6 traceability */
export type BlockingReason =
  | "baseline-regression"
  | "global-threshold"
  | "core-threshold"
  | "critical-survivor"
  | null;

export interface PolicyDecision {
  blocking: boolean;
  wouldBlockInEnforce: boolean;
  blockingReason: BlockingReason;
  reason?: string;
}

// ——— Final Output ———————————————————————————————————————————

/** Complete T5-EL output — consumed by T6 */
export interface FinalT5Result {
  mode: MutationMode;
  /** Actual policy applied (may differ from mode in adaptive) */
  policyApplied: MutationMode;
  baselineActive: boolean;
  maturityLevel: MaturityLevel;
  rawScore: number | null;
  adjustedScore: number | null;
  deltaScore: number | null;
  trend: TrendDirection | null;
  criticalSurvivors: MutantDetail[];
  blocking: boolean;
  /** Typed reason for T6 traceability */
  blockingReason: BlockingReason;
  wouldBlockInEnforce: boolean;
  /** Whether dirty state was auto-recovered before processing */
  recoveredFromDirtyState: boolean;
  recommendation?: string;
  /** Raw engine result (for T6 deep inspection) */
  engineResult: T5Result;
  /** Module-level scores */
  moduleScores: Record<string, number>;
  /** Hash integrity passed */
  hashVerified: boolean;
  /** FIX 10: Whether baseline has drifted too far from current score */
  baselineDrifted: boolean;
  /** FIX 12: Whether mutant volume dropped suspiciously */
  volumeDriftSuspicious: boolean;
  /** FIX 13: Whether policy decision is internally consistent */
  policyConsistent: boolean;
  /** History integrity: 'healthy' if <20% invalid artifacts, 'degraded' otherwise */
  historyIntegrity: HistoryIntegrity;
}

/** History integrity status based on invalid artifact ratio */
export type HistoryIntegrity = "healthy" | "degraded";

/** Result of loading history with integrity assessment */
export interface HistoryLoadResult {
  runs: MutationRun[];
  totalFiles: number;
  invalidCount: number;
  integrity: HistoryIntegrity;
}

// ——— EL Dependencies ————————————————————————————————————————

/** DI interface for Evolution Layer I/O */
export interface T5ELDeps {
  /** Read a file as string (returns null if not found) */
  readFile(path: string): Promise<string | null>;
  /** Write content to a file (creates dirs as needed) */
  writeFile(path: string, content: string): Promise<void>;
  /** List files in a directory (returns [] if dir doesn't exist) */
  listDir(dir: string): Promise<string[]>;
  /** Get current commit hash */
  getCommitHash(): Promise<string>;
  /** Get current branch name */
  getBranch(): Promise<string>;
  /** Get T4 pass streak count */
  getT4PassStreak(): Promise<number>;
  /** Attempt to restore a file via git checkout (returns true if success) */
  restoreFile(path: string): Promise<boolean>;
  /** Delete a file */
  deleteFile(path: string): Promise<void>;
  /** Logging */
  log(msg: string): void;
}

// ——— EL Config ——————————————————————————————————————————————

export interface T5ELConfig {
  /** Policy mode */
  mode: MutationMode;
  /** Directory for mutation history artifacts */
  historyDir: string;
  /** Path to baseline file */
  baselinePath: string;
  /** Min global score for enforce mode */
  globalMinScore: number;
  /** Min core module score for enforce mode */
  coreMinScore: number;
  /** Number of runs to evaluate maturity */
  maturityWindowSize: number;
  /** Min avg score for mature classification */
  maturityMinAvgScore: number;
  /** Min T4 streak for mature */
  maturityMinT4Streak: number;
  /** Max history artifacts to keep (prune oldest beyond this) */
  maxHistoryEntries: number;
  /** Min avg total mutants for mature classification */
  minMutationVolume: number;
}

export const DEFAULT_T5EL_CONFIG: T5ELConfig = {
  mode: "report",
  historyDir: ".mutation-history",
  baselinePath: ".mutation-baseline.json",
  globalMinScore: 65,
  coreMinScore: 55,
  maturityWindowSize: 5,
  maturityMinAvgScore: 70,
  maturityMinT4Streak: 5,
  maxHistoryEntries: 100,
  minMutationVolume: 30,
};

/** Result of auto-baseline creation attempt */
export interface AutoBaselineResult {
  baseline: MutationBaseline | null;
  baselineLockActivated: boolean;
}

// ——— Helpers ————————————————————————————————————————————————

/** Convert engine MutantResult[] to MutantDetail[] for persistence */
export function toMutantDetails(results: MutantResult[]): MutantDetail[] {
  return results
    .filter((r) => r.status === "survived")
    .map((r) => {
      const operatorStr =
        r.mutant.operator.original + "→" + r.mutant.operator.mutated;
      return {
        mutantId: computeMutantId(r.mutant.file, r.mutant.line, operatorStr),
        file: r.mutant.file,
        line: r.mutant.line,
        column: r.mutant.column,
        operator: operatorStr,
        functionName: r.mutant.functionName || "anonymous",
        astNodeKind: r.mutant.astNodeKind || "unknown",
      };
    });
}

/** Compute stable deterministic mutant identity using SHA-1 (collision-resistant) */
export function computeMutantId(
  file: string,
  line: number,
  operator: string,
): string {
  const input = `${file}:${line}:${operator}`;
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/** Convert ModuleScore[] to Record for persistence */
export function toModuleScoreMap(
  scores: ModuleScore[],
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of scores) {
    map[s.file] = s.adjustedScore;
  }
  return map;
}
