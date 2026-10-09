/**
 * Self-Learning Core — Clone, vectorize, and manage external repos.
 *
 * Uses the existing RAG CLI (`cli.mjs vectorize`) with custom env vars
 * pointing to a local embedding provider (Ollama, LM Studio, llamafile).
 *
 * @module self-learning
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError, logWarn } from "./logger";
import { robustRm } from "./fs-utils";
import { SelfLearningDB } from "./self-learning-db";
import { cloneGithubRepoToPath } from "./self-learning-clone";
import { runSelfLearningPipeline } from "./self-learning-pipeline";
import { slProgress, slDone, slError } from "./self-learning-state";
import { runVectorize } from "./self-learning-vectorize";
import type {
  LocalEmbeddingConfig,
  LocalEmbeddingProvider,
  RepoEntry,
  VectorizationResult,
} from "./self-learning-types";

type PostMessageFn = (msg: Record<string, unknown>) => void;

// ─── SelfLearningManager ────────────────────────────────────────────────

export class SelfLearningManager {
  private db: SelfLearningDB;
  private readonly cliPath: string;
  private postMessage: PostMessageFn | null = null;
  private activeOps = new Map<number, AbortController>();
  private _vectorizeQueue: Array<{
    repoId: number;
    resolve: (r: VectorizationResult) => void;
  }> = [];
  private _isVectorizing = false;
  private _disposed = false;

  constructor(cliPath: string, basePath: string) {
    this.cliPath = cliPath;
    this.db = new SelfLearningDB(basePath);
  }

  private _initialized = false;

  async init(): Promise<void> {
    if (this._initialized) return;
    await this.db.init();
    this._initialized = true;
    log("[SelfLearning] Initialized");
  }

  dispose(): void {
    this._disposed = true;
    for (const [, ctrl] of this.activeOps) ctrl.abort();
    this.activeOps.clear();
    for (const item of this._vectorizeQueue) {
      item.resolve({ chunks: 0, files: 0, success: false, error: "Disposed" });
    }
    this._vectorizeQueue.length = 0;
    this._isVectorizing = false;
    this.db.dispose();
  }

  /** Expose DB for SelfLearningAnalysis creation. */
  getDb(): SelfLearningDB {
    return this.db;
  }

  setPostMessage(fn: PostMessageFn): void {
    this.postMessage = fn;
  }

  // ─── Repo Management ──────────────────────────────────────────────

  async addRepo(source: string): Promise<RepoEntry> {
    const isGithub =
      /^https?:\/\/github\.com\//i.test(source) ||
      /^git@github\.com:/i.test(source);
    const sourceType = isGithub ? "github" : "local";
    const name = this._extractName(source, sourceType);

    // Check for duplicate
    const existing = this.db.getAllRepos().find(r => r.source === source);
    if (existing) {
      throw new Error(`Repo already exists: ${source} (id=${existing.id})`);
    }

    let localPath: string;
    if (sourceType === "local") {
      localPath = source;
      if (!fs.existsSync(localPath)) {
        throw new Error(`Carpeta no encontrada: ${source}`);
      }
    } else {
      localPath = path.join(this.db.reposPath, name);
    }

    const entry = this.db.addRepo(name, source, sourceType, localPath);
    log(`[SelfLearning] Repo added: ${name} (${sourceType})`);

    if (sourceType === "github") {
      await this._cloneRepo(entry);
    } else {
      this.db.updateStatus(entry.id, "cloned");
      entry.status = "cloned";
    }

    this._notifyUpdate();
    return entry;
  }

  removeRepo(repoId: number): void {
    const repo = this.db.getRepo(repoId);
    if (!repo) return;

    // Cancel any active operation
    this.cancelOperation(repoId);

    // Remove cloned files if it was a github repo
    if (repo.sourceType === "github" && fs.existsSync(repo.localPath)) {
      robustRm(repo.localPath).catch((err) =>
        logWarn(`[SelfLearning] Could not delete repo files: ${err}`),
      );
    }

    // Remove analysis output
    const analysisDir = path.join(this.db.analysisPath, repo.name);
    if (fs.existsSync(analysisDir)) {
      robustRm(analysisDir).catch(() => { /* non-critical */ });
    }

    this.db.removeRepo(repoId);
    log(`[SelfLearning] Repo removed: ${repo.name}`);
    this._notifyUpdate();
  }

  /** Retry clone for a GitHub repo that previously failed */
  async retryClone(repoId: number): Promise<void> {
    const repo = this.db.getRepo(repoId);
    if (!repo) throw new Error("Repo not found");
    if (repo.sourceType !== "github") throw new Error("Only GitHub repos need cloning");
    await this._cloneRepo(repo);
  }

  getRepos(): RepoEntry[] {
    return this.db.getAllRepos();
  }

  getRepo(id: number): RepoEntry | null {
    return this.db.getRepo(id);
  }

  cancelOperation(repoId: number): void {
    const ctrl = this.activeOps.get(repoId);
    if (ctrl) {
      ctrl.abort();
      this.activeOps.delete(repoId);
    }
  }

  // ─── Vectorization ────────────────────────────────────────────────

  /** Enqueue vectorization — only one runs at a time. */
  async vectorizeRepo(repoId: number): Promise<VectorizationResult> {
    return new Promise<VectorizationResult>((resolve) => {
      this._vectorizeQueue.push({ repoId, resolve });
      if (!this._isVectorizing) this._processNextVectorize();
    });
  }

  private async _processNextVectorize(): Promise<void> {
    while (this._vectorizeQueue.length > 0) {
      const next = this._vectorizeQueue.shift()!;
      this._isVectorizing = true;
      const result = await this._doVectorize(next.repoId);
      next.resolve(result);
    }
    this._isVectorizing = false;
  }

  private async _doVectorize(repoId: number): Promise<VectorizationResult> {
    try {
      if (this._disposed) return { chunks: 0, files: 0, success: false, error: "Disposed" };

      const repo = this.db.getRepo(repoId);
      if (!repo)
        return { chunks: 0, files: 0, success: false, error: "Repo not found" };

      if (!fs.existsSync(repo.localPath)) {
        const err = `Path not found: ${repo.localPath}`;
        this.db.updateStatus(repoId, "error", err);
        this._notifyUpdate();
        return { chunks: 0, files: 0, success: false, error: err };
      }

      const config = this.db.getConfig();
      this.db.updateStatus(repoId, "vectorizing");
      this._notifyUpdate();

      const abortCtrl = new AbortController();
      this.activeOps.set(repoId, abortCtrl);

      const result = await this._runVectorize(
        repoId,
        repo.localPath,
        config,
        abortCtrl.signal,
      );
      if (!this._disposed) {
        this.db.updateVectorizationResult(
          repoId,
          result.chunks,
          result.files,
          config.provider,
        );
        log(
          `[SelfLearning] Vectorized ${repo.name}: ${result.chunks} chunks, ${result.files} files`,
        );
        this._notifyUpdate();
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this._disposed) {
        this.db.updateStatus(repoId, "error", msg);
        logError(`[SelfLearning] Vectorization failed for repo ${repoId}: ${msg}`);
        this._notifyUpdate();
      }
      return { chunks: 0, files: 0, success: false, error: msg };
    } finally {
      this.activeOps.delete(repoId);
    }
  }

  // ─── Config ────────────────────────────────────────────────────────

  getConfig(): LocalEmbeddingConfig {
    return this.db.getConfig();
  }

  saveConfig(config: LocalEmbeddingConfig): void {
    this.db.saveConfig(config);
    log(`[SelfLearning] Config saved: ${config.provider} @ ${config.baseUrl}`);
  }

  async checkProvider(provider: LocalEmbeddingProvider): Promise<boolean> {
    const configs: Record<string, { url: string }> = {
      ollama: { url: "http://localhost:11434/v1/models" },
      lmstudio: { url: "http://localhost:1234/v1/models" },
      llamafile: { url: "http://localhost:8080/v1/models" },
      custom: { url: "" },
    };

    const target = configs[provider];
    if (!target || !target.url) return false;

    try {
      const response = await fetch(target.url, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── Full Pipeline ────────────────────────────────────────────────

  /** Run the full pipeline: clone (if needed) → vectorize → notify ready. */
  async runPipeline(repoId: number): Promise<void> {
    return runSelfLearningPipeline({
      getRepo: (id) => this.db.getRepo(id),
      retryClone: (id) => this.retryClone(id),
      vectorizeRepo: (id) => this.vectorizeRepo(id),
      getPostMessage: () => this.postMessage,
    }, repoId);
  }

  // ─── Analysis output path ─────────────────────────────────────────

  getAnalysisDir(repoName: string): string {
    return path.join(this.db.analysisPath, repoName);
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async _cloneRepo(entry: RepoEntry): Promise<void> {
    this.db.updateStatus(entry.id, "cloning");
    this._notifyUpdate();
    slProgress({ repoId: entry.id, name: entry.name, phase: "cloning", detail: "Starting clone..." });

    try {
      // Clone via temp dir + atomic swap for cross-platform robustness
      await cloneGithubRepoToPath({
        sourceUrl: entry.source,
        targetPath: entry.localPath,
        timeoutMs: 300_000,
        throttleMs: 400,
        onProgress: (p) => {
          slProgress({ repoId: entry.id, name: entry.name, phase: "cloning", detail: p.detail, percent: p.percent });
          if (!this.postMessage) return;
          try {
            this.postMessage({
              type: "sl:progress",
              repoId: entry.id,
              phase: "cloning",
              detail: p.detail,
              percent: p.percent,
            });
          } catch {
            /* webview may be disposed */
          }
        },
      });

      this.db.updateStatus(entry.id, "cloned");
      slDone(entry.id, entry.name);
      log(
        `[SelfLearning] Cloned ${entry.source} → ${entry.localPath} (.git removed)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db.updateStatus(entry.id, "error", `Clone failed: ${msg}`);
      slError(entry.id, entry.name, `Clone failed: ${msg}`);
      logError(`[SelfLearning] Clone failed: ${msg}`);
    }
    this._notifyUpdate();
  }

  private async _runVectorize(
    repoId: number,
    projectPath: string,
    config: LocalEmbeddingConfig,
    signal: AbortSignal,
  ): Promise<VectorizationResult> {
    const repo = this.db.getRepo(repoId);
    const repoName = repo?.name ?? "unknown";
    return runVectorize({
      repoId,
      repoName,
      projectPath,
      config,
      signal,
      cliPath: this.cliPath,
      postMessage: this.postMessage,
    });
  }

  private _extractName(source: string, sourceType: "github" | "local"): string {
    if (sourceType === "github") {
      // https://github.com/owner/repo.git → repo
      const match = /\/([^/]+?)(?:\.git)?$/.exec(source);
      return match?.[1] ?? "unknown-repo";
    }
    return path.basename(source);
  }

  private _notifyUpdate(): void {
    if (!this.postMessage) return;
    try {
      this.postMessage({
        type: "sl:repos",
        data: this.getRepos(),
      });
    } catch {
      /* webview may be disposed */
    }
  }

}
