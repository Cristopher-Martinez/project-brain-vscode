/**
 * T6.1 — Shared Test Helpers
 *
 * DRY factory functions for all T6.1 test files.
 * Provides in-memory SQLite simulation via T61Deps.
 */

import type {
  ModelCommit,
  ModelCohort,
  T61Deps,
  T61Config,
  CorrectionCycle,
} from "./test-gate-t61-types";
import { DEFAULT_T61_CONFIG } from "./test-gate-t61-types";

// ─── In-Memory DB Simulation ────────────────────────────────────────

interface InMemoryRow {
  [key: string]: unknown;
}

/**
 * Create an in-memory T61Deps that simulates SQLite behavior.
 * Tables are stored as arrays in a Map. Supports basic INSERT, SELECT, UPDATE.
 */
export function makeT61Deps(
  overrides: Partial<T61Deps> = {},
): T61Deps & { tables: Map<string, InMemoryRow[]> } {
  const tables = new Map<string, InMemoryRow[]>();
  const logs: string[] = [];

  const deps: T61Deps & { tables: Map<string, InMemoryRow[]>; logs: string[] } = {
    tables,
    logs,
    dbRun: (sql: string, params?: unknown[]) => {
      // Handle CREATE TABLE
      const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (createMatch) {
        const tableName = createMatch[1];
        if (!tables.has(tableName)) {
          tables.set(tableName, []);
        }
        return;
      }
      // Handle INSERT OR IGNORE
      if (sql.includes("INSERT OR IGNORE")) {
        handleInsertOrIgnore(tables, sql, params);
        return;
      }
      // Handle INSERT OR REPLACE
      if (sql.includes("INSERT OR REPLACE")) {
        handleInsertOrReplace(tables, sql, params);
        return;
      }
      // Handle plain INSERT
      if (sql.match(/^INSERT INTO/i)) {
        handleInsert(tables, sql, params);
        return;
      }
      // Handle CREATE INDEX (no-op)
      if (sql.match(/CREATE INDEX/i)) return;
    },
    dbAll: <T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] => {
      return handleSelect(tables, sql, params) as T[];
    },
    dbGet: <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): T | undefined => {
      const rows = handleSelect(tables, sql, params);
      return (rows[0] as T) ?? undefined;
    },
    log: (msg: string) => {
      logs.push(msg);
    },
    ...overrides,
  };

  return deps;
}

// ─── SQL Parsing Helpers ────────────────────────────────────────────

function getTableName(sql: string): string {
  const match = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
  return match?.[1] ?? "";
}

function getColumnNames(sql: string): string[] {
  const match = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (!match) return [];
  return match[1].split(",").map((c) => c.trim());
}

function handleInsert(
  tables: Map<string, InMemoryRow[]>,
  sql: string,
  params?: unknown[],
): void {
  const tableName = getTableName(sql);
  const columns = getColumnNames(sql);
  const table = tables.get(tableName) ?? [];

  const row: InMemoryRow = {};
  columns.forEach((col, i) => {
    row[col] = params?.[i] ?? null;
  });

  // Auto-increment ID for tables with autoincrement
  if (!row["id"] && sql.includes("AUTOINCREMENT")) {
    row["id"] = table.length + 1;
  }

  table.push(row);
  tables.set(tableName, table);
}

function handleInsertOrIgnore(
  tables: Map<string, InMemoryRow[]>,
  sql: string,
  params?: unknown[],
): void {
  const tableName = getTableName(sql);
  const columns = getColumnNames(sql);
  const table = tables.get(tableName) ?? [];

  // Find PK column (first column)
  const pkCol = columns[0];
  const pkVal = params?.[0];

  const exists = table.some((r) => r[pkCol] === pkVal);
  if (exists) return;

  handleInsert(tables, sql.replace("OR IGNORE", ""), params);
}

function handleInsertOrReplace(
  tables: Map<string, InMemoryRow[]>,
  sql: string,
  params?: unknown[],
): void {
  const tableName = getTableName(sql);
  const columns = getColumnNames(sql);
  const table = tables.get(tableName) ?? [];

  // For composite PK (model_cohorts): model_id + cohort_index
  const row: InMemoryRow = {};
  columns.forEach((col, i) => {
    row[col] = params?.[i] ?? null;
  });

  // Remove existing row with same PK
  const filtered = table.filter((r) => {
    if (tableName === "model_cohorts") {
      return !(r.model_id === row.model_id && r.cohort_index === row.cohort_index);
    }
    return r[columns[0]] !== row[columns[0]];
  });

  filtered.push(row);
  tables.set(tableName, filtered);
}

function handleSelect(
  tables: Map<string, InMemoryRow[]>,
  sql: string,
  params?: unknown[],
): InMemoryRow[] {
  const tableName = getTableName(sql);
  let rows = [...(tables.get(tableName) ?? [])];

  // Handle WHERE clauses
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i);
  if (whereMatch) {
    rows = applyWhere(rows, whereMatch[1], params);
  }

  // Handle ORDER BY
  const orderMatch = sql.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
  if (orderMatch) {
    const col = orderMatch[1];
    const desc = orderMatch[2]?.toUpperCase() === "DESC";
    rows.sort((a, b) => {
      const va = a[col] as number;
      const vb = b[col] as number;
      return desc ? vb - va : va - vb;
    });
  }

  // Handle LIMIT
  const limitMatch = sql.match(/LIMIT\s+(\?|\d+)/i);
  if (limitMatch) {
    const limitVal = limitMatch[1] === "?" 
      ? (params?.[params.length - 1] as number) 
      : parseInt(limitMatch[1]);
    rows = rows.slice(0, limitVal);
  }

  // Handle COUNT(*)
  if (sql.includes("COUNT(*)")) {
    return [{ cnt: rows.length }];
  }

  // Handle MAX()
  const maxMatch = sql.match(/MAX\((\w+)\)\s+as\s+(\w+)/i);
  if (maxMatch) {
    const col = maxMatch[1];
    const alias = maxMatch[2];
    if (rows.length === 0) return [{ [alias]: null }];
    const maxVal = Math.max(...rows.map((r) => r[col] as number));
    return [{ [alias]: maxVal }];
  }

  // Handle DISTINCT
  if (sql.includes("DISTINCT")) {
    const colMatch = sql.match(/DISTINCT\s+(\w+)/i);
    if (colMatch) {
      const col = colMatch[1];
      const seen = new Set<unknown>();
      rows = rows.filter((r) => {
        if (seen.has(r[col])) return false;
        seen.add(r[col]);
        return true;
      });
    }
  }

  return rows;
}

function applyWhere(
  rows: InMemoryRow[],
  whereClause: string,
  params?: unknown[],
): InMemoryRow[] {
  // Parse AND-separated conditions
  const conditions = whereClause.split(/\s+AND\s+/i);

  return rows.filter((row) => {
    let localIdx = 0; // Reset per row — same params apply to every row
    return conditions.every((cond) => {
      const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
      if (eqMatch) {
        const col = eqMatch[1];
        const val = params?.[localIdx++];
        return row[col] === val;
      }
      // Handle literal values: col = 1, col = 0, col = 'value'
      const litMatch = cond.match(/(\w+)\s*=\s*(\d+|'[^']*')/);
      if (litMatch) {
        const col = litMatch[1];
        const raw = litMatch[2];
        // SQLite treats 1/0 as boolean true/false
        if (raw === "1") return row[col] === true || row[col] === 1;
        if (raw === "0") return row[col] === false || row[col] === 0;
        // String literal
        if (raw.startsWith("'")) return row[col] === raw.slice(1, -1);
        // Numeric literal
        return row[col] === parseInt(raw);
      }
      return true;
    });
  });
}

// ─── Factory Functions ──────────────────────────────────────────────

export function makeCommit(
  overrides: Partial<ModelCommit> = {},
): ModelCommit {
  return {
    commitHash: "abc123",
    modelId: "gpt-4",
    timestamp: new Date().toISOString(),
    linesAdded: 50,
    linesRemoved: 10,
    filesModified: ["src/foo.ts"],
    ...overrides,
  };
}

export function makeCohort(
  overrides: Partial<ModelCohort> = {},
): ModelCohort {
  return {
    modelId: "gpt-4",
    cohortIndex: 0,
    commits: [],
    accumulatedWeight: 0,
    rawScoreAvg: 0,
    adjustedScoreAvg: 0,
    totalMutants: 0,
    survived: 0,
    criticalSurvivors: 0,
    structuralViolations: 0,
    correctionCycles: 0,
    reliabilityIndex: null,
    confidenceLevel: "insufficient-data",
    volatilityFlag: false,
    stabilityStatus: "insufficient-data" as const,
    closed: false,
    ...overrides,
  };
}

export function makeT61Config(
  overrides: Partial<T61Config> = {},
): T61Config {
  return { ...DEFAULT_T61_CONFIG, ...overrides };
}
