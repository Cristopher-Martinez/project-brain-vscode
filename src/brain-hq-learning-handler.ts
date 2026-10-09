/**
 * Brain HQ — Self-Learning message handlers.
 * Handles all `sl:*` messages from the webview.
 *
 * @module brain-hq-learning-handler
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { SelfLearningManager } from "./self-learning";
import { SelfLearningAnalysis } from "./self-learning-analysis";
import {
  ANALYSIS_AGENTS,
  type AnalysisAgentId,
  type LocalEmbeddingConfig,
  type LocalEmbeddingProvider,
} from "./self-learning-types";

/** Lazily initialized self-learning module (one per HQ panel lifetime). */
let manager: SelfLearningManager | null = null;
let analysis: SelfLearningAnalysis | null = null;

/** Guard against double pipeline runs for the same repo. */
const runningPipelines = new Set<number>();

function ensureManager(instance: BrainHqInstance): SelfLearningManager {
  if (manager) return manager;

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) throw new Error("No workspace folder");

  // Find CLI path — mirrors mcp-manager pattern
  const cliPath = findCliPath(wsRoot);
  const basePath = getBasePath(wsRoot);

  manager = new SelfLearningManager(cliPath, basePath);
  manager.setPostMessage((msg) => {
    try {
      instance.panel.webview.postMessage(msg);
    } catch {
      /* panel disposed */
    }
  });

  return manager;
}

function ensureAnalysis(instance: BrainHqInstance): SelfLearningAnalysis {
  if (analysis) return analysis;

  const mgr = ensureManager(instance);
  const db = mgr.getDb();
  const analysisPath = db.analysisPath;

  analysis = new SelfLearningAnalysis(db, analysisPath);

  // Inject RAG context dependencies (cliPath + embedding config)
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    const cliPath = findCliPath(wsRoot);
    const embeddingConfig = mgr.getConfig();
    analysis.setDeps({ cliPath, embeddingConfig });
  }

  analysis.setPostMessage((msg) => {
    try {
      instance.panel.webview.postMessage(msg);
    } catch {
      /* panel disposed */
    }
  });

  return analysis;
}

/** Handle all sl:* messages from the webview. */
export async function handleLearningMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  try {
    switch (msg.type) {
      case "sl:getRepos": {
        const mgr = await initAndGetManager(instance);
        instance.panel.webview.postMessage({
          type: "sl:repos",
          data: mgr.getRepos(),
        });
        return true;
      }

      case "sl:addRepo": {
        const mgr = await initAndGetManager(instance);
        const source = msg.source as string;
        if (!source) break;
        try {
          await mgr.addRepo(source);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          instance.panel.webview.postMessage({
            type: "sl:error",
            message: errMsg,
          });
        }
        return true;
      }

      case "sl:startPipeline": {
        const mgr = await initAndGetManager(instance);
        const repoId = msg.repoId as number;
        if (!repoId) break;
        // Guard against double-runs
        if (runningPipelines.has(repoId)) break;
        runningPipelines.add(repoId);
        // Run pipeline in background (don't await — updates come via sl:progress + sl:repos)
        mgr
          .runPipeline(repoId)
          .catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            instance.panel.webview.postMessage({
              type: "sl:error",
              message: errMsg,
            });
          })
          .finally(() => runningPipelines.delete(repoId));
        return true;
      }

      case "sl:removeRepo": {
        const mgr = await initAndGetManager(instance);
        mgr.removeRepo(msg.repoId as number);
        return true;
      }

      case "sl:retryClone": {
        const mgr = await initAndGetManager(instance);
        try {
          await mgr.retryClone(msg.repoId as number);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          instance.panel.webview.postMessage({
            type: "sl:error",
            message: errMsg,
          });
        }
        return true;
      }

      case "sl:vectorizeRepo": {
        const mgr = await initAndGetManager(instance);
        const result = await mgr.vectorizeRepo(msg.repoId as number);
        if (!result.success) {
          instance.panel.webview.postMessage({
            type: "sl:error",
            message: result.error ?? "Vectorization failed",
          });
        }
        return true;
      }

      case "sl:analyzeRepo": {
        const anal = await initAndGetAnalysis(instance);
        const mgr = await initAndGetManager(instance);
        const model = msg.llmModel as string;
        const desc = msg.targetDescription as string;
        mgr.getDb().updateAnalysisConfig(msg.repoId as number, model, desc);
        try {
          await anal.analyze({
            repoId: msg.repoId as number,
            llmModel: model,
            targetDescription: desc,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          instance.panel.webview.postMessage({
            type: "sl:error",
            message: errMsg,
          });
        }
        return true;
      }

      case "sl:getConfig": {
        const mgr = await initAndGetManager(instance);
        instance.panel.webview.postMessage({
          type: "sl:config",
          data: mgr.getConfig(),
        });
        return true;
      }

      case "sl:saveConfig": {
        const mgr = await initAndGetManager(instance);
        mgr.saveConfig(msg.config as LocalEmbeddingConfig);
        instance.panel.webview.postMessage({
          type: "sl:config",
          data: mgr.getConfig(),
        });
        return true;
      }

      case "sl:checkProvider": {
        const mgr = await initAndGetManager(instance);
        const available = await mgr.checkProvider(
          msg.provider as LocalEmbeddingProvider,
        );
        instance.panel.webview.postMessage({
          type: "sl:providerStatus",
          provider: msg.provider,
          available,
        });
        return true;
      }

      case "sl:cancelOperation": {
        if (manager) manager.cancelOperation(msg.repoId as number);
        if (analysis) analysis.cancelAnalysis(msg.repoId as number);
        return true;
      }

      case "sl:getAnalysisStatus": {
        const mgr = await initAndGetManager(instance);
        const repo = mgr.getRepo(msg.repoId as number);
        if (!repo) break;
        const analysisDir = mgr.getAnalysisDir(repo.name);
        if (!fs.existsSync(analysisDir)) break;

        const agents = ANALYSIS_AGENTS.map((a) => {
          const filePath = path.join(analysisDir, a.outputFile);
          const exists = fs.existsSync(filePath);
          return {
            repoId: msg.repoId as number,
            agentId: a.id,
            status: (exists ? "completed" : "pending") as
              | "completed"
              | "pending",
            outputPath: exists ? filePath : null,
            error: null,
            durationMs: 0,
            completedAt: exists ? new Date().toISOString() : null,
          };
        });

        const hasAny = agents.some((a) => a.status === "completed");
        if (!hasAny) break;

        const storedModel = repo.lastAnalysisModel ?? "(restored from disk)";
        const storedDesc = repo.lastAnalysisDescription ?? "";

        instance.panel.webview.postMessage({
          type: "sl:analysisUpdate",
          session: {
            repoId: msg.repoId as number,
            llmModel: storedModel,
            targetProjectDescription: storedDesc,
            agents,
            status: "completed",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        });
        return true;
      }

      case "sl:analyzeSingleAgent": {
        const anal = await initAndGetAnalysis(instance);
        const mgr = await initAndGetManager(instance);
        const model = msg.llmModel as string;
        const desc = msg.targetDescription as string;
        mgr.getDb().updateAnalysisConfig(msg.repoId as number, model, desc);
        try {
          await anal.analyzeSingle({
            repoId: msg.repoId as number,
            llmModel: model,
            targetDescription: desc,
            agentIds: msg.agentIds as AnalysisAgentId[],
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          instance.panel.webview.postMessage({
            type: "sl:error",
            message: errMsg,
          });
        }
        return true;
      }

      case "sl:openAnalysis": {
        const mgr = await initAndGetManager(instance);
        const repo = mgr.getRepo(msg.repoId as number);
        if (!repo) break;
        const agentMeta = ANALYSIS_AGENTS.find((a) => a.id === msg.agentId);
        if (!agentMeta) break;
        const filePath = path.join(
          mgr.getAnalysisDir(repo.name),
          agentMeta.outputFile,
        );
        if (fs.existsSync(filePath)) {
          const doc = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
        return true;
      }

      case "sl:openTemplate": {
        const extPath = instance.ctx.extensionUri.fsPath;
        const templatePath = path.join(extPath, "src", "self-learning-prompts.ts");
        if (fs.existsSync(templatePath)) {
          const doc = await vscode.workspace.openTextDocument(templatePath);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    instance.ctx.log(`[SelfLearning] Error: ${errMsg}`);
    instance.panel.webview.postMessage({
      type: "sl:error",
      message: errMsg,
    });
  }
  return false;
}

// ─── Init helpers ───────────────────────────────────────────────────────

async function initAndGetManager(
  instance: BrainHqInstance,
): Promise<SelfLearningManager> {
  const mgr = ensureManager(instance);
  await mgr.init();
  return mgr;
}

async function initAndGetAnalysis(
  instance: BrainHqInstance,
): Promise<SelfLearningAnalysis> {
  await initAndGetManager(instance);
  return ensureAnalysis(instance);
}

function findCliPath(wsRoot: string): string {
  const extDir = __dirname;
  const bundled = path.join(extDir, "mcp-server", "cli.mjs");
  if (fs.existsSync(bundled)) return bundled;

  // Dev fallback: check dist/ in workspace
  const dev = path.join(wsRoot, "dist", "mcp-server", "cli.mjs");
  if (fs.existsSync(dev)) return dev;

  throw new Error("CLI not found: dist/mcp-server/cli.mjs");
}

function getBasePath(wsRoot: string): string {
  return path.join(wsRoot, ".project-brain");
}

/** Cleanup when HQ panel is disposed */
export function disposeLearningHandler(): void {
  analysis?.dispose();
  analysis = null;
  manager?.dispose();
  manager = null;
}
