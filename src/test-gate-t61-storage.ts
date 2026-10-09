/**
 * T6.1 — Model Telemetry Layer: Storage
 *
 * SQLite schema initialization and CRUD operations for model_commits
 * and model_cohorts tables.
 *
 * Uses T61Deps DI for testability — no direct sql.js dependency.
 */

import type {
  ModelCommit,
  ModelCohort,
  T61Deps,
  CorrectionCycle,
} from "./test-gate-t61-types";

// ─── Schema ─────────────────────────────────────────────────────────

const CREATE_COMMITS_SQL = `
  CREATE TABLE IF NOT EXISTS model_commits (
    commit_hash TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    files_modified TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_mc_model ON model_commits(model_id);
  CREATE INDEX IF NOT EXISTS idx_mc_ts ON model_commits(timestamp);
`;

const CREATE_COHORTS_SQL = `
  CREATE TABLE IF NOT EXISTS model_cohorts (
    model_id TEXT NOT NULL,
    cohort_index INTEGER NOT NULL,
    commits TEXT NOT NULL DEFAULT '[]',
    accumulated_weight INTEGER NOT NULL DEFAULT 0,
    raw_score_avg REAL NOT NULL DEFAULT 0,
    adjusted_score_avg REAL NOT NULL DEFAULT 0,
    total_mutants INTEGER NOT NULL DEFAULT 0,
    survived INTEGER NOT NULL DEFAULT 0,
    critical_survivors INTEGER NOT NULL DEFAULT 0,
    structural_violations INTEGER NOT NULL DEFAULT 0,
    correction_cycles INTEGER NOT NULL DEFAULT 0,
    reliability_index REAL DEFAULT NULL,
    confidence_level TEXT NOT NULL DEFAULT 'insufficient-data',
    volatility_flag INTEGER NOT NULL DEFAULT 0,
    stability_status TEXT NOT NULL DEFAULT 'insufficient-data',
    closed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (model_id, cohort_index)
  );
`;

const CREATE_CORRECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS model_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corrector_commit TEXT NOT NULL,
    corrector_model TEXT NOT NULL,
    target_model TEXT NOT NULL,
    target_cohort_index INTEGER NOT NULL,
    reduced_metrics TEXT NOT NULL DEFAULT '[]',
    timestamp TEXT NOT NULL
  );
`;

// ─── Init ───────────────────────────────────────────────────────────

/** Initialize T6.1 SQLite tables. Idempotent. */
export function initT61Schema(deps: T61Deps): void {
  deps.dbRun(CREATE_COMMITS_SQL);
  deps.dbRun(CREATE_COHORTS_SQL);
  deps.dbRun(CREATE_CORRECTIONS_SQL);
  deps.log("[T6.1-Storage] Schema initialized");
}

// ─── Commits CRUD ───────────────────────────────────────────────────

/** Insert a model commit. Skips if already exists. */
export function insertCommit(deps: T61Deps, commit: ModelCommit): void {
  deps.dbRun(
    `INSERT OR IGNORE INTO model_commits
     (commit_hash, model_id, timestamp, lines_added, lines_removed, files_modified)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      commit.commitHash,
      commit.modelId,
      commit.timestamp,
      commit.linesAdded,
      commit.linesRemoved,
      JSON.stringify(commit.filesModified),
    ],
  );
}

/** Get a commit by hash. */
export function getCommit(
  deps: T61Deps,
  hash: string,
): ModelCommit | undefined {
  const row = deps.dbGet<CommitRow>(
    "SELECT * FROM model_commits WHERE commit_hash = ?",
    [hash],
  );
  return row ? rowToCommit(row) : undefined;
}

/** Get all commits for a model ID. */
export function getCommitsByModel(
  deps: T61Deps,
  modelId: string,
): ModelCommit[] {
  const rows = deps.dbAll<CommitRow>(
    "SELECT * FROM model_commits WHERE model_id = ? ORDER BY timestamp",
    [modelId],
  );
  return rows.map(rowToCommit);
}

// ─── Cohorts CRUD ───────────────────────────────────────────────────

/** Upsert a cohort (insert or update). */
export function upsertCohort(deps: T61Deps, cohort: ModelCohort): void {
  deps.dbRun(
    `INSERT OR REPLACE INTO model_cohorts
     (model_id, cohort_index, commits, accumulated_weight,
      raw_score_avg, adjusted_score_avg, total_mutants, survived,
      critical_survivors, structural_violations, correction_cycles,
      reliability_index, confidence_level, volatility_flag, stability_status, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cohort.modelId,
      cohort.cohortIndex,
      JSON.stringify(cohort.commits),
      cohort.accumulatedWeight,
      cohort.rawScoreAvg,
      cohort.adjustedScoreAvg,
      cohort.totalMutants,
      cohort.survived,
      cohort.criticalSurvivors,
      cohort.structuralViolations,
      cohort.correctionCycles,
      cohort.reliabilityIndex,
      cohort.confidenceLevel,
      cohort.volatilityFlag ? 1 : 0,
      cohort.stabilityStatus,
      cohort.closed ? 1 : 0,
    ],
  );
}

/** Get the active (open) cohort for a model, or undefined. */
export function getActiveCohort(
  deps: T61Deps,
  modelId: string,
): ModelCohort | undefined {
  const row = deps.dbGet<CohortRow>(
    `SELECT * FROM model_cohorts
     WHERE model_id = ? AND closed = 0
     ORDER BY cohort_index DESC LIMIT 1`,
    [modelId],
  );
  return row ? rowToCohort(row) : undefined;
}

/** Get all closed cohorts for a model, ordered by index. */
export function getClosedCohorts(
  deps: T61Deps,
  modelId: string,
): ModelCohort[] {
  const rows = deps.dbAll<CohortRow>(
    `SELECT * FROM model_cohorts
     WHERE model_id = ? AND closed = 1
     ORDER BY cohort_index`,
    [modelId],
  );
  return rows.map(rowToCohort);
}

/** Get recent cohort weights for dynamic threshold calculation. */
export function getRecentCohortWeights(
  deps: T61Deps,
  modelId: string,
  limit: number,
): number[] {
  const rows = deps.dbAll<{ accumulated_weight: number }>(
    `SELECT accumulated_weight FROM model_cohorts
     WHERE model_id = ? AND closed = 1
     ORDER BY cohort_index DESC LIMIT ?`,
    [modelId, limit],
  );
  return rows.map((r) => r.accumulated_weight);
}

/** Get the next cohort index for a model. */
export function getNextCohortIndex(deps: T61Deps, modelId: string): number {
  const row = deps.dbGet<{ max_idx: number | null }>(
    "SELECT MAX(cohort_index) as max_idx FROM model_cohorts WHERE model_id = ?",
    [modelId],
  );
  return row?.max_idx != null ? row.max_idx + 1 : 0;
}

// ─── Corrections CRUD ───────────────────────────────────────────────

/** Insert a correction cycle record. */
export function insertCorrection(
  deps: T61Deps,
  correction: CorrectionCycle,
): void {
  deps.dbRun(
    `INSERT INTO model_corrections
     (corrector_commit, corrector_model, target_model,
      target_cohort_index, reduced_metrics, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      correction.correctorCommitHash,
      correction.correctorModelId,
      correction.targetCohortModelId,
      correction.targetCohortIndex,
      JSON.stringify(correction.reducedMetrics),
      correction.timestamp,
    ],
  );
}

/** Count correction cycles for a specific cohort. */
export function getCorrectionCount(
  deps: T61Deps,
  modelId: string,
  cohortIndex: number,
): number {
  const row = deps.dbGet<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM model_corrections
     WHERE target_model = ? AND target_cohort_index = ?`,
    [modelId, cohortIndex],
  );
  return row?.cnt ?? 0;
}

/** Get all distinct model IDs from commits. */
export function getDistinctModels(deps: T61Deps): string[] {
  const rows = deps.dbAll<{ model_id: string }>(
    "SELECT DISTINCT model_id FROM model_commits ORDER BY model_id",
  );
  return rows.map((r) => r.model_id);
}

// ─── Row Types (internal) ───────────────────────────────────────────

interface CommitRow {
  commit_hash: string;
  model_id: string;
  timestamp: string;
  lines_added: number;
  lines_removed: number;
  files_modified: string;
}

interface CohortRow {
  model_id: string;
  cohort_index: number;
  commits: string;
  accumulated_weight: number;
  raw_score_avg: number;
  adjusted_score_avg: number;
  total_mutants: number;
  survived: number;
  critical_survivors: number;
  structural_violations: number;
  correction_cycles: number;
  reliability_index: number | null;
  confidence_level: string;
  volatility_flag: number;
  stability_status: string;
  closed: number;
}

// ─── Row Converters ─────────────────────────────────────────────────

function rowToCommit(row: CommitRow): ModelCommit {
  return {
    commitHash: row.commit_hash,
    modelId: row.model_id,
    timestamp: row.timestamp,
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    filesModified: JSON.parse(row.files_modified),
  };
}

function rowToCohort(row: CohortRow): ModelCohort {
  return {
    modelId: row.model_id,
    cohortIndex: row.cohort_index,
    commits: JSON.parse(row.commits),
    accumulatedWeight: row.accumulated_weight,
    rawScoreAvg: row.raw_score_avg,
    adjustedScoreAvg: row.adjusted_score_avg,
    totalMutants: row.total_mutants,
    survived: row.survived,
    criticalSurvivors: row.critical_survivors,
    structuralViolations: row.structural_violations,
    correctionCycles: row.correction_cycles,
    reliabilityIndex: row.reliability_index,
    confidenceLevel: row.confidence_level as ModelCohort["confidenceLevel"],
    volatilityFlag: row.volatility_flag === 1,
    stabilityStatus: row.stability_status as ModelCohort["stabilityStatus"],
    closed: row.closed === 1,
  };
}
