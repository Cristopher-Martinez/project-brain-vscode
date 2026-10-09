/**
 * Brain HQ — Context Enricher message handler
 *
 * Handles webview messages: enrichGoal, enrichFeedback, setEnrichMode.
 * Calls the context-enricher pipeline and sends results back to webview.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { promisify } from "util";
import { enrichPrompt } from "./context-enricher";
import type { EnricherDeps } from "./context-enricher-types";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { getHomeDir, getProjectIdForTools } from "./lm-tools-shared";
import { log, logError } from "./logger";

const execFileAsync = promisify(execFile);

// ─── Dependencies Factory ──────────────────────────────────────────────────

function findCliPath(workspaceRoot: string): string | null {
  // Check extension dist first, then node_modules
  const candidates = [
    path.join(workspaceRoot, "dist", "mcp-server", "cli.mjs"),
    path.join(workspaceRoot, "node_modules", ".bin", "mcp-rag-docs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: global extension install
  const extPath = vscode.extensions.getExtension("crismart.project-brain")?.extensionPath;
  if (extPath) {
    const extCli = path.join(extPath, "dist", "mcp-server", "cli.mjs");
    if (fs.existsSync(extCli)) return extCli;
  }
  return null;
}

// ─── Free-tier LLM Validator ───────────────────────────────────────────────

/** Preferred free-tier model families for validation (ordered by preference) */
const FREE_MODEL_FAMILIES = ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gemini-2.0-flash", "gemini-flash", "copilot-fast"];

/**
 * Create a validation function using a free-tier LLM.
 * Returns undefined if no free model is available.
 */
async function createValidateContextFn(): Promise<((prompt: string) => Promise<string>) | undefined> {
  try {
    for (const family of FREE_MODEL_FAMILIES) {
      const models = await vscode.lm.selectChatModels({ family });
      if (models.length > 0) {
        const model = models[0];
        log(`[Enricher] Validator using model: ${model.id} (family=${family})`);
        return async (validationPrompt: string) => {
          const messages = [vscode.LanguageModelChatMessage.User(validationPrompt)];
          const tokenSource = new vscode.CancellationTokenSource();
          try {
            const response = await model.sendRequest(messages, {}, tokenSource.token);
            let text = "";
            for await (const chunk of response.text) {
              text += chunk;
            }
            return text;
          } finally {
            tokenSource.dispose();
          }
        };
      }
    }
    // Fallback: any available model
    const allModels = await vscode.lm.selectChatModels();
    if (allModels.length > 0) {
      const model = allModels[0];
      log(`[Enricher] Validator fallback model: ${model.id}`);
      return async (validationPrompt: string) => {
        const messages = [vscode.LanguageModelChatMessage.User(validationPrompt)];
        const tokenSource = new vscode.CancellationTokenSource();
        try {
          const response = await model.sendRequest(messages, {}, tokenSource.token);
          let text = "";
          for await (const chunk of response.text) {
            text += chunk;
          }
          return text;
        } finally {
          tokenSource.dispose();
        }
      };
    }
    log("[Enricher] No LLM models available for validation");
    return undefined;
  } catch (err) {
    log(`[Enricher] Failed to create validator: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ─── Dependencies Factory ──────────────────────────────────────────────────

async function createEnricherDeps(instance: BrainHqInstance): Promise<EnricherDeps | null> {
  const workspaceRoot = instance.ctx.workspaceFolder.uri.fsPath;
  const projectId = getProjectIdForTools(workspaceRoot);
  const homeDir = getHomeDir();
  const graphPath = path.join(homeDir, ".mcp-rag-docs", `${projectId}.graph.json`);
  const cliPath = findCliPath(workspaceRoot);

  const searchFn = async (query: string, topK?: number, opts?: { category?: string; topic?: string }): Promise<string> => {
    if (!cliPath) return "MCP CLI not found. Run 'Project Brain: Initialize' first.";
    const args = [cliPath, "search", query, "-p", workspaceRoot, "-k", String(topK ?? 5)];
    if (opts?.category) args.push("-c", opts.category);
    if (opts?.topic) args.push("-t", opts.topic);
    try {
      const { stdout } = await execFileAsync("node", args, { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
      return stdout.trim() || "No results found.";
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // LLM validator: pick a free-tier model for context validation
  const validateContextFn = await createValidateContextFn();

  return {
    searchMemory: searchFn,
    getWorkspaceRoot: () => workspaceRoot,
    getGraphPath: () => graphPath,
    log: (msg) => log(msg),
    validateContext: validateContextFn,
  };
}

// ─── Message Handler ───────────────────────────────────────────────────────

/**
 * Handle context enricher messages from webview.
 * Returns true if the message was handled.
 */
export async function handleEnricherMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "enrichGoal":
    case "enrichFeedback": {
      const prompt: string = msg.goal || msg.feedback || msg.prompt || "";
      const lastSynthesis: string | undefined = msg.lastSynthesis;
      const loopGoal: string | undefined = msg.loopGoal;
      if (!prompt.trim()) {
        instance.panel.webview.postMessage({
          type: "enrichError",
          error: "No prompt provided for enrichment",
        });
        return true;
      }

      const deps = await createEnricherDeps(instance);
      if (!deps) {
        instance.panel.webview.postMessage({
          type: "enrichError",
          error: "Workspace not initialized",
        });
        return true;
      }

      // Send loading state
      instance.panel.webview.postMessage({ type: "enrichLoading", loading: true });

      try {
        const result = await enrichPrompt(prompt, deps, { lastSynthesis, loopGoal, sessionId: msg.sessionId });
        instance.panel.webview.postMessage({
          type: "enrichResult",
          result: {
            pack: result.pack,
            formattedMarkdown: result.formattedMarkdown,
            durationMs: result.durationMs,
          },
          source: msg.type === "enrichGoal" ? "goal" : "feedback",
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError(`[ContextEnricher] Enrichment failed: ${errMsg}`);
        instance.panel.webview.postMessage({
          type: "enrichError",
          error: `Enrichment failed: ${errMsg}`,
        });
      } finally {
        instance.panel.webview.postMessage({ type: "enrichLoading", loading: false });
      }
      return true;
    }

    case "setEnrichMode": {
      // Store preference — could be persisted to workspace state
      const { sessionId, mode } = msg;
      log(`[ContextEnricher] Mode set to "${mode}" for session ${sessionId || "global"}`);
      // For now, the mode is handled entirely in the webview state
      return true;
    }

    default:
      return false;
  }
}
