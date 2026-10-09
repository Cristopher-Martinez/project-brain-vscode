/**
 * MemoryHistory -- Version tracking for memory operations
 * Inspired by mem0's HistoryManager
 *
 * Tracks every add, update, delete operation on memory with timestamps.
 * Stored as append-only JSON log in ~/.mcp-rag-docs/<projectId>.history.json
 * Enables: undo, audit trail, change frequency analysis, memory decay detection.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ============================================================================
//  Types
// ============================================================================

export type HistoryAction = "add" | "update" | "delete" | "merge" | "graph_add" | "graph_delete" | "graph_invalidate";

export interface HistoryEntry {
  id: string;
  action: HistoryAction;
  timestamp: number;
  /** What was affected (file path, chunk id, entity name, etc.) */
  target: string;
  /** Human-readable summary of what happened */
  summary: string;
  /** Optional: previous value hash (for updates) */
  previousHash?: string;
  /** Optional: new value hash */
  newHash?: string;
  /** Optional: which file triggered this change */
  sourceFile?: string;
  /** Optional: metadata */
  metadata?: Record<string, unknown>;
}

export interface HistoryLog {
  projectId: string;
  entries: HistoryEntry[];
  stats: {
    totalOps: number;
    adds: number;
    updates: number;
    deletes: number;
    merges: number;
    graphOps: number;
    firstEntry: number;
    lastEntry: number;
  };
}

// ============================================================================
//  MemoryHistory class
// ============================================================================

const DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".mcp-rag-docs",
);

export class MemoryHistory {
  private projectId: string;
  private entries: HistoryEntry[] = [];
  private maxEntries: number;
  private dirty: boolean = false;

  constructor(projectId: string, maxEntries: number = 5000) {
    this.projectId = projectId;
    this.maxEntries = maxEntries;
  }

  // -- Record operations ----------------------------------------------------

  /** Record an add operation */
  recordAdd(target: string, summary: string, opts?: Partial<HistoryEntry>): HistoryEntry {
    return this.record("add", target, summary, opts);
  }

  /** Record an update operation */
  recordUpdate(
    target: string,
    summary: string,
    previousHash?: string,
    newHash?: string,
    opts?: Partial<HistoryEntry>,
  ): HistoryEntry {
    return this.record("update", target, summary, { ...opts, previousHash, newHash });
  }

  /** Record a delete operation */
  recordDelete(target: string, summary: string, opts?: Partial<HistoryEntry>): HistoryEntry {
    return this.record("delete", target, summary, opts);
  }

  /** Record a merge (dedup) operation */
  recordMerge(target: string, summary: string, opts?: Partial<HistoryEntry>): HistoryEntry {
    return this.record("merge", target, summary, opts);
  }

  /** Record a graph operation */
  recordGraphOp(
    action: "graph_add" | "graph_delete",
    target: string,
    summary: string,
    opts?: Partial<HistoryEntry>,
  ): HistoryEntry {
    return this.record(action, target, summary, opts);
  }

  /** Core record function */
  private record(
    action: HistoryAction,
    target: string,
    summary: string,
    opts?: Partial<HistoryEntry>,
  ): HistoryEntry {
    const entry: HistoryEntry = {
      id: createHash("md5")
        .update(action + target + Date.now().toString() + Math.random().toString())
        .digest("hex")
        .slice(0, 12),
      action,
      timestamp: Date.now(),
      target,
      summary,
      ...opts,
    };

    this.entries.push(entry);
    this.dirty = true;

    // Trim if over max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    return entry;
  }

  // -- Query operations -----------------------------------------------------

  /** Get recent history entries */
  getRecent(limit: number = 20): HistoryEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /** Get history for a specific target */
  getForTarget(target: string): HistoryEntry[] {
    const targetLower = target.toLowerCase();
    return this.entries.filter(
      (e) => e.target.toLowerCase().includes(targetLower),
    );
  }

  /** Get history by action type */
  getByAction(action: HistoryAction): HistoryEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  /** Get entries between two timestamps */
  getInRange(start: number, end: number): HistoryEntry[] {
    return this.entries.filter(
      (e) => e.timestamp >= start && e.timestamp <= end,
    );
  }

  /** Get change frequency: which targets change most often */
  getHotspots(limit: number = 10): Array<{ target: string; changes: number; lastChanged: number }> {
    const freq = new Map<string, { count: number; last: number }>();

    for (const entry of this.entries) {
      const existing = freq.get(entry.target);
      if (existing) {
        existing.count++;
        existing.last = Math.max(existing.last, entry.timestamp);
      } else {
        freq.set(entry.target, { count: 1, last: entry.timestamp });
      }
    }

    return Array.from(freq.entries())
      .map(([target, data]) => ({
        target,
        changes: data.count,
        lastChanged: data.last,
      }))
      .sort((a, b) => b.changes - a.changes)
      .slice(0, limit);
  }

  /** Detect stale memory: files that haven't been updated in a while */
  getStaleTargets(staleThresholdMs: number = 30 * 24 * 60 * 60 * 1000): Array<{ target: string; lastChanged: number; daysSinceUpdate: number }> {
    const lastUpdate = new Map<string, number>();

    for (const entry of this.entries) {
      const existing = lastUpdate.get(entry.target) || 0;
      if (entry.timestamp > existing) {
        lastUpdate.set(entry.target, entry.timestamp);
      }
    }

    const now = Date.now();
    return Array.from(lastUpdate.entries())
      .filter(([, ts]) => now - ts > staleThresholdMs)
      .map(([target, ts]) => ({
        target,
        lastChanged: ts,
        daysSinceUpdate: Math.floor((now - ts) / (24 * 60 * 60 * 1000)),
      }))
      .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  }

  /** Get computed stats */
  getStats(): HistoryLog["stats"] {
    const stats = {
      totalOps: this.entries.length,
      adds: 0,
      updates: 0,
      deletes: 0,
      merges: 0,
      graphOps: 0,
      firstEntry: this.entries.length > 0 ? this.entries[0].timestamp : 0,
      lastEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : 0,
    };

    for (const e of this.entries) {
      switch (e.action) {
        case "add": stats.adds++; break;
        case "update": stats.updates++; break;
        case "delete": stats.deletes++; break;
        case "merge": stats.merges++; break;
        case "graph_add":
        case "graph_delete": stats.graphOps++; break;
      }
    }

    return stats;
  }

  // -- Persistence -----------------------------------------------------------

  /** Save history to disk */
  save(): void {
    if (!this.dirty && this.entries.length === 0) return;

    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    const historyPath = join(DATA_DIR, this.projectId + ".history.json");
    const payload: HistoryLog = {
      projectId: this.projectId,
      entries: this.entries,
      stats: this.getStats(),
    };

    writeFileSync(historyPath, JSON.stringify(payload, null, 2));
    this.dirty = false;
  }

  /** Load history from disk */
  load(): boolean {
    const historyPath = join(DATA_DIR, this.projectId + ".history.json");
    if (!existsSync(historyPath)) return false;

    try {
      const data = JSON.parse(readFileSync(historyPath, "utf-8")) as HistoryLog;
      if (data.entries && Array.isArray(data.entries)) {
        this.entries = data.entries;
        return true;
      }
    } catch {
      // corrupted file, start fresh
    }

    return false;
  }

  /** Clear all history */
  reset(): void {
    this.entries = [];
    this.dirty = true;
  }
}

// ============================================================================
//  Formatting
// ============================================================================

export function formatHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) return "No history entries found.";

  const lines: string[] = ["**Memory History:**\n"];

  for (const e of entries) {
    const date = new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " ");
    const icon = getActionIcon(e.action);
    lines.push(icon + " `" + date + "` **" + e.action.toUpperCase() + "** " + e.target);
    lines.push("  " + e.summary);
    if (e.sourceFile) {
      lines.push("  _Source: " + e.sourceFile + "_");
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatHistoryStats(stats: HistoryLog["stats"]): string {
  const lines = [
    "**Memory History Stats:**",
    "- Total operations: " + stats.totalOps,
    "- Adds: " + stats.adds,
    "- Updates: " + stats.updates,
    "- Deletes: " + stats.deletes,
    "- Merges: " + stats.merges,
    "- Graph ops: " + stats.graphOps,
  ];

  if (stats.firstEntry > 0) {
    lines.push("- First entry: " + new Date(stats.firstEntry).toISOString());
    lines.push("- Last entry: " + new Date(stats.lastEntry).toISOString());

    const daySpan = Math.ceil((stats.lastEntry - stats.firstEntry) / (24 * 60 * 60 * 1000));
    if (daySpan > 0) {
      lines.push("- Avg ops/day: " + (stats.totalOps / daySpan).toFixed(1));
    }
  }

  return lines.join("\n");
}

export function formatHotspots(hotspots: Array<{ target: string; changes: number; lastChanged: number }>): string {
  if (hotspots.length === 0) return "No hotspots detected.";

  const lines = ["**Memory Hotspots** (most frequently changed):\n"];
  for (const h of hotspots) {
    const ago = Math.floor((Date.now() - h.lastChanged) / (60 * 60 * 1000));
    const agoStr = ago < 24 ? ago + "h ago" : Math.floor(ago / 24) + "d ago";
    lines.push("- **" + h.target + "**: " + h.changes + " changes (last: " + agoStr + ")");
  }

  return lines.join("\n");
}

function getActionIcon(action: HistoryAction): string {
  switch (action) {
    case "add": return "+";
    case "update": return "~";
    case "delete": return "-";
    case "merge": return "M";
    case "graph_add": return "G+";
    case "graph_delete": return "G-";
    default: return "?";
  }
}