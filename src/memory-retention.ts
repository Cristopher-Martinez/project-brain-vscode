/**
 * memory-retention.ts — Automatic memory retention system
 *
 * Prevents unbounded growth of conversations/, sessions/, and auto-summaries
 * in .project-brain/memory/. Runs on extension activation (background, non-blocking).
 *
 * Three retention policies:
 *   1. conversations/ — keep max N most recent files
 *   2. sessions/      — keep max N most recent files
 *   3. 04_LEARNINGS.md auto-summaries — prune entries older than N days
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RetentionConfig {
  maxConversations: number;
  maxSessions: number;
  autoSummaryMaxAgeDays: number;
}

export interface RetentionResult {
  conversationsDeleted: number;
  sessionsDeleted: number;
  summariesPruned: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RetentionConfig = {
  maxConversations: 20,
  maxSessions: 30,
  autoSummaryMaxAgeDays: 60,
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run memory retention cleanup. Safe to call on every activation —
 * skips silently if nothing to do.
 */
export async function runRetention(
  memoryDir: string,
  config?: Partial<RetentionConfig>,
): Promise<RetentionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const result: RetentionResult = {
    conversationsDeleted: 0,
    sessionsDeleted: 0,
    summariesPruned: 0,
  };

  try {
    result.conversationsDeleted = purgeOldFiles(
      path.join(memoryDir, "conversations"),
      cfg.maxConversations,
      "conversations",
    );
  } catch (err) {
    logWarn(`[Retention] conversations cleanup failed: ${err}`);
  }

  try {
    result.sessionsDeleted = purgeOldFiles(
      path.join(memoryDir, "sessions"),
      cfg.maxSessions,
      "sessions",
    );
  } catch (err) {
    logWarn(`[Retention] sessions cleanup failed: ${err}`);
  }

  try {
    result.summariesPruned = pruneOldAutoSummaries(
      path.join(memoryDir, "04_LEARNINGS.md"),
      cfg.autoSummaryMaxAgeDays,
    );
  } catch (err) {
    logWarn(`[Retention] auto-summary pruning failed: ${err}`);
  }

  const total =
    result.conversationsDeleted +
    result.sessionsDeleted +
    result.summariesPruned;

  if (total > 0) {
    log(
      `[Retention] Cleanup complete: ` +
        `${result.conversationsDeleted} conversations, ` +
        `${result.sessionsDeleted} sessions deleted, ` +
        `${result.summariesPruned} auto-summaries pruned`,
    );
  }

  return result;
}

// ─── File purge (conversations, sessions) ────────────────────────────────────

function purgeOldFiles(dir: string, maxFiles: number, label: string): number {
  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir);
  const mdFiles = entries
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
    .map((f) => {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      return { name: f, path: fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  if (mdFiles.length <= maxFiles) return 0;

  const toDelete = mdFiles.slice(maxFiles);
  let deleted = 0;

  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.path);
      deleted++;
    } catch (err) {
      logWarn(`[Retention] Failed to delete ${label}/${file.name}: ${err}`);
    }
  }

  log(`[Retention] ${label}: deleted ${deleted} files (kept ${maxFiles})`);
  return deleted;
}

// ─── Auto-summary pruning (04_LEARNINGS.md) ─────────────────────────────────

interface LearningSection {
  startLine: number;
  endLine: number;
  isAutoSummary: boolean;
  date: Date | null;
}

function pruneOldAutoSummaries(
  learningsPath: string,
  maxAgeDays: number,
): number {
  if (!fs.existsSync(learningsPath)) return 0;

  const content = fs.readFileSync(learningsPath, "utf-8");
  const lines = content.split("\n");

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  const sections = parseSections(lines);

  // Find auto-summaries older than cutoff
  const toRemove = sections.filter(
    (s) => s.isAutoSummary && s.date && s.date < cutoffDate,
  );

  if (toRemove.length === 0) return 0;

  // Build set of lines to remove
  const linesToRemove = new Set<number>();
  for (const section of toRemove) {
    for (let i = section.startLine; i <= section.endLine; i++) {
      linesToRemove.add(i);
    }
  }

  // Rebuild file without pruned sections
  const newLines = lines.filter((_, i) => !linesToRemove.has(i));
  fs.writeFileSync(learningsPath, newLines.join("\n"), "utf-8");

  log(
    `[Retention] Pruned ${toRemove.length} auto-summaries ` +
      `older than ${maxAgeDays} days from 04_LEARNINGS.md`,
  );
  return toRemove.length;
}

function parseSections(lines: string[]): LearningSection[] {
  const sections: LearningSection[] = [];
  let current: Omit<LearningSection, "endLine"> | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (current) {
        sections.push({ ...current, endLine: i - 1 });
      }
      const isAutoSummary = lines[i].startsWith("## Auto-Summary");
      const date = extractDateFromLine(lines[i]);
      current = { startLine: i, isAutoSummary, date };
    }
  }

  if (current) {
    sections.push({ ...current, endLine: lines.length - 1 });
  }

  return sections;
}

/**
 * Extract date from H2 like "## Auto-Summary (2026-02-22_18-10)"
 * or from "## Something (2026-02-22)"
 */
function extractDateFromLine(line: string): Date | null {
  const match = line.match(/\((\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return isNaN(parsed.getTime()) ? null : parsed;
}
