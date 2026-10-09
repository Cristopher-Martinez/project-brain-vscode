/**
 * Self-Learning Analysis — Multi-agent analysis orchestrator.
 *
 * Runs 10 specialized agents sequentially against a vectorized repo,
 * using VS Code LM API (Copilot models) for the actual analysis.
 *
 * Each agent writes its output to a markdown file under
 * `.project-brain/analysis/<repo-name>/`.
 *
 * @module self-learning-analysis
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, logError } from "./logger";
import {
  buildAgentContext,
  buildStructuralMap,
  readKeyFiles,
} from "./self-learning-context";
import { SelfLearningDB } from "./self-learning-db";
import { buildAnalysisPrompt } from "./self-learning-prompts";
import {
  ANALYSIS_AGENTS,
  type AgentAnalysisResult,
  type AgentAnalysisStatus,
  type AnalysisAgentId,
  type AnalysisAgentMeta,
  type AnalysisSession,
  type LocalEmbeddingConfig,
} from "./self-learning-types";

// ─── Types ──────────────────────────────────────────────────────────────

type PostMessageFn = (msg: Record<string, unknown>) => void;

interface AnalysisOptions {
  repoId: number;
  llmModel: string;
  targetDescription: string;
}

/** Dependencies needed for context injection */
export interface AnalysisDeps {
  cliPath: string;
  embeddingConfig: LocalEmbeddingConfig;
}

// ─── SelfLearningAnalysis ───────────────────────────────────────────────

export class SelfLearningAnalysis {
  private db: SelfLearningDB;
  private readonly analysisPath: string;
  private postMessage: PostMessageFn | null = null;
  private activeSessions = new Map<number, vscode.CancellationTokenSource>();
  private deps: AnalysisDeps | null = null;

  constructor(db: SelfLearningDB, analysisPath: string) {
    this.db = db;
    this.analysisPath = analysisPath;
  }

  /** Set dependencies for context injection (RAG search, etc.) */
  setDeps(deps: AnalysisDeps): void {
    this.deps = deps;
  }

  setPostMessage(fn: PostMessageFn): void {
    this.postMessage = fn;
  }

  dispose(): void {
    for (const [, cts] of this.activeSessions) cts.cancel();
    this.activeSessions.clear();
  }

  // ─── Run analysis ─────────────────────────────────────────────────

  async analyze(opts: AnalysisOptions): Promise<AnalysisSession> {
    const repo = this.db.getRepo(opts.repoId);
    if (!repo) throw new Error(`Repo ${opts.repoId} not found`);

    const outputDir = path.join(this.analysisPath, repo.name);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const model = await this._selectModel(opts.llmModel);
    if (!model) throw new Error(`No se encontró el modelo: ${opts.llmModel}`);

    const structuralMap = fs.existsSync(repo.localPath)
      ? buildStructuralMap(repo.localPath) : "";
    const keyFiles = fs.existsSync(repo.localPath)
      ? readKeyFiles(repo.localPath) : "";
    log(`[SelfLearning] Base context built: map=${structuralMap.length}c, keys=${keyFiles.length}c`);

    const session = this._createSession(opts);
    const cts = new vscode.CancellationTokenSource();
    this.activeSessions.set(opts.repoId, cts);

    session.status = "running";
    this.db.updateStatus(opts.repoId, "analyzing");
    this._notifySessionUpdate(session);

    try {
      await this._executeAgentLoop({
        session, agentsToRun: ANALYSIS_AGENTS, model,
        repoName: repo.name, repoLocalPath: repo.localPath,
        outputDir, structuralMap, keyFiles,
        targetDescription: opts.targetDescription, cts,
      });
      this._finalizeSession(session, opts.repoId);
    } finally {
      this.activeSessions.delete(opts.repoId);
      cts.dispose();
    }

    this._notifySessionUpdate(session);
    return session;
  }

  /** Run specific agents for a repo that was already partially analyzed. */
  async analyzeSingle(opts: AnalysisOptions & { agentIds: AnalysisAgentId[] }): Promise<void> {
    const repo = this.db.getRepo(opts.repoId);
    if (!repo) throw new Error(`Repo ${opts.repoId} not found`);

    const outputDir = path.join(this.analysisPath, repo.name);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const model = await this._selectModel(opts.llmModel);
    if (!model) throw new Error(`No se encontró el modelo: ${opts.llmModel}`);

    const structuralMap = fs.existsSync(repo.localPath)
      ? buildStructuralMap(repo.localPath) : "";
    const keyFiles = fs.existsSync(repo.localPath)
      ? readKeyFiles(repo.localPath) : "";

    const targetAgents = ANALYSIS_AGENTS.filter(a => opts.agentIds.includes(a.id));
    if (targetAgents.length === 0) return;

    const session = this._reconstructSession(opts, outputDir);
    const cts = new vscode.CancellationTokenSource();
    this.activeSessions.set(opts.repoId, cts);

    session.status = "running";
    this._notifySessionUpdate(session);

    try {
      await this._executeAgentLoop({
        session, agentsToRun: targetAgents, model,
        repoName: repo.name, repoLocalPath: repo.localPath,
        outputDir, structuralMap, keyFiles,
        targetDescription: opts.targetDescription, cts,
      });
      this._finalizeSession(session, opts.repoId);
    } finally {
      this.activeSessions.delete(opts.repoId);
      cts.dispose();
    }

    this._notifySessionUpdate(session);
  }

  cancelAnalysis(repoId: number): void {
    const cts = this.activeSessions.get(repoId);
    if (cts) {
      cts.cancel();
      this.activeSessions.delete(repoId);
      log(`[SelfLearning] Analysis cancelled for repo ${repoId}`);
    }
  }

  // ─── Shared execution helpers ─────────────────────────────────────

  /** Execute the agent loop for a set of agents within a session. */
  private async _executeAgentLoop(params: {
    session: AnalysisSession;
    agentsToRun: readonly AnalysisAgentMeta[];
    model: vscode.LanguageModelChat;
    repoName: string;
    repoLocalPath: string;
    outputDir: string;
    structuralMap: string;
    keyFiles: string;
    targetDescription: string;
    cts: vscode.CancellationTokenSource;
  }): Promise<void> {
    const {
      session, agentsToRun, model, repoName, repoLocalPath,
      outputDir, structuralMap, keyFiles, targetDescription, cts,
    } = params;

    for (const agentMeta of agentsToRun) {
      if (cts.token.isCancellationRequested) break;

      const agentResult = this._findAgent(session, agentMeta.id);
      if (!agentResult) continue;

      agentResult.status = "running";
      agentResult.error = null;
      this._notifySessionUpdate(session);

      const startMs = Date.now();
      try {
        const agentContext = await this._buildContextForAgent(
          agentMeta.id, repoLocalPath, outputDir, structuralMap, keyFiles,
        );
        const output = await this._runAgent(
          model, agentMeta.id, repoName,
          targetDescription, agentContext, cts.token,
        );
        const outputPath = path.join(outputDir, agentMeta.outputFile);
        fs.writeFileSync(outputPath, output, "utf-8");

        agentResult.status = "completed";
        agentResult.outputPath = outputPath;
        agentResult.durationMs = Date.now() - startMs;
        agentResult.completedAt = new Date().toISOString();
        log(`[SelfLearning] Agent ${agentMeta.id} completed (${agentResult.durationMs}ms)`);
      } catch (err) {
        agentResult.status = "error";
        agentResult.error = err instanceof Error ? err.message : String(err);
        agentResult.durationMs = Date.now() - startMs;
        logError(`[SelfLearning] Agent ${agentMeta.id} failed: ${agentResult.error}`);
      }

      this._notifySessionUpdate(session);
    }
  }

  /** Finalize session status and update DB. */
  private _finalizeSession(session: AnalysisSession, repoId: number): void {
    const allDone = session.agents.every(
      (a) => a.status === "completed" || a.status === "error",
    );
    session.status = allDone ? "completed" : "error";
    session.completedAt = new Date().toISOString();

    this.db.updateStatus(
      repoId,
      session.status === "completed" ? "analyzed" : "error",
      session.status === "error" ? "Some agents failed" : undefined,
    );
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async _selectModel(
    modelId: string,
  ): Promise<vscode.LanguageModelChat | null> {
    const allModels = await vscode.lm.selectChatModels();
    // Try exact match first
    let model = allModels.find((m) => m.id === modelId);
    if (model) return model;

    // Try family match
    model = allModels.find((m) => m.family === modelId);
    if (model) return model;

    // Fallback to any copilot model
    model = allModels.find((m) => m.vendor === "copilot");
    return model ?? null;
  }

  private async _runAgent(
    model: vscode.LanguageModelChat,
    agentId: AnalysisAgentId,
    repoName: string,
    targetDescription: string,
    codeContext: string,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const prompt = buildAnalysisPrompt(agentId, repoName, targetDescription);

    // Inject code context as a system-like message before the main prompt
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (codeContext) {
      messages.push(vscode.LanguageModelChatMessage.User(
        `A continuación tienes el contexto del repositorio "${repoName}" para fundamentar tu análisis con código real:\n\n${codeContext}`
      ));
    }
    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    const response = await model.sendRequest(messages, {}, token);

    // Collect full response
    let output = "";
    for await (const chunk of response.text) {
      output += chunk;
    }

    return output;
  }

  /** Build agent-specific context: RAG queries + cross-agent for late agents */
  private async _buildContextForAgent(
    agentId: AnalysisAgentId,
    repoPath: string,
    analysisDir: string,
    structuralMap: string,
    keyFiles: string,
  ): Promise<string> {
    if (!this.deps) {
      // Fallback: return just structural map + key files if no deps configured
      return [structuralMap, keyFiles].filter(Boolean).join("\n\n---\n\n");
    }

    try {
      return await buildAgentContext({
        agentId,
        repoPath,
        cliPath: this.deps.cliPath,
        config: this.deps.embeddingConfig,
        analysisDir,
        structuralMap,
        keyFiles,
      });
    } catch (err) {
      logError(`[SelfLearning] Context build failed for ${agentId}: ${err}`);
      // Graceful degradation: return what we have
      return [structuralMap, keyFiles].filter(Boolean).join("\n\n---\n\n");
    }
  }

  private _createSession(opts: AnalysisOptions): AnalysisSession {
    const agents: AgentAnalysisResult[] = ANALYSIS_AGENTS.map((a) => ({
      repoId: opts.repoId,
      agentId: a.id,
      status: "pending" as AgentAnalysisStatus,
      outputPath: null,
      error: null,
      durationMs: 0,
      completedAt: null,
    }));

    return {
      repoId: opts.repoId,
      llmModel: opts.llmModel,
      targetProjectDescription: opts.targetDescription,
      agents,
      status: "pending",
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  /** Reconstruct a session from disk — completed agents get "completed", others "pending". */
  private _reconstructSession(opts: AnalysisOptions, outputDir: string): AnalysisSession {
    const agents: AgentAnalysisResult[] = ANALYSIS_AGENTS.map((a) => {
      const filePath = path.join(outputDir, a.outputFile);
      const exists = fs.existsSync(filePath);
      return {
        repoId: opts.repoId,
        agentId: a.id,
        status: (exists ? "completed" : "pending") as AgentAnalysisStatus,
        outputPath: exists ? filePath : null,
        error: null,
        durationMs: 0,
        completedAt: exists ? new Date().toISOString() : null,
      };
    });

    return {
      repoId: opts.repoId,
      llmModel: opts.llmModel,
      targetProjectDescription: opts.targetDescription,
      agents,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  private _findAgent(
    session: AnalysisSession,
    agentId: AnalysisAgentId,
  ): AgentAnalysisResult | undefined {
    return session.agents.find((a) => a.agentId === agentId);
  }

  private _notifySessionUpdate(session: AnalysisSession): void {
    if (!this.postMessage) return;
    try {
      this.postMessage({
        type: "sl:analysisUpdate",
        session,
      });
    } catch {
      /* webview may be disposed */
    }
  }
}
