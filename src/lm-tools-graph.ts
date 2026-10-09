/**
 * Graph & History LM Tools — extracted from lm-tools.ts
 *
 * SearchRelationsTool: Knowledge graph queries (entity, query, stats modes)
 * MemoryHistoryTool: Memory file change history (recent, target, hotspots, stale, stats)
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  formatEntityBFS,
  formatGraphStats,
  formatQueryResults,
  parseGraphologyExport,
} from "./graph-utils";
import {
  getHomeDir,
  getProjectIdForTools,
} from "./lm-tools-shared";

// ——— SearchRelations ————————————————————————————————————————

export interface SearchRelationsInput {
  query: string;
  depth?: number;
  mode?: "entity" | "query" | "stats";
  includeInvalidated?: boolean;
}

export class SearchRelationsTool implements vscode.LanguageModelTool<SearchRelationsInput> {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchRelationsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query, depth = 2, mode = "entity" } = options.input;
    this.log(
      `[LM Tool] searchRelations: mode=${mode} query="${query}" depth=${depth}`,
    );

    try {
      const homeDir = getHomeDir();
      const projectPath = this.workspaceFolder.uri.fsPath;
      const projectId = getProjectIdForTools(projectPath);
      const graphPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.graph.json`,
      );

      if (!fs.existsSync(graphPath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "No knowledge graph found. Run indexing first.",
          ),
        ]);
      }

      const raw = fs.readFileSync(graphPath, "utf-8");
      const parsed = JSON.parse(raw);
      const graph = parseGraphologyExport(parsed);
      let output: string;

      switch (mode) {
        case "stats":
          output = formatGraphStats(graph);
          break;
        case "query":
          output = formatQueryResults(graph, query);
          break;
        case "entity":
        default:
          output = formatEntityBFS(graph, query, depth);
          break;
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] searchRelations error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error searching relations: ${err}`),
      ]);
    }
  }
}

// ——— MemoryHistory ——————————————————————————————————————————

export interface MemoryHistoryInput {
  mode?: "recent" | "target" | "hotspots" | "stale" | "stats";
  query?: string;
  limit?: number;
}

export interface HistoryEntry {
  file: string;
  timestamp: number;
  action: "added" | "modified" | "deleted";
  chunks?: number;
}

export interface HistoryData {
  entries: HistoryEntry[];
}

export class MemoryHistoryTool implements vscode.LanguageModelTool<MemoryHistoryInput> {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MemoryHistoryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { mode = "recent", query, limit = 10 } = options.input;
    this.log(`[LM Tool] memoryHistory: mode=${mode} limit=${limit}`);

    try {
      const homeDir = getHomeDir();
      const projectPath = this.workspaceFolder.uri.fsPath;
      const projectId = getProjectIdForTools(projectPath);
      const historyPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.history.json`,
      );

      if (!fs.existsSync(historyPath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "No history found. The project may not be indexed yet.",
          ),
        ]);
      }

      const raw = fs.readFileSync(historyPath, "utf-8");
      const history: HistoryData = JSON.parse(raw);
      let output: string;

      switch (mode) {
        case "target":
          output = this.formatTarget(history, query || "", limit);
          break;
        case "hotspots":
          output = this.formatHotspots(history, limit);
          break;
        case "stale":
          output = this.formatStale(history, limit);
          break;
        case "stats":
          output = this.formatHistoryStats(history);
          break;
        case "recent":
        default:
          output = this.formatRecent(history, limit);
          break;
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] memoryHistory error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error reading history: ${err}`),
      ]);
    }
  }

  private formatRecent(history: HistoryData, limit: number): string {
    const sorted = [...history.entries]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
    const lines = [`## Recent Changes (last ${limit})`, ``];
    for (const entry of sorted) {
      const date = new Date(entry.timestamp).toISOString();
      const emoji =
        entry.action === "added"
          ? "➕"
          : entry.action === "deleted"
            ? "🗑️"
            : "✏️";
      lines.push(
        `${emoji} \`${entry.file}\` — ${entry.action} — ${date}${entry.chunks != null ? ` (${entry.chunks} chunks)` : ""}`,
      );
    }
    if (sorted.length === 0) lines.push("No entries found.");
    return lines.join("\n");
  }

  private formatTarget(
    history: HistoryData,
    query: string,
    limit: number,
  ): string {
    const q = query.toLowerCase();
    const filtered = history.entries
      .filter((e) => e.file.toLowerCase().includes(q))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
    const lines = [
      `## History for: "${query}" (${filtered.length} entries)`,
      ``,
    ];
    for (const entry of filtered) {
      const date = new Date(entry.timestamp).toISOString();
      lines.push(
        `- ${entry.action} — ${date}${entry.chunks != null ? ` (${entry.chunks} chunks)` : ""}`,
      );
    }
    if (filtered.length === 0) lines.push("No entries found matching query.");
    return lines.join("\n");
  }

  private formatHotspots(history: HistoryData, limit: number): string {
    const counts: Record<string, number> = {};
    for (const entry of history.entries) {
      counts[entry.file] = (counts[entry.file] || 0) + 1;
    }
    const sorted = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit);
    const lines = [`## Hotspots (most changed files)`, ``];
    for (const [file, count] of sorted) {
      lines.push(`- 🔥 \`${file}\` — ${count} changes`);
    }
    if (sorted.length === 0) lines.push("No entries found.");
    return lines.join("\n");
  }

  private formatStale(history: HistoryData, limit: number): string {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const latest: Record<string, number> = {};
    for (const entry of history.entries) {
      if (!latest[entry.file] || entry.timestamp > latest[entry.file]) {
        latest[entry.file] = entry.timestamp;
      }
    }
    const stale = Object.entries(latest)
      .filter(([, ts]) => now - ts > sevenDays)
      .sort(([, a], [, b]) => a - b)
      .slice(0, limit);
    const lines = [`## Stale Files (not modified in >7 days)`, ``];
    for (const [file, ts] of stale) {
      const daysAgo = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
      lines.push(`- 📦 \`${file}\` — last modified ${daysAgo} days ago`);
    }
    if (stale.length === 0) lines.push("No stale files found.");
    return lines.join("\n");
  }

  private formatHistoryStats(history: HistoryData): string {
    const files = new Set(history.entries.map((e) => e.file));
    const lastUpdate =
      history.entries.length > 0
        ? new Date(
            Math.max(...history.entries.map((e) => e.timestamp)),
          ).toISOString()
        : "never";
    const actionCounts: Record<string, number> = {};
    for (const entry of history.entries) {
      actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    }
    return [
      `## History Stats`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| **Total Entries** | ${history.entries.length} |`,
      `| **Files Tracked** | ${files.size} |`,
      `| **Last Update** | ${lastUpdate} |`,
      ...Object.entries(actionCounts).map(
        ([action, count]) => `| **${action}** | ${count} |`,
      ),
    ].join("\n");
  }
}
