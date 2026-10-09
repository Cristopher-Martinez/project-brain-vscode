/**
 * test-pipeline-types.ts — Type definitions for the Universal Testing Pipeline.
 *
 * Shared by extension code (CJS) and referenced conceptually by hook scripts (ESM).
 * Hook scripts read the JSON contract file, not these types directly.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md
 */

// ─── Test Framework ──────────────────────────────────────────

export type TestFramework =
  | "mocha"
  | "jest"
  | "vitest"
  | "ava"
  | "tap"
  | "playwright"
  | "cypress"
  | "pytest"
  | "rspec"
  | "go-test"
  | "cargo-test"
  | "unknown";

// ─── Core Module Typing ─────────────────────────────────────

export type CoreReason =
  | "persistence" // Toca DB/archivos/estado
  | "external-api" // Expone o consume API
  | "auth" // Autenticación/autorización
  | "money" // Transacciones financieras
  | "shared-state" // Estado compartido
  | "user-data"; // Datos personales

export interface CoreModuleEntry {
  path: string;
  reasons: CoreReason[];
  autoDetected: boolean;
}

// ─── Project Test Contract ───────────────────────────────────

export interface ProjectTestContract {
  test: string | null;
  coverage: string | null;
  lint: string | null;
  mutation: string | null;
  framework: TestFramework;
  invariantsPattern: string;
  coreModules: CoreModuleEntry[];
}

// ─── Gate Result (used by T2, T4, T6) ────────────────────────

export interface GateCheck {
  name: string;
  passed: boolean;
  blocking: boolean;
  value?: number;
  threshold?: number;
  explanation: string;
  suggestion?: string;
  location?: {
    file: string;
    line?: number;
    branch?: string;
  };
  invariantId?: string;
  uncoveredInputs?: string[];
}

export interface GateResult {
  level: 1 | 2 | 3;
  passed: boolean;
  checks: GateCheck[];
  consumedFrom?: GateResult;
  duration: number;
  timestamp: number;
}

// ─── Internal Helpers (used by contracts module) ─────────────

export interface PkgJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

export interface DetectedCommands {
  test: string | null;
  coverage: string | null;
  lint: string | null;
  mutation: string | null;
}

export interface ContractCache {
  contract: ProjectTestContract;
  timestamp: number;
  wsRoot: string;
  packageHash?: string;
}

// ——— Invariant System (T1) ————————————————————————————————————

/** Parsed invariant from a test file's JSDoc tags. */
export interface InvariantEntry {
  id: string;
  description: string;
  impact: string;
  file: string;
  line: number;
  testName?: string;
}

/** Classification of an invariant: core blocks merges, non-core is tracked only. */
export type InvariantTier = "core" | "non-core";

/** Invariant record as stored in INVARIANTS.md frontmatter/body. */
export interface InvariantRecord {
  id: string;
  description: string;
  impact: string;
  tier: InvariantTier;
  files: string[];
  addedAt: string;
}

/** Entry logged when an invariant is deleted or modified. */
export interface InvariantHistoryEntry {
  action: "deleted" | "modified" | "added";
  invariantId: string;
  timestamp: string;
  commitHash?: string;
  justification?: string;
  previousValue?: Partial<InvariantRecord>;
}

/** Result of invariant sync: what changed between code and INVARIANTS.md. */
export interface InvariantSyncResult {
  added: InvariantEntry[];
  removed: InvariantRecord[];
  updated: InvariantEntry[];
  total: number;
  coreCount: number;
  warnings: string[];
}

// ——— Fast Gate (T2) ————————————————————————————————————————————

/** Configuration for the fast gate. */
export interface FastGateConfig {
  branchThreshold: number;
  decisionThreshold: number;
  timeout: number;
  maxIterations: number;
}

/** Convergence tracking state across gate iterations. */
export interface ConvergenceState {
  sessionId: string;
  iteration: number;
  previousChecks: GateCheck[];
  improvedChecks: string[];
  stalledChecks: string[];
  startedAt: string;
}

/** Uncovered branch extracted from coverage reports. */
export interface UncoveredBranch {
  file: string;
  line: number;
  branch: string;
  hits: number;
}

/** Parsed coverage summary for a file. */
export interface FileCoverageSummary {
  file: string;
  branchPct: number;
  linePct: number;
  uncoveredBranches: UncoveredBranch[];
}
