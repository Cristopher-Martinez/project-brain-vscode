/**
 * Admin Database — SQLite-backed skill usage tracking for admin debugging.
 *
 * Uses sql.js (WASM-based SQLite) to avoid native binding issues in VS Code.
 * Database stored at: .project-brain/memory/sessions/admin.sqlite
 *
 * Tables:
 *   skill_executions — who called what skill, when, and what happened
 *
 * Admin-gated: only writes when isAdmin is true.
 */

import * as fs from "fs";
import * as path from "path";
import type { Database } from "sql.js";
import { createDatabase, saveDatabase } from "./sql-provider";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SkillExecution {
  id?: number;
  timestamp?: string;
  skillName: string;
  trigger: SkillTrigger;
  result: SkillResult;
  matchScore?: number;
  query?: string;
  errorMessage?: string;
  durationMs?: number;
  metadata?: string; // JSON string for extra context
}

export type SkillTrigger =
  | "findSkill"
  | "searchMemory"
  | "autoRecall"
  | "postToolHook"
  | "directLoad"
  | "canExecute"
  | "agentRule";

export type SkillResult =
  | "found"
  | "not_found"
  | "executed"
  | "blocked_plan"
  | "error"
  | "injected";

export interface SkillStats {
  skillName: string;
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  blockedCount: number;
  avgDurationMs: number;
  lastUsed: string;
}

export interface RecentExecution {
  id: number;
  timestamp: string;
  skillName: string;
  trigger: string;
  result: string;
  matchScore: number | null;
  query: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

// ─── AdminDB class ─────────────────────────────────────────────────────────

export class AdminDB {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private log: (msg: string) => void;

  constructor(memoryPath: string, log: (msg: string) => void) {
    const sessionsDir = path.join(memoryPath, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    this.dbPath = path.join(sessionsDir, "admin.sqlite");
    this.log = log;
  }

  /** Initialize the database (lazy, called on first operation). */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    try {
      // Use shared singleton WASM provider (sql-provider.ts)
      this.db = await createDatabase(this.dbPath);

      // Create tables
      this.db.run(`
        CREATE TABLE IF NOT EXISTS skill_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          result TEXT NOT NULL,
          match_score REAL,
          query TEXT,
          error_message TEXT,
          duration_ms INTEGER,
          metadata TEXT
        )
      `);

      // Indexes for common queries
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_skill_executions_skill
        ON skill_executions(skill_name)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_skill_executions_timestamp
        ON skill_executions(timestamp DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_skill_executions_result
        ON skill_executions(result)
      `);

      this.initialized = true;
      this.log("[AdminDB] SQLite initialized at " + this.dbPath);
    } catch (err) {
      this.log(`[AdminDB] Init error: ${err}`);
      throw err;
    }
  }

  /** Persist the database to disk. */
  private save(): void {
    if (!this.db) return;
    try {
      saveDatabase(this.db, this.dbPath);
    } catch (err) {
      this.log(`[AdminDB] Save error: ${err}`);
    }
  }

  /** Log a skill execution event. */
  async logExecution(exec: SkillExecution): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      this.db.run(
        `INSERT INTO skill_executions
         (timestamp, skill_name, trigger_type, result, match_score, query, error_message, duration_ms, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          exec.timestamp || new Date().toISOString(),
          exec.skillName,
          exec.trigger,
          exec.result,
          exec.matchScore ?? null,
          exec.query ?? null,
          exec.errorMessage ?? null,
          exec.durationMs ?? null,
          exec.metadata ?? null,
        ],
      );
      this.save();
    } catch (err) {
      this.log(`[AdminDB] logExecution error: ${err}`);
    }
  }

  /** Get recent executions (newest first). */
  async getRecent(limit = 50): Promise<RecentExecution[]> {
    await this.init();
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(
        `SELECT id, timestamp, skill_name as skillName, trigger_type as trigger,
                result, match_score as matchScore, query, error_message as errorMessage,
                duration_ms as durationMs
         FROM skill_executions
         ORDER BY timestamp DESC
         LIMIT ?`,
      );
      stmt.bind([limit]);

      const results: RecentExecution[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as RecentExecution;
        results.push(row);
      }
      stmt.free();
      return results;
    } catch (err) {
      this.log(`[AdminDB] getRecent error: ${err}`);
      return [];
    }
  }

  /** Get aggregated stats per skill. */
  async getSkillStats(): Promise<SkillStats[]> {
    await this.init();
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT
          skill_name as skillName,
          COUNT(*) as totalExecutions,
          SUM(CASE WHEN result IN ('found', 'executed', 'injected') THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END) as errorCount,
          SUM(CASE WHEN result = 'blocked_plan' THEN 1 ELSE 0 END) as blockedCount,
          COALESCE(AVG(duration_ms), 0) as avgDurationMs,
          MAX(timestamp) as lastUsed
        FROM skill_executions
        GROUP BY skill_name
        ORDER BY totalExecutions DESC
      `);

      const results: SkillStats[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as SkillStats;
        results.push(row);
      }
      stmt.free();
      return results;
    } catch (err) {
      this.log(`[AdminDB] getSkillStats error: ${err}`);
      return [];
    }
  }

  /** Get error-only executions. */
  async getErrors(limit = 30): Promise<RecentExecution[]> {
    await this.init();
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(
        `SELECT id, timestamp, skill_name as skillName, trigger_type as trigger,
                result, match_score as matchScore, query, error_message as errorMessage,
                duration_ms as durationMs
         FROM skill_executions
         WHERE result IN ('error', 'blocked_plan', 'not_found')
         ORDER BY timestamp DESC
         LIMIT ?`,
      );
      stmt.bind([limit]);

      const results: RecentExecution[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as RecentExecution;
        results.push(row);
      }
      stmt.free();
      return results;
    } catch (err) {
      this.log(`[AdminDB] getErrors error: ${err}`);
      return [];
    }
  }

  /** Get execution count by trigger type. */
  async getTriggerDistribution(): Promise<
    Array<{ trigger: string; count: number }>
  > {
    await this.init();
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT trigger_type as trigger, COUNT(*) as count
        FROM skill_executions
        GROUP BY trigger_type
        ORDER BY count DESC
      `);

      const results: Array<{ trigger: string; count: number }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as { trigger: string; count: number };
        results.push(row);
      }
      stmt.free();
      return results;
    } catch (err) {
      this.log(`[AdminDB] getTriggerDistribution error: ${err}`);
      return [];
    }
  }

  /** Clear all data (admin action). */
  async clearAll(): Promise<void> {
    await this.init();
    if (!this.db) return;

    this.db.run("DELETE FROM skill_executions");
    this.save();
    this.log("[AdminDB] All data cleared");
  }

  /** Close the database connection. */
  dispose(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
      this.initialized = false;
      this.initPromise = null;
    }
  }
}
