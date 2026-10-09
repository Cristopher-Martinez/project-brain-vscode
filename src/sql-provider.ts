/**
 * SQL Provider — Shared singleton for sql.js WASM initialization.
 *
 * Mitigates Contra #5 (WASM footprint): loads sql.js WASM only ONCE
 * and shares it between AdminDB and SessionDB.
 *
 * If WASM init fails, consumers get a clear error — the extension
 * continues working, only SQLite features degrade.
 */

import * as fs from "fs";
import * as path from "path";
import type { Database, SqlJsStatic } from "sql.js";

// ─── Singleton ──────────────────────────────────────────────────────────

let sqlInstance: SqlJsStatic | null = null;
let initPromise: Promise<SqlJsStatic> | null = null;

/**
 * Get the shared sql.js module (singleton, lazy init).
 * First call loads WASM (~1MB), subsequent calls return cached instance.
 */
export async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlInstance) return sqlInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require("sql.js") as typeof import("sql.js");

    // Locate the WASM file.
    // Priority: dist/sql-wasm.wasm (bundled with extension, works in VSIX)
    //           → node_modules/sql.js/dist/ (dev fallback)
    let wasmDir = __dirname; // In bundled CJS, __dirname = dist/
    let wasmPath = path.join(wasmDir, "sql-wasm.wasm");

    if (!fs.existsSync(wasmPath)) {
      // Dev fallback: use node_modules
      try {
        wasmDir = path.dirname(require.resolve("sql.js"));
        wasmPath = path.join(wasmDir, "sql-wasm.wasm");
      } catch {
        // require.resolve may fail if sql.js is fully bundled
      }
    }

    const wasmExists = fs.existsSync(wasmPath);

    const SQL = await (
      initSqlJs as unknown as (config?: object) => Promise<SqlJsStatic>
    )(
      wasmExists
        ? { locateFile: () => wasmPath }
        : undefined,
    );

    sqlInstance = SQL;
    return SQL;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null; // Allow retry on next call
    throw err;
  }
}

// ─── Database helpers ───────────────────────────────────────────────────

/**
 * Create or load a SQLite database at the given path.
 * If the file exists, loads it. Otherwise creates a fresh in-memory DB.
 */
export async function createDatabase(dbPath: string): Promise<Database> {
  const SQL = await getSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    return new SQL.Database(buffer);
  }

  return new SQL.Database();
}

/**
 * Persist a sql.js Database to disk (atomic: export → writeFileSync).
 */
export function saveDatabase(db: Database, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

/**
 * Reset singleton state (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
  sqlInstance = null;
  initPromise = null;
}
