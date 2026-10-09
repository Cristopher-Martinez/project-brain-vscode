/**
 * Context Enricher LM Tool for Project Brain.
 *
 * Sub-tool registered via Toolbox.register("enrichPrompt", ...).
 * Enriches a user prompt with project memory context (learnings, opinions,
 * file maps, dependency graphs) making small LLM models perform like larger ones.
 */

import * as vscode from "vscode";
import type { EnricherDeps } from "./context-enricher-types";
import { enrichPrompt } from "./context-enricher";
import { getHomeDir, getProjectIdForTools } from "./lm-tools-shared";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";

const execFileAsync = promisify(execFile);

export interface EnrichPromptInput {
  prompt: string;
}

export class EnrichPromptTool
  implements vscode.LanguageModelTool<EnrichPromptInput>
{
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private extensionPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<EnrichPromptInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { prompt } = options.input;
    if (!prompt?.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "enrichPrompt requires a `prompt` parameter with the text to enrich.",
        ),
      ]);
    }

    const wsRoot = this.workspaceFolder.uri.fsPath;

    try {
      const deps = this.buildDeps(wsRoot);
      const result = await enrichPrompt(prompt, deps);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(result.pack.rewrittenPrompt),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[EnrichPromptTool] error: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Context enrichment failed: ${msg}. Using original prompt.`,
        ),
      ]);
    }
  }

  private buildDeps(wsRoot: string): EnricherDeps {
    const cliPath = this.findCliPath(wsRoot);

    return {
      searchMemory: async (query: string, topK = 5) => {
        if (!cliPath) return "";
        try {
          const { stdout } = await execFileAsync("node", [
            cliPath,
            "search",
            query,
            "-p",
            wsRoot,
            "-k",
            String(topK),
          ]);
          const parsed = JSON.parse(stdout);
          return Array.isArray(parsed)
            ? parsed.map((r: { content?: string }) => r.content ?? "").join("\n---\n")
            : typeof parsed === "string" ? parsed : "";
        } catch {
          return "";
        }
      },
      getWorkspaceRoot: () => wsRoot,
      getGraphPath: () => {
        const homeDir = getHomeDir();
        const projectId = getProjectIdForTools(wsRoot);
        return path.join(homeDir, ".mcp-rag-docs", `${projectId}.graph.json`);
      },
      log: this.log,
    };
  }

  private findCliPath(wsRoot: string): string | null {
    const candidates = [
      path.join(wsRoot, "dist", "mcp-server", "cli.mjs"),
      path.join(this.extensionPath, "dist", "mcp-server", "cli.mjs"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
}
