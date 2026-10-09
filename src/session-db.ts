/**
 * SessionDB — SQLite-backed storage for session summaries.
 *
 * Replaces the 88+ loose .md files in sessions/ with a single SQLite DB.
 * Uses sql-provider singleton to share WASM with AdminDB.
 *
 * Features:
 *  - CRUD: saveSummary, listSummaries (paginated), getRecentSummaries, searchSummaries
 *  - Backup: auto-backup on init when DB is >24h old (Contra #2)
 *  - Integrity: corrupted DB → restore from .bak → recreate as last resort
 *  - Migration: importFromMarkdown() reads *-summary.md files (idempotent)
 *  - Debounced save: writes to disk at most once per operation
 */

import * as fs from "fs";
import * as path from "path";
import type { Database } from "sql.js";
import { createDatabase, saveDatabase } from "./sql-provider";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SessionSummaryInput {
  date: string; // ISO 8601
  branch: string;
  lastCommit: string;
  summaryMarkdown: string;
  learnings?: string;
  decisions?: string;
}

export interface SessionSummaryRow {
  id: number;
  date: string;
  branch: string;
  lastCommit: string;
  summaryMarkdown: string;
  learnings: string | null;
  decisions: string | null;
  sourceFile: string | null;
  createdAt: string;
}

type LogFn = (msg: string) => void;

// ─── Constants ──────────────────────────────────────────────────────────

const DB_FILENAME = "sessions.sqlite";
const BACKUP_FILENAME = "sessions.sqlite.bak";
const BACKUP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    branch       TEXT NOT NULL DEFAULT '',
    last_commit  TEXT NOT NULL DEFAULT '',
    summary_md   TEXT NOT NULL DEFAULT '',
    learnings    TEXT,
    decisions    TEXT,
    source_file  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_date ON session_summaries(date);
  CREATE INDEX IF NOT EXISTS idx_session_source ON session_summaries(source_file);
`;

// ─── SessionDB class ────────────────────────────────────────────────────

export class SessionDB {
  private db: Database | null = null;
  private readonly memoryPath: string;
  private readonly sessionsDir: string;
  private readonly dbPath: string;
  private readonly bakPath: string;
  private readonly log: LogFn;

  constructor(memoryPath: string, log: LogFn) {
    this.memoryPath = memoryPath;
    this.sessionsDir = path.join(memoryPath, "sessions");
    this.dbPath = path.join(this.sessionsDir, DB_FILENAME);
    this.bakPath = path.join(this.sessionsDir, BACKUP_FILENAME);
    this.log = log;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    // Backup existing DB if older than threshold
    this._maybeBackup();

    // Try to open DB (with corruption recovery)
    try {
      this.db = await createDatabase(this.dbPath);
      this._ensureSchema();
      this._save(); // Persist newly opened DB
    } catch {
      this.log("[SessionDB] Failed to open DB, attempting recovery...");
      await this._recover();
    }
  }

  dispose(): void {
    if (this.db) {
      this._save();
      this.db.close();
      this.db = null;
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────────

  async saveSummary(input: SessionSummaryInput): Promise<void> {
    this._requireDb();
    this.db!.run(
      `INSERT INTO session_summaries (date, branch, last_commit, summary_md, learnings, decisions)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.date,
        input.branch,
        input.lastCommit,
        input.summaryMarkdown,
        input.learnings ?? null,
        input.decisions ?? null,
      ],
    );
    this._save();
  }

  async listSummaries(limit: number, offset = 0): Promise<SessionSummaryRow[]> {
    this._requireDb();
    const stmt = this.db!.prepare(
      "SELECT * FROM session_summaries ORDER BY date DESC LIMIT ? OFFSET ?",
    );
    stmt.bind([limit, offset]);
    const rows: SessionSummaryRow[] = [];
    while (stmt.step()) {
      rows.push(this._mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  async getRecentSummaries(days: number): Promise<SessionSummaryRow[]> {
    this._requireDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffISO = cutoff.toISOString();

    const stmt = this.db!.prepare(
      "SELECT * FROM session_summaries WHERE date >= ? ORDER BY date DESC",
    );
    stmt.bind([cutoffISO]);
    const rows: SessionSummaryRow[] = [];
    while (stmt.step()) {
      rows.push(this._mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  async searchSummaries(query: string): Promise<SessionSummaryRow[]> {
    this._requireDb();
    const pattern = `%${query}%`;
    const stmt = this.db!.prepare(
      `SELECT * FROM session_summaries
       WHERE summary_md LIKE ? OR branch LIKE ? OR learnings LIKE ? OR decisions LIKE ?
       ORDER BY date DESC`,
    );
    stmt.bind([pattern, pattern, pattern, pattern]);
    const rows: SessionSummaryRow[] = [];
    while (stmt.step()) {
      rows.push(this._mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  // ─── Migration ──────────────────────────────────────────────────────

  /**
   * Import existing *-summary.md files into the database.
   * Idempotent: skips files already imported (matched by source_file column).
   * Returns the number of files imported.
   */
  async importFromMarkdown(): Promise<number> {
    this._requireDb();

    if (!fs.existsSync(this.sessionsDir)) return 0;

    const files = fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith("-summary.md"));

    if (files.length === 0) return 0;

    let imported = 0;

    for (const file of files) {
      // Check if already imported
      const existing = this.db!.exec(
        "SELECT 1 FROM session_summaries WHERE source_file = ? LIMIT 1",
        [file],
      );
      if (existing.length > 0 && existing[0].values.length > 0) continue;

      const content = fs.readFileSync(
        path.join(this.sessionsDir, file),
        "utf-8",
      );
      const { date, branch, commit } = this._parseMarkdownHeader(file, content);

      // Extract learnings/decisions sections
      const learnings = this._extractSection(content, "Learnings");
      const decisions =
        this._extractSection(content, "Decisions Made") ||
        this._extractSection(content, "Decisions");

      this.db!.run(
        `INSERT INTO session_summaries (date, branch, last_commit, summary_md, learnings, decisions, source_file)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [date, branch, commit, content, learnings, decisions, file],
      );
      imported++;
    }

    if (imported > 0) {
      this._save();
      this.log(`[SessionDB] Imported ${imported} summary files to SQLite`);
    }
    return imported;
  }

  /**
   * Reconcile: re-import any *-summary.md files that were written as fallback
   * (when SQLite was unavailable mid-session). Idempotent — uses same dedup
   * as importFromMarkdown() via source_file column.
   *
   * Call this periodically (e.g., every 5 min in the flush interval) to
   * automatically recover fallback .md files back into SQLite.
   */
  async reconcile(): Promise<number> {
    return this.importFromMarkdown();
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  private _requireDb(): void {
    if (!this.db) {
      throw new Error("SessionDB not initialized. Call init() first.");
    }
  }

  private _ensureSchema(): void {
    this.db!.exec(CREATE_TABLE_SQL);
  }

  private _save(): void {
    if (this.db) {
      saveDatabase(this.db, this.dbPath);
    }
  }

  private _maybeBackup(): void {
    if (!fs.existsSync(this.dbPath)) return;

    try {
      const stat = fs.statSync(this.dbPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > BACKUP_THRESHOLD_MS) {
        fs.copyFileSync(this.dbPath, this.bakPath);
        this.log("[SessionDB] Created backup (DB older than 24h)");
      }
    } catch (err) {
      this.log(`[SessionDB] Backup check failed: ${err}`);
    }
  }

  private async _recover(): Promise<void> {
    // Try restoring from backup
    if (fs.existsSync(this.bakPath)) {
      this.log("[SessionDB] Attempting restore from .bak...");
      try {
        fs.copyFileSync(this.bakPath, this.dbPath);
        this.db = await createDatabase(this.dbPath);
        this._ensureSchema();
        this._save();
        this.log("[SessionDB] Restored from backup successfully");
        return;
      } catch {
        this.log("[SessionDB] Backup also corrupted, starting fresh");
      }
    }

    // Last resort: delete corrupted file and create fresh
    try {
      fs.unlinkSync(this.dbPath);
    } catch {
      /* ok if missing */
    }
    this.db = await createDatabase(this.dbPath);
    this._ensureSchema();
    this._save();
    this.log("[SessionDB] Created fresh database after recovery");
  }

  private _mapRow(obj: Record<string, unknown>): SessionSummaryRow {
    return {
      id: obj["id"] as number,
      date: obj["date"] as string,
      branch: obj["branch"] as string,
      lastCommit: (obj["last_commit"] as string) || "",
      summaryMarkdown: (obj["summary_md"] as string) || "",
      learnings: (obj["learnings"] as string) ?? null,
      decisions: (obj["decisions"] as string) ?? null,
      sourceFile: (obj["source_file"] as string) ?? null,
      createdAt: (obj["created_at"] as string) || "",
    };
  }

  private _parseMarkdownHeader(
    filename: string,
    content: string,
  ): { date: string; branch: string; commit: string } {
    // Extract date from filename: "2026-02-15_11-30-summary.md" → "2026-02-15_11-30"
    const dateMatch = filename.match(/^(.+)-summary\.md$/);
    const dateStr = dateMatch ? dateMatch[1] : filename;

    // Parse branch from markdown: **Branch**: `master`
    const branchMatch = content.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
    const branch = branchMatch ? branchMatch[1] : "";

    // Parse commit: **Commit**: `abc123`
    const commitMatch = content.match(/\*\*Commit\*\*:\s*`([^`]+)`/);
    const commit = commitMatch ? commitMatch[1] : "";

    return { date: dateStr, branch, commit };
  }

  private _extractSection(content: string, sectionName: string): string | null {
    const regex = new RegExp(
      `## ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
      "i",
    );
    const match = content.match(regex);
    if (!match) return null;
    const text = match[1].trim();
    return text.length > 0 ? text : null;
  }
}
