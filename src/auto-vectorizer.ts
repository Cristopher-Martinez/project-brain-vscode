import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  createCancellableOperation,
  type CancellableOperation,
} from "./cancellable-operation";
import { log, logError } from "./logger";

const execFileAsync = promisify(execFile);

/** Return type of promisify(execFile) — dual ChildProcess & Promise */
type ExecFilePromise = Promise<{ stdout: string; stderr: string }> &
  ChildProcess;

/** Event payload emitted after the watcher processes a batch of file changes */
export interface VectorizeBatchEvent {
  /** Relative file paths that were processed */
  files: string[];
  /** Number of chunks added */
  chunksAdded: number;
  /** Number of chunks removed */
  chunksRemoved: number;
  /** Timestamp of completion */
  timestamp: number;
}

const MAX_RESTART_ATTEMPTS = 3;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // 1 minute
const VECTORIZE_TIMEOUT_MS = 120_000; // 2 minutes for large projects

export class AutoVectorizer {
  private watcherProcess: ChildProcess | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private _isActive = false;
  private _restarting = false; // mutex guard for handleUnexpectedExit
  private _vectorizing = false;
  private _vectorizeTimer: NodeJS.Timeout | null = null;
  private _filesProcessed = 0;
  private _lastFileProcessed = "";
  private _activeSyncOp: CancellableOperation | null = null;

  /**
   * Event emitter: fires after each watcher batch completes.
   * CloudSync subscribes to this to trigger cloud upload post-vectorization.
   */
  private _onBatchComplete = new vscode.EventEmitter<VectorizeBatchEvent>();
  readonly onBatchComplete = this._onBatchComplete.event;

  /**
   * Cloud-backed mode: when true, file unlinks of cloud-manifested files
   * do NOT delete their vectors. The manifest path is passed to the watcher
   * process so it can check before deleting vectors.
   */
  private _cloudBackedMode = false;
  private _cloudManifestPath: string | null = null;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private context: vscode.ExtensionContext,
    private mcpServerPath: string | null,
    private isBundled = false,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.statusBarItem.command = "projectBrain.stopAutoVectorization";
    context.subscriptions.push(this.statusBarItem);
  }

  async start(): Promise<boolean> {
    if (!this.mcpServerPath) {
      vscode.window.showErrorMessage(
        "Project Brain: MCP server not found. Cannot start auto-vectorization.",
      );
      return false;
    }

    const success = await this.startWatcherProcess();
    if (success) {
      this._isActive = true;
      this.restartAttempts = 0;
      this.startHealthCheck();
      this.updateStatusBar("$(eye) Auto-Vectorization", true);
      await this.context.globalState.update("autoVectorizationEnabled", true);
      vscode.window.showInformationMessage(
        "Auto-vectorization started (server-side watcher)",
      );
      return true;
    }

    vscode.window.showErrorMessage("Failed to start auto-vectorization");
    return false;
  }

  /**
   * Cancel any in-progress vectorization sync.
   * Uses tree-kill on Windows to prevent orphan child processes.
   * Idempotent — safe to call when no sync is running.
   */
  cancelSync(): void {
    if (this._activeSyncOp) {
      this._activeSyncOp.cancel("explicit-cancel");
      this._activeSyncOp.dispose();
      this._activeSyncOp = null;
    }
  }

  async stop(): Promise<void> {
    this._isActive = false;
    this.cancelSync();

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.killWatcherProcess();
    this.updateStatusBar("", false);
    await this.context.globalState.update("autoVectorizationEnabled", false);
    vscode.window.showInformationMessage("Auto-vectorization stopped");
  }

  isActive(): boolean {
    return this._isActive;
  }

  async autoStartIfEnabled(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const autoStart = config.get<boolean>("autoStartVectorization", false);
    const wasEnabled = this.context.globalState.get<boolean>(
      "autoVectorizationEnabled",
      false,
    );

    if (autoStart || wasEnabled) {
      // Small delay to let extension finish activation
      await new Promise((r) => setTimeout(r, 1500));
      try {
        return await this.start();
      } catch (err) {
        logError("Auto-vectorization auto-start failed", err);
        return false;
      }
    }
    return false;
  }

  /**
   * Enable cloud-backed mode. When active, the watcher process receives
   * the cloud manifest path via CLOUD_MANIFEST_PATH env var. The MCP server
   * watcher uses this to skip vector deletion for files that exist in the
   * cloud manifest (evicted locally but still backed by R2).
   */
  enableCloudBacked(manifestPath: string): void {
    this._cloudBackedMode = true;
    this._cloudManifestPath = manifestPath;
    log(
      `[AutoVectorizer] Cloud-backed mode ENABLED (manifest: ${manifestPath})`,
    );

    // If watcher is running, restart with the new env var
    if (this._isActive && this.watcherProcess) {
      log("[AutoVectorizer] Restarting watcher with cloud manifest...");
      this.cancelSync();
      this.killWatcherProcess();
      this.startWatcherProcess();
    }
  }

  /**
   * Disable cloud-backed mode. Vector deletion resumes for all unlinked files.
   */
  disableCloudBacked(): void {
    this._cloudBackedMode = false;
    this._cloudManifestPath = null;
    log("[AutoVectorizer] Cloud-backed mode DISABLED");
  }

  /** Check if a file is cloud-backed (exists in manifest, safe to evict). */
  isCloudBacked(filePath: string): boolean {
    if (!this._cloudBackedMode || !this._cloudManifestPath) return false;

    try {
      if (!fs.existsSync(this._cloudManifestPath)) return false;
      const manifest = JSON.parse(
        fs.readFileSync(this._cloudManifestPath, "utf-8"),
      );
      const relativePath = path.relative(
        path.dirname(this._cloudManifestPath),
        filePath,
      );
      const normalized = relativePath.replace(/\\/g, "/");
      return manifest?.files?.[normalized] !== undefined;
    } catch {
      return false;
    }
  }

  /** Build embedding environment variables from VS Code settings */
  private getEmbeddingEnvVars(): Record<string, string> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const env: Record<string, string> = {};

    const embeddings = config.get<string>("embeddings", "auto");
    // Map "auto" to empty string so the MCP server uses its own auto-detect chain
    env.EMBEDDING_PROVIDER = embeddings === "auto" ? "" : embeddings;

    const embeddingKey = config.get<string>("embeddingApiKey", "");
    if (embeddingKey) {
      env.EMBEDDING_API_KEY = embeddingKey;
    }

    const embeddingModel = config.get<string>(
      "embeddingModel",
      "BAAI/bge-small-en-v1.5",
    );
    if (embeddingModel) {
      env.EMBEDDING_MODEL = embeddingModel;
    }

    const embeddingBaseUrl = config.get<string>("embeddingBaseUrl", "");
    if (embeddingBaseUrl) {
      env.EMBEDDING_BASE_URL = embeddingBaseUrl;
    }

    return env;
  }

  /**
   * Trigger a one-shot vectorization (e.g., after initializeProject).
   * Does NOT require the watcher to be running.
   */
  async triggerSync(force = false): Promise<void> {
    if (!this.mcpServerPath) return;

    // Cancel previous sync if still running (handles rapid re-triggers)
    this.cancelSync();

    // Create new cancellable operation for this sync
    const op = createCancellableOperation();
    this._activeSyncOp = op;

    const cliPath = this.getCliPath();
    const projectPath = this.workspaceFolder.uri.fsPath;
    const embeddingEnv = this.getEmbeddingEnvVars();

    this.updateStatusBar("$(sync~spin) Vectorizing...", true);

    // Launch child process — do NOT pass signal (we handle kill manually for tree-kill)
    const childPromise = execFileAsync(
      "node",
      ["--max-old-space-size=512", cliPath, "vectorize", projectPath, ...(force ? ["--force"] : [])],
      {
        timeout: VECTORIZE_TIMEOUT_MS,
        env: { ...process.env, ...embeddingEnv },
      },
    ) as unknown as ExecFilePromise;

    const childPid = childPromise.pid;

    // Wire abort → tree-kill of child process
    const onAbort = () => {
      if (childPromise.exitCode === null) {
        this.killChildTree(childPid);
      }
    };
    op.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Early out: if cancelled before exec even started
      if (op.isCancelled) return;

      await (childPromise as Promise<{ stdout: string; stderr: string }>);

      // Post-completion cancellation check
      if (op.isCancelled) return;

      log("Vectorization sync complete");
      if (this._isActive) {
        this.updateStatusBar("$(eye) Auto-Vectorization", true);
      } else {
        this.updateStatusBar("", false);
      }
    } catch (error: unknown) {
      // Distinguish cancellation from real errors
      if (
        op.isCancelled ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        log("Vectorization sync cancelled");
        return;
      }
      logError("Vectorization sync failed", error);
      if (this._isActive) {
        this.updateStatusBar("$(warning) Vectorization Error", true);
      }
      this.showThrottledError();
    } finally {
      // ALWAYS clean up (prevents memory leak from listener references)
      op.signal.removeEventListener("abort", onAbort);
      op.dispose();
      if (this._activeSyncOp === op) {
        this._activeSyncOp = null;
      }
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private getCliPath(): string {
    return this.isBundled
      ? path.join(this.mcpServerPath!, "cli.mjs")
      : path.join(this.mcpServerPath!, "dist", "cli.js");
  }

  private async startWatcherProcess(): Promise<boolean> {
    if (!this.mcpServerPath) return false;

    const cliPath = this.getCliPath();
    const projectPath = this.workspaceFolder.uri.fsPath;

    try {
      // Verify CLI exists and supports watch
      const { stdout } = await execFileAsync("node", [cliPath, "--help"], {
        timeout: 5000,
      });
      if (!stdout.includes("watch")) {
        log("MCP CLI doesn't support watch command");
        return false;
      }
    } catch {
      logError("MCP CLI unreachable");
      return false;
    }

    // Spawn with proper process reference for clean lifecycle management
    const embeddingEnv = this.getEmbeddingEnvVars();
    const cloudEnv: Record<string, string> = {};
    if (this._cloudBackedMode && this._cloudManifestPath) {
      cloudEnv.CLOUD_MANIFEST_PATH = this._cloudManifestPath;
    }
    const child = spawn("node", ["--max-old-space-size=512", cliPath, "watch", projectPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: { ...process.env, ...embeddingEnv, ...cloudEnv },
    });

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      log(`[watcher] ${line}`);
      this.parseWatcherOutput(line);
    });

    child.stderr?.on("data", (data: Buffer) => {
      logError(`[watcher] ${data.toString().trim()}`);
    });

    child.on("exit", (code, signal) => {
      log(`Watcher process exited (code=${code}, signal=${signal})`);
      this.watcherProcess = null;

      if (this._isActive) {
        // Unexpected exit — try to restart
        this.handleUnexpectedExit();
      }
    });

    child.on("error", (err) => {
      logError("Watcher process error", err);
      this.watcherProcess = null;
      if (this._isActive) {
        this.handleUnexpectedExit();
      }
    });

    this.watcherProcess = child;
    log(`Watcher process started (PID: ${child.pid})`);
    return true;
  }

  /**
   * Kill a child process tree by PID. On Windows uses taskkill /t /f for
   * reliable tree-kill. On Linux/macOS uses process.kill with SIGTERM.
   * No-op if pid is undefined or process is already dead.
   */
  private killChildTree(pid: number | undefined): void {
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Process already dead — expected
    }
  }

  private killWatcherProcess(): void {
    if (this.watcherProcess) {
      const pid = this.watcherProcess.pid;
      this.killChildTree(pid);
      if (this.watcherProcess && !this.watcherProcess.killed) {
        try {
          this.watcherProcess.kill(); // fallback
        } catch {
          // already dead
        }
      }
      this.watcherProcess = null;
      log(`Watcher process killed (PID: ${pid})`);
    }
  }

  private async handleUnexpectedExit(): Promise<void> {
    // Mutex: prevent concurrent restart attempts from exit + error + health check
    if (this._restarting) return;
    this._restarting = true;

    try {
      this.restartAttempts++;
      if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
        this._isActive = false;
        this.updateStatusBar("$(error) Watcher Failed", true);
        vscode.window.showErrorMessage(
          `Project Brain: Watcher crashed ${MAX_RESTART_ATTEMPTS} times. Auto-vectorization disabled. Use "Start Auto-Vectorization" to retry.`,
        );
        return;
      }

      log(
        `Restarting watcher (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})...`,
      );
      this.updateStatusBar("$(sync~spin) Restarting watcher...", true);

      // Exponential backoff: 2s, 4s, 8s
      const delay = 2000 * Math.pow(2, this.restartAttempts - 1);
      await new Promise((r) => setTimeout(r, delay));

      const success = await this.startWatcherProcess();
      if (success) {
        this.updateStatusBar("$(eye) Auto-Vectorization", true);
        log("Watcher restarted successfully");
      } else if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
        this._restarting = false; // allow next attempt
        await this.handleUnexpectedExit();
      }
    } finally {
      this._restarting = false;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      if (!this._isActive) return;

      if (!this.watcherProcess || this.watcherProcess.exitCode !== null) {
        log("Health check: watcher process is dead, restarting...");
        this.handleUnexpectedExit();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async showThrottledError(): Promise<void> {
    const lastError = this.context.globalState.get<number>(
      "lastVectorizationError",
      0,
    );
    const now = Date.now();
    if (now - lastError > 60000) {
      vscode.window.showWarningMessage(
        "Project Brain: Vectorization failed. Check output console for details.",
      );
      await this.context.globalState.update("lastVectorizationError", now);
    }
  }

  /**
   * Parse watcher stdout to detect vectorization activity and update the
   * status bar with a live indicator showing which file is being processed.
   */
  /** Accumulated files during a vectorization batch parse */
  private _batchFiles: string[] = [];
  private _batchTimer: NodeJS.Timeout | null = null;

  private parseWatcherOutput(line: string): void {
    const lower = line.toLowerCase();

    // Detect start of vectorization activity
    const isActivity =
      lower.includes("vectoriz") ||
      lower.includes("indexing") ||
      lower.includes("processing") ||
      lower.includes("embedding") ||
      lower.includes("changed") ||
      lower.includes("updated") ||
      lower.includes("chunk");

    if (isActivity) {
      // Try to extract a filename from the line
      const fileMatch =
        line.match(
          /(?:file|path|changed|processing|indexing)[:\s]+['"]?([^\s'"]+\.[a-z]{1,10})/i,
        ) ?? line.match(/([\w./-]+\.[a-z]{1,10})/i);

      const fileName = fileMatch ? fileMatch[1].split(/[\\/]/).pop() || "" : "";
      this._lastFileProcessed = fileName;
      this._filesProcessed++;
      if (fileName) this._batchFiles.push(fileName);

      this.setVectorizingState(true, fileName);

      // Auto-reset to idle after 4s of silence
      if (this._vectorizeTimer) clearTimeout(this._vectorizeTimer);
      this._vectorizeTimer = setTimeout(() => {
        this.setVectorizingState(false);
      }, 4000);
    }

    // Parse chunk counts from watcher output: "Updated: +5 -2 chunks"
    const chunkMatch = lower.match(/\+(\d+)\s+-?(\d+)\s+chunk/);
    let parsedAdded = 0;
    let parsedRemoved = 0;
    if (chunkMatch) {
      parsedAdded = parseInt(chunkMatch[1], 10);
      parsedRemoved = parseInt(chunkMatch[2], 10);
    }

    // Detect completion signals
    if (
      lower.includes("complete") ||
      lower.includes("done") ||
      lower.includes("finished") ||
      lower.includes("up to date") ||
      chunkMatch
    ) {
      if (this._vectorizeTimer) clearTimeout(this._vectorizeTimer);
      // Brief delay so user sees the "done" state
      this._vectorizeTimer = setTimeout(() => {
        this.setVectorizingState(false);
      }, 1500);

      // Emit batch completion event (debounced 2s to coalesce rapid batches)
      if (this._batchTimer) clearTimeout(this._batchTimer);
      const batchFiles = [...this._batchFiles];
      this._batchTimer = setTimeout(() => {
        this._onBatchComplete.fire({
          files: batchFiles,
          chunksAdded: parsedAdded,
          chunksRemoved: parsedRemoved,
          timestamp: Date.now(),
        });
        this._batchFiles = [];
      }, 2000);
    }
  }

  private setVectorizingState(active: boolean, fileName?: string): void {
    this._vectorizing = active;

    if (!this._isActive) return;

    if (active) {
      const label = fileName
        ? `$(sync~spin) Vectorizing: ${fileName}`
        : "$(sync~spin) Vectorizing...";
      this.statusBarItem.text = label;
      this.statusBarItem.tooltip = `Project Brain — Vectorizing\nFiles processed this session: ${this._filesProcessed}\nLast: ${this._lastFileProcessed || "—"}`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = "$(eye) Auto-Vectorization";
      this.statusBarItem.tooltip = `Project Brain — Watching for changes\nFiles processed this session: ${this._filesProcessed}`;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
    }
  }

  private updateStatusBar(text: string, show: boolean): void {
    if (show) {
      this.statusBarItem.text = text;
      this.statusBarItem.tooltip = text;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this._isActive = false;
    this.cancelSync();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this._vectorizeTimer) {
      clearTimeout(this._vectorizeTimer);
      this._vectorizeTimer = null;
    }
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this.killWatcherProcess();
    this.updateStatusBar("", false);
    this.statusBarItem.dispose();
    this._onBatchComplete.dispose();
  }
}
