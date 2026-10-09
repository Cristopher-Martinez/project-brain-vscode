/**
 * opencode-config — Builds an OpenCode JSON config injected via
 * OPENCODE_CONFIG_CONTENT env var (runtime override, highest precedence).
 *
 * This is how OpenCode (serve/web/TUI) gains Project Brain's own tools: we
 * register our `rag-docs` MCP server as a local MCP, and feed our identity /
 * rule files as `instructions`. No file is written into the user's repo.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "../logger";

/**
 * Locate the bundled MCP RAG *stdio server* entry (index.mjs) for `node`.
 *
 * IMPORTANT: this must be `index.mjs` (boots StdioServerTransport), NOT
 * `cli.mjs` (a commander CLI that only prints help and exits — OpenCode would
 * spawn it, get no MCP handshake, and silently drop the server).
 */
export function findMcpServerPath(workspaceRoot: string): string | undefined {
  const candidates = [path.join(workspaceRoot, "dist", "mcp-server", "index.mjs")];
  const extPath = vscode.extensions.getExtension("crismart.project-brain")?.extensionPath;
  if (extPath) {
    candidates.push(path.join(extPath, "dist", "mcp-server", "index.mjs"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

/** Collect existing identity/rule files to feed OpenCode as instructions. */
function findInstructionFiles(workspaceRoot: string): string[] {
  const rel = [".github/copilot-instructions.md", "AGENTS.md"];
  return rel.filter((r) => fs.existsSync(path.join(workspaceRoot, r)));
}

export interface OpenCodeConfigOptions {
  workspaceRoot: string;
  /** "providerID/modelID", e.g. "openrouter/openai/gpt-4o-mini". */
  model?: string;
}

/**
 * Build an OpenCode config JSON string for OPENCODE_CONFIG_CONTENT.
 * Returns undefined when there's nothing useful to inject.
 */
export function buildOpenCodeConfigContent(opts: OpenCodeConfigOptions): string | undefined {
  const config: Record<string, unknown> = {};
  const serverEntry = findMcpServerPath(opts.workspaceRoot);
  if (serverEntry) {
    config.mcp = {
      "project-brain": { type: "local", command: ["node", serverEntry], enabled: true },
    };
    log(`[OpenCode] MCP project-brain wired: ${serverEntry}`);
  } else {
    log("[OpenCode] MCP server entry not found — UI runs without Project Brain tools");
  }
  const instructions = findInstructionFiles(opts.workspaceRoot);
  if (instructions.length) {
    config.instructions = instructions;
    log(`[OpenCode] instructions wired: ${instructions.join(", ")}`);
  }
  if (opts.model) {
    config.model = opts.model;
  }
  if (Object.keys(config).length === 0) {
    return undefined;
  }
  return JSON.stringify(config);
}
