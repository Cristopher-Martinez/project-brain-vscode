/**
 * T6 — Observability & Governance Layer Types
 *
 * T6 is strictly post-evolution. It MUST NOT modify T5 or T5-EL.
 * It MUST NOT recalculate mutation metrics.
 * It only transforms and presents FinalT5Result data.
 */

import type {
  FinalT5Result,
  HistoryIntegrity,
  MaturityLevel,
  MutationBaseline,
  MutationMode,
  MutationRun,
  T5ELConfig,
  TrendDirection,
} from "./test-gate-mutation-el-types";

// ——— Re-exports for T6 consumers ———————————————————————————

export type {
  FinalT5Result,
  HistoryIntegrity,
  MaturityLevel,
  MutationBaseline,
  MutationMode,
  MutationRun,
  TrendDirection,
};

// ——— T6 Protection Summary (T6-2) ——————————————————————————

/** Evidence of protection — no raw mutation scores */
export interface T6ProtectionSummary {
  preventedCriticalErrors: number;
  regressionsBlocked: number;
  tamperingAttemptsDetected: number;
  structuralViolationsBlocked: number;
  integrityState: "clean" | "recovered" | "degraded";
}

// ——— T6 Evolution Summary (T6-3) ———————————————————————————

/** Evolution based strictly on adjustedScore */
export interface T6EvolutionSummary {
  trend: "improving" | "stable" | "regressing";
  maturity: "legacy" | "growing" | "mature";
  scoreDelta: number;
  stabilityIndicator: number;
  volumeHealth: "normal" | "suspicious";
}

// ——— T6 Confidence Model (T6-4) ————————————————————————————

/** Human-readable confidence synthesis */
export interface T6ConfidenceModel {
  confidenceLabel: "low" | "moderate" | "high";
  explanation: string;
  riskFactors: string[];
}

// ——— T6 Governance (T6-5) ——————————————————————————————————

/** Editable governance configuration */
export interface T6GovernanceConfig {
  policyMode: MutationMode;
  globalMinScore: number;
  coreMinScore: number;
  maxMutantsPerFile: number;
  maxTotalMutants: number;
  mutationTimeout: number;
}

/** Preview of governance change impact (T6-6) */
export interface T6GovernanceChangePreview {
  previousDecision: boolean;
  newDecision: boolean;
  warning?: string;
}

// ——— T6 Config Audit Entry (T6-7) ——————————————————————————

/** Append-only config audit trail entry */
export interface T6ConfigAuditEntry {
  timestamp: string;
  previousConfig: T6GovernanceConfig;
  newConfig: T6GovernanceConfig;
  simulatedImpact: T6GovernanceChangePreview;
  user?: string;
}

// ——— Final T6 ViewModel (T6 aggregated output) —————————————

/** Complete T6 view model — consumed by UI */
export interface FinalT6ViewModel {
  protection: T6ProtectionSummary;
  evolution: T6EvolutionSummary;
  confidence: T6ConfidenceModel;
  governance: T6GovernanceConfig;
  historyIntegrity: "healthy" | "degraded";
  advancedMetrics?: {
    rawScore: number | null;
    adjustedScore: number | null;
    deltaScore: number | null;
  };
}

// ——— T6 Preconditions Result (T6-0) ————————————————————————

/** Result of T6 precondition checks */
export interface T6PreconditionResult {
  ready: boolean;
  failures: string[];
}

// ——— T6 Dependencies (DI) ——————————————————————————————————

/** DI interface for T6 I/O operations */
export interface T6Deps {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
  log(msg: string): void;
}

// ——— T6 Config ——————————————————————————————————————————————

/** T6-specific configuration */
export interface T6Config {
  /** Directory for config audit trail */
  configHistoryDir: string;
  /** Path to current governance config file */
  governanceConfigPath: string;
  /** T5-EL config reference (read-only, for simulation) */
  elConfig: T5ELConfig;
  /** Show advanced metrics panel by default */
  showAdvancedMetrics: boolean;
}

// ——— T6 Integrity Result (T6-9) ————————————————————————————

/** Result of T6 integrity cross-check */
export interface T6IntegrityResult {
  baselineValid: boolean;
  corruptArtifacts: number;
  dirtyFiles: boolean;
  overallState: "healthy" | "degraded";
  warnings: string[];
}
