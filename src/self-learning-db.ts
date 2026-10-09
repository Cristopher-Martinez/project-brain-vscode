/**
 * Self-Learning DB — SQLite-backed storage for indexed repositories.
 *
 * Follows the same pattern as SessionDB: sql-provider singleton,
 * createDatabase/saveDatabase, corruption recovery.
 *
 * @module self-learning-db
 */

import * as fs from "fs";
import * as path from "path";
import type { Database } from "sql.js";
import { log, logError } from "./logger";
import {
  type LocalEmbeddingConfig,
  type LocalEmbeddingProvider,
  type RepoEntry,
  type RepoStatus,
} from "./self-learning-types";
import { createDatabase, saveDatabase } from "./sql-provider";

// ─── Constants ──────────────────────────────────────────────────────────

const DB_FILENAME = "self-learning.sqlite";
const REPOS_DIR = "repos";
const ANALYSIS_DIR = "analysis";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS repos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    source           TEXT NOT NULL,
    source_type      TEXT NOT NULL DEFAULT 'local',
    local_path       TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending',
    chunk_count      INTEGER NOT NULL DEFAULT 0,
    file_count       INTEGER NOT NULL DEFAULT 0,
    embedding_provider TEXT,
    error_message    TEXT,
    last_analysis_model TEXT,
    last_analysis_description TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
  CREATE INDEX IF NOT EXISTS idx_repos_status ON repos(status);

  CREATE TABLE IF NOT EXISTS embedding_config (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    provider  TEXT NOT NULL DEFAULT 'ollama',
    base_url  TEXT NOT NULL DEFAULT 'http://localhost:11434/v1',
    model     TEXT NOT NULL DEFAULT 'nomic-embed-text',
    api_key   TEXT NOT NULL DEFAULT 'ollama'
  );
`;

// ─── SelfLearningDB ─────────────────────────────────────────────────────

export class SelfLearningDB {
  private db: Database | null = null;
  private readonly basePath: string;
  private readonly dbPath: string;
  readonly reposPath: string;
  readonly analysisPath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.dbPath = path.join(basePath, DB_FILENAME);
    this.reposPath = path.join(basePath, REPOS_DIR);
    this.analysisPath = path.join(basePath, ANALYSIS_DIR);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    for (const dir of [this.basePath, this.reposPath, this.analysisPath]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    try {
      this.db = await createDatabase(this.dbPath);
      this.db.run(CREATE_TABLES_SQL);
      this._migrate();
      this._save();
      log("[SelfLearningDB] Initialized");
    } catch (err) {
      logError(`[SelfLearningDB] Init failed: ${err}`);
      // Attempt fresh DB
      this.db = await createDatabase("");
      this.db.run(CREATE_TABLES_SQL);
      this._migrate();
      this._save();
    }
  }

  dispose(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  // ─── Repo CRUD ────────────────────────────────────────────────────

  addRepo(
    name: string,
    source: string,
    sourceType: "github" | "local",
    localPath: string,
  ): RepoEntry {
    this._ensureDb();
    const now = new Date().toISOString();
    this.db!.run(
      `INSERT INTO repos (name, source, source_type, local_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [name, source, sourceType, localPath, now, now],
    );
    this._save();

    const rows = this.db!.exec("SELECT last_insert_rowid() as id");
    const id = rows[0]?.values[0]?.[0] as number;
    return this._buildEntry(
      id,
      name,
      source,
      sourceType,
      localPath,
      "pending",
      0,
      0,
      null,
      null,
      now,
      now,
    );
  }

  getRepo(id: number): RepoEntry | null {
    this._ensureDb();
    const stmt = this.db!.prepare("SELECT * FROM repos WHERE id = ?");
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this._rowToEntry(row);
  }

  getAllRepos(): RepoEntry[] {
    this._ensureDb();
    const results = this.db!.exec(
      "SELECT * FROM repos ORDER BY updated_at DESC",
    );
    if (!results[0]) return [];
    return results[0].values.map((vals) =>
      this._valsToEntry(results[0].columns, vals),
    );
  }

  updateStatus(id: number, status: RepoStatus, error?: string): void {
    this._ensureDb();
    const now = new Date().toISOString();
    this.db!.run(
      `UPDATE repos SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      [status, error ?? null, now, id],
    );
    this._save();
  }

  updateVectorizationResult(
    id: number,
    chunkCount: number,
    fileCount: number,
    provider: LocalEmbeddingProvider,
  ): void {
    this._ensureDb();
    const now = new Date().toISOString();
    this.db!.run(
      `UPDATE repos SET status = 'indexed', chunk_count = ?, file_count = ?,
       embedding_provider = ?, updated_at = ? WHERE id = ?`,
      [chunkCount, fileCount, provider, now, id],
    );
    this._save();
  }

  removeRepo(id: number): void {
    this._ensureDb();
    this.db!.run("DELETE FROM repos WHERE id = ?", [id]);
    this._save();
  }

  // ─── Embedding Config ─────────────────────────────────────────────

  getConfig(): LocalEmbeddingConfig {
    this._ensureDb();
    const result = this.db!.exec("SELECT * FROM embedding_config WHERE id = 1");
    if (!result[0] || result[0].values.length === 0) {
      return {
        provider: "ollama" as LocalEmbeddingProvider,
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        apiKey: "ollama",
      };
    }
    const cols = result[0].columns;
    const vals = result[0].values[0];
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    return {
      provider: row["provider"] as LocalEmbeddingProvider,
      baseUrl: row["base_url"] as string,
      model: row["model"] as string,
      apiKey: row["api_key"] as string,
    };
  }

  saveConfig(config: LocalEmbeddingConfig): void {
    this._ensureDb();
    this.db!.run(
      `INSERT OR REPLACE INTO embedding_config (id, provider, base_url, model, api_key)
       VALUES (1, ?, ?, ?, ?)`,
      [config.provider, config.baseUrl, config.model, config.apiKey],
    );
    this._save();
  }

  // ─── Analysis Config ───────────────────────────────────────────────

  updateAnalysisConfig(
    id: number,
    model: string,
    description: string,
  ): void {
    this._ensureDb();
    const now = new Date().toISOString();
    this.db!.run(
      `UPDATE repos SET last_analysis_model = ?, last_analysis_description = ?,
       updated_at = ? WHERE id = ?`,
      [model, description, now, id],
    );
    this._save();
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private _ensureDb(): void {
    if (!this.db) throw new Error("[SelfLearningDB] Not initialized");
  }

  private _save(): void {
    if (this.db) saveDatabase(this.db, this.dbPath);
  }

  /** Migrate existing DBs: add columns that may not exist yet */
  private _migrate(): void {
    if (!this.db) return;
    const cols = ["last_analysis_model", "last_analysis_description"];
    for (const col of cols) {
      try {
        this.db.run(`ALTER TABLE repos ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists — expected */
      }
    }
  }

  private _buildEntry(
    id: number,
    name: string,
    source: string,
    sourceType: "github" | "local",
    localPath: string,
    status: RepoStatus,
    chunkCount: number,
    fileCount: number,
    embeddingProvider: LocalEmbeddingProvider | null,
    errorMessage: string | null,
    createdAt: string,
    updatedAt: string,
    lastAnalysisModel: string | null = null,
    lastAnalysisDescription: string | null = null,
  ): RepoEntry {
    return {
      id,
      name,
      source,
      sourceType,
      localPath,
      status,
      chunkCount,
      fileCount,
      embeddingProvider,
      errorMessage,
      lastAnalysisModel,
      lastAnalysisDescription,
      createdAt,
      updatedAt,
    };
  }

  private _rowToEntry(row: Record<string, unknown>): RepoEntry {
    return this._buildEntry(
      row["id"] as number,
      row["name"] as string,
      row["source"] as string,
      row["source_type"] as "github" | "local",
      row["local_path"] as string,
      row["status"] as RepoStatus,
      row["chunk_count"] as number,
      row["file_count"] as number,
      (row["embedding_provider"] as LocalEmbeddingProvider) ?? null,
      (row["error_message"] as string) ?? null,
      row["created_at"] as string,
      row["updated_at"] as string,
      (row["last_analysis_model"] as string) ?? null,
      (row["last_analysis_description"] as string) ?? null,
    );
  }

  private _valsToEntry(cols: string[], vals: unknown[]): RepoEntry {
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    return this._rowToEntry(row);
  }
}
