/**
 * MCP-related LM Tools for Project Brain.
 *
 * Extracted from lm-tools.ts for modularity:
 * - IndexProjectTool — triggers project indexing/sync
 * - VectorizationStatusTool — reports vectorization and graph status
 * - WatchProjectTool — re-syncs project via CLI vectorize
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { parseEmbeddingType, parseGraphCounts } from "./graph-utils";
import { MCPManager } from "./mcp-manager";
import {
  getCliPathFromManager,
  getEmbeddingEnvFromConfig,
  getHomeDir,
  getProjectIdForTools,
} from "./lm-tools-shared";

const execFileAsync = promisify(execFile);

// ——— IndexProject ———————————————————————————————————————————————

export interface IndexProjectInput {
  forceReindex?: boolean;
}

export class IndexProjectTool implements vscode.LanguageModelTool<IndexProjectInput> {
  constructor(
    private mcpManager: MCPManager,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IndexProjectInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const force = options.input?.forceReindex ?? false;
    this.log(`[LM Tool] indexProject: force=${force}`);

    try {
      if (force) {
        await this.mcpManager.indexProject();
      } else {
        await this.mcpManager.syncIndex();
      }

      const stats = await this.mcpManager.getIndexStats();
      let output: string;
      if (stats) {
        const updated = new Date(stats.lastUpdated).toISOString();
        output = [
          `## Index ${force ? "Rebuilt" : "Synced"} Successfully`,
          ``,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| **Chunks** | ${stats.chunks} |`,
          `| **Files** | ${stats.files} |`,
          `| **Last Updated** | ${updated} |`,
          `| **Mode** | ${force ? "Full reindex (--force)" : "Incremental sync"} |`,
        ].join("\n");
      } else {
        output = `Project ${force ? "reindexed" : "synced"} successfully.`;
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] indexProject error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error indexing project: ${err}`),
      ]);
    }
  }
}

// ——— VectorizationStatus ————————————————————————————————————————

export class VectorizationStatusTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private mcpManager: MCPManager,
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    this.log(`[LM Tool] vectorizationStatus`);

    try {
      const homeDir = getHomeDir();
      const projectPath = this.workspaceFolder.uri.fsPath;
      const projectId = getProjectIdForTools(projectPath);
      const storagePath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.json`,
      );
      const graphPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.graph.json`,
      );

      let indexed = false;
      let chunks = 0;
      let files = 0;
      let embeddingType = "unknown";
      let lastUpdated = "never";

      if (fs.existsSync(storagePath)) {
        indexed = true;
        const raw = fs.readFileSync(storagePath, "utf-8");
        const index = JSON.parse(raw);
        chunks = index.chunks?.length ?? 0;
        files = Object.keys(index.fileHashes || {}).length;
        embeddingType = parseEmbeddingType(index as Record<string, unknown>);
        if (index.lastUpdated) {
          lastUpdated = new Date(index.lastUpdated).toISOString();
        }
      }

      let graphNodes = 0;
      let graphEdges = 0;
      if (fs.existsSync(graphPath)) {
        const graphRaw = fs.readFileSync(graphPath, "utf-8");
        const graphJson = JSON.parse(graphRaw);
        const counts = parseGraphCounts(graphJson);
        graphNodes = counts.nodes;
        graphEdges = counts.edges;
      }

      const serverAvailable = !!this.mcpManager.getMCPServerPath();

      const output = [
        `## Vectorization Status`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Indexed** | ${indexed ? "✅ Yes" : "❌ No"} |`,
        `| **Chunks** | ${chunks} |`,
        `| **Files** | ${files} |`,
        `| **Embedding Type** | ${embeddingType} |`,
        `| **Last Updated** | ${lastUpdated} |`,
        `| **Graph Nodes** | ${graphNodes} |`,
        `| **Graph Edges** | ${graphEdges} |`,
        `| **MCP Server** | ${serverAvailable ? "✅ Available" : "❌ Not found"} |`,
        `| **Project ID** | ${projectId} |`,
      ].join("\n");

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] vectorizationStatus error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error checking vectorization status: ${err}`,
        ),
      ]);
    }
  }
}

// ——— WatchProject ———————————————————————————————————————————————

export class WatchProjectTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private mcpManager: MCPManager,
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    this.log(`[LM Tool] watchProject`);

    try {
      const cliPath = getCliPathFromManager(this.mcpManager);
      const projectPath = this.workspaceFolder.uri.fsPath;
      const embeddingEnv = getEmbeddingEnvFromConfig();

      await execFileAsync("node", [cliPath, "vectorize", projectPath], {
        timeout: 120_000,
        env: { ...process.env, ...embeddingEnv },
      });

      const output = [
        `✅ Project re-synced successfully.`,
        `**Path:** ${projectPath}`,
      ].join("\n");

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] watchProject error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error syncing project: ${err}`),
      ]);
    }
  }
}
