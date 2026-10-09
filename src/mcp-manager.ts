import { execFile } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { log, logError, logWarn } from "./logger";

const execFileAsync = promisify(execFile);

/** Must match the normalization logic in the MCP RAG server (storage.ts) */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function getProjectId(projectPath: string): string {
  return createHash("md5")
    .update(normalizePath(projectPath))
    .digest("hex")
    .slice(0, 12);
}

export class MCPManager {
  private mcpServerPath: string | null = null;
  /** True if using the bundled server inside the extension */
  private isBundled = false;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private context: vscode.ExtensionContext,
  ) {}

  getMCPServerPath(): string | null {
    return this.mcpServerPath;
  }

  /** Whether we're using the bundled MCP server */
  getIsBundled(): boolean {
    return this.isBundled;
  }

  /** Get the CLI entry point path (handles bundled vs external) */
  private getCliPath(): string {
    if (!this.mcpServerPath) {
      throw new Error("MCP server path not set");
    }
    return this.isBundled
      ? path.join(this.mcpServerPath, "cli.mjs")
      : path.join(this.mcpServerPath, "dist", "cli.js");
  }

  private async pathExists(fsPath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Determine whether a given MCP server folder is bundled (cli.mjs) or external (dist/cli.js).
   * Returns null when neither entrypoint exists.
   */
  private async detectServerLayout(
    mcpPath: string,
  ): Promise<{ isBundled: boolean } | null> {
    const bundledCli = path.join(mcpPath, "cli.mjs");
    if (await this.pathExists(bundledCli)) {
      return { isBundled: true };
    }

    const externalCli = path.join(mcpPath, "dist", "cli.js");
    if (await this.pathExists(externalCli)) {
      return { isBundled: false };
    }

    return null;
  }

  async setupMCP(): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    let mcpPath = config.get<string>("mcpServerPath", "");

    // If the user set a custom path, auto-detect whether it's bundled or external.
    if (mcpPath) {
      const layout = await this.detectServerLayout(mcpPath);
      if (!layout) {
        logWarn(
          `Invalid projectBrain.mcpServerPath (no cli.mjs or dist/cli.js found): ${mcpPath}`,
        );
        mcpPath = "";
      } else {
        this.isBundled = layout.isBundled;
      }
    }

    if (!mcpPath) {
      // Priority 1: Bundled CLI inside the extension
      const bundledPath = path.join(
        this.context.extensionPath,
        "dist",
        "mcp-server",
      );
      const bundledCli = path.join(bundledPath, "cli.mjs");
      try {
        const uri = vscode.Uri.file(bundledCli);
        await vscode.workspace.fs.stat(uri);
        mcpPath = bundledPath;
        this.isBundled = true;
        log(`Using bundled RAG CLI: ${bundledPath}`);
      } catch {
        // Bundled not found — try external
      }

      // Priority 2: External server path
      if (!mcpPath) {
        const homeDir =
          process.env.HOME ||
          process.env.USERPROFILE ||
          process.env.HOMEPATH ||
          "";
        if (!homeDir) {
          logWarn("No HOME directory found — skipping external RAG CLI search");
        }
        const candidates = homeDir
          ? [
              path.join(homeDir, "mcp-servers", "rag-docs"),
              path.join(homeDir, ".mcp-servers", "rag-docs"),
            ]
          : [];

        for (const candidate of candidates) {
          // Check for external CLI (dist/cli.js)
          const cliPath = path.join(candidate, "dist", "cli.js");
          try {
            const uri = vscode.Uri.file(cliPath);
            await vscode.workspace.fs.stat(uri);
            mcpPath = candidate;
            break;
          } catch {
            // Not found
          }
        }
      }
    }

    if (!mcpPath) {
      const answer = await vscode.window.showWarningMessage(
        "RAG backend not found. Would you like to install it?",
        "Install",
        "Specify Path",
        "Skip",
      );

      if (answer === "Install") {
        await this.installMCPServer();
      } else if (answer === "Specify Path") {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select RAG Backend Folder",
        });

        if (selected && selected[0]) {
          const chosenPath = selected[0].fsPath;
          const layout = await this.detectServerLayout(chosenPath);
          if (!layout) {
            vscode.window.showErrorMessage(
              "Selected folder is not a valid RAG backend (missing cli.mjs or dist/cli.js).",
            );
          } else {
            mcpPath = chosenPath;
            this.isBundled = layout.isBundled;
            await config.update(
              "mcpServerPath",
              mcpPath,
              vscode.ConfigurationTarget.Global,
            );
          }
        }
      }
    }

    if (mcpPath) {
      this.mcpServerPath = mcpPath;
    }
  }

  /** Build environment variables for the MCP server from VS Code settings */
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

  /** Check if RAG backend (CLI) is ready to use */
  isReady(): boolean {
    return this.mcpServerPath !== null;
  }

  async indexProject(): Promise<void> {
    if (!this.mcpServerPath) {
      return;
    }

    const cliPath = this.getCliPath();
    const projectPath = this.workspaceFolder.uri.fsPath;
    const embeddingEnv = this.getEmbeddingEnvVars();

    try {
      await execFileAsync(
        "node",
        [cliPath, "vectorize", projectPath],
        {
          timeout: 1_800_000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ...embeddingEnv },
        },
      );
      log("Project indexed with RAG");
    } catch (error) {
      logError(
        `Failed to index project (cli=${cliPath}, bundled=${this.isBundled})`,
        error,
      );
      const msg = error instanceof Error ? error.message : String(error ?? "");
      vscode.window.showErrorMessage(
        msg
          ? `Failed to index project with RAG. CLI: ${cliPath}. Error: ${msg}`
          : `Failed to index project with RAG. Check MCP server path. (CLI: ${cliPath})`,
      );
    }
  }

  async syncIndex(): Promise<void> {
    if (!this.mcpServerPath) {
      return;
    }

    const cliPath = this.getCliPath();
    const projectPath = this.workspaceFolder.uri.fsPath;
    const embeddingEnv = this.getEmbeddingEnvVars();

    try {
      await execFileAsync("node", [cliPath, "vectorize", projectPath], {
        timeout: 1_800_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...embeddingEnv },
      });
      log("Index synced");
    } catch (error) {
      logError("Failed to sync index", error);
    }
  }

  /**
   * Search project memory using the CLI.
   * Returns formatted search results as text.
   */
  async searchMemory(
    query: string,
    topK = 5,
    options?: { category?: string; topic?: string },
  ): Promise<string> {
    if (!this.mcpServerPath) {
      return "MCP server not configured. Run 'Project Brain: Initialize' first.";
    }

    const cliPath = this.getCliPath();
    const projectPath = this.workspaceFolder.uri.fsPath;
    const embeddingEnv = this.getEmbeddingEnvVars();

    const args = [cliPath, "search", query, "-p", projectPath, "-k", String(topK)];
    if (options?.category) {
      args.push("-c", options.category);
    }
    if (options?.topic) {
      args.push("-t", options.topic);
    }

    try {
      const { stdout } = await execFileAsync(
        "node",
        args,
        {
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, ...embeddingEnv },
        },
      );
      return stdout.trim() || "No results found.";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`Memory search failed: ${msg}`);
      return `Search failed: ${msg}`;
    }
  }

  async getIndexStats(): Promise<{
    chunks: number;
    files: number;
    lastUpdated: number;
  } | null> {
    if (!this.mcpServerPath) {
      return null;
    }

    const homeDir =
      process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH;
    const projectId = getProjectId(this.workspaceFolder.uri.fsPath);
    const storagePath = path.join(
      homeDir!,
      ".mcp-rag-docs",
      `${projectId}.json`,
    );

    try {
      const uri = vscode.Uri.file(storagePath);
      const content = await vscode.workspace.fs.readFile(uri);
      const index = JSON.parse(content.toString());

      return {
        chunks: index.chunks?.length || 0,
        files: Object.keys(index.fileHashes || {}).length,
        lastUpdated: index.lastUpdated || Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async installMCPServer(): Promise<void> {
    // The MCP server should be bundled inside the extension.
    // If we got here, the bundle is missing — guide the user.
    const bundledPath = path.join(
      this.context.extensionPath,
      "dist",
      "mcp-server",
      "index.mjs",
    );

    const panel = vscode.window.createWebviewPanel(
      "mcpInstall",
      "MCP RAG Server Setup",
      vscode.ViewColumn.One,
      {},
    );

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: var(--vscode-font-family); padding: 20px;">
        <h2>MCP RAG Server</h2>
        <p>The MCP server should be bundled with this extension at:</p>
        <pre>${bundledPath}</pre>
        <p>If it's missing, try reinstalling the extension or building from source:</p>
        <pre>
cd [extension-source]
npm install
npm run compile
        </pre>
        <p>Alternatively, install the standalone server:</p>
        <pre>
git clone https://github.com/Cristopher-Martinez/project-brain.git
cd project-brain/server
npm install &amp;&amp; npm run build
        </pre>
        <p>Then set <code>projectBrain.mcpServerPath</code> in VS Code settings.</p>
      </body>
      </html>
    `;
  }
}
