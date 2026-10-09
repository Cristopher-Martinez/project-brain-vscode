import {
  generateReactHtml,
  getProjectStats,
  loadConversationHistory,
  scanDocsRootDir,
  scanMemoryDir,
  searchConversationHistoryEntries,
} from "./brain-hq-helpers";
import { disposeLearningHandler } from "./brain-hq-learning-handler";
import { handleBrainHqMessage } from "./brain-hq-message-handler";
/**
 * Brain HQ — Command Center for Project Brain.
 *
 * WebviewPanel with 6 tabs:
 *   1. Dashboard — Project stats, quick actions, agent identity
 *   2. Swarm Live — Real-time swarm worker monitoring
 *   3. Orchestration — Agent marketplace + persistent multi-agent sessions
 *   4. Memory — Browse .project-brain/memory/ visually
 *   5. Sessions — Timeline of session handoffs
 *   6. Settings — Agent identity + preferences (future)
 *
 * Architecture: follows admin-panel.ts pattern (inline HTML, postMessage).
 * State bridge: subscribes to swarm-state + orchestration-state EventEmitters.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AgentIdentityManager } from "./agent-identity";
import { AgentRegistry } from "./agent-registry";
import { onDidChangeLoopControl } from "./loop-control";
import { getAllLoopStates, onDidChangeLoopState } from "./loop-engine";
import type { McpGateway } from "./mcp-gateway";
import { McpSmokeLoop, type McpSmokeLoopUpdate } from "./mcp-smoke-loop";
import type { ModelRouter } from "./model-router";
import type { OpinionBank } from "./opinion-bank";
import { onDidChangeOrchState } from "./orchestration-state";
import { onDidChangeBridgeState, onDidEmitBridgeEvent } from "./auto-loop-events";
import {
  getAllBridgeSessionViews,
  getBridgeSessionView,
} from "./auto-loop-bridge-manager";
import { getSwarmState, onDidChangeSwarmState } from "./swarm-state";

// ─── Types ──────────────────────────────────────────────────────────────────

import type { OrchestrationManager } from "./orchestration-manager";

export interface HQContext {
  extensionUri: vscode.Uri;
  workspaceFolder: vscode.WorkspaceFolder;
  memoryPath: string;
  identityManager?: AgentIdentityManager;
  opinionBank?: OpinionBank;
  agentRegistry?: AgentRegistry;
  modelRouter?: ModelRouter;
  orchestrationManager?: OrchestrationManager;
  getSaasClient?: () => any | null;
  log: (msg: string) => void;
}

// ─── BrainHQPanel ───────────────────────────────────────────────────────────

export class BrainHQPanel {
  public static currentPanel: BrainHQPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly ctx: HQContext;
  private disposables: vscode.Disposable[] = [];
  private activeTab = "dashboard";
  /** Tab to navigate to once webview is ready (set before constructor completes). */
  public pendingTab: string | undefined;

  private readonly mcpSmokeLoop = new McpSmokeLoop();
  private gateway: McpGateway | null = null;
  private mcpSmokeLoopState: McpSmokeLoopUpdate = {
    attempt: 0,
    consecutiveOk: 0,
    running: false,
    done: false,
    pass: undefined,
  };
  private mcpSmokeStopRequestedByUser = false;
  private tabConfigInterval: ReturnType<typeof setInterval> | null = null;

  public static createOrShow(ctx: HQContext, initialTab?: string): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (BrainHQPanel.currentPanel) {
      BrainHQPanel.currentPanel.panel.reveal(column);
      BrainHQPanel.currentPanel.refresh();
      if (initialTab) {
        BrainHQPanel.currentPanel.navigateToTab(initialTab);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "projectBrain.brainHQ",
      "🧠 Brain HQ",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(ctx.extensionUri, "dist", "webview-ui"),
        ],
      },
    );

    BrainHQPanel.currentPanel = new BrainHQPanel(panel, ctx);
    if (initialTab) {
      // Defer navigation until webview is ready
      BrainHQPanel.currentPanel.pendingTab = initialTab;
    }
  }

  private constructor(panel: vscode.WebviewPanel, ctx: HQContext) {
    this.panel = panel;
    this.ctx = ctx;

    const onMcpSmokeUpdate = (state: McpSmokeLoopUpdate) => {
      this.mcpSmokeLoopState = state;
      this.panel.webview.postMessage({
        type: "mcpSmokeLoopUpdate",
        data: state,
      });

      if (!state.done) return;
      if (this.mcpSmokeStopRequestedByUser) return;

      if (state.pass) {
        vscode.window.showInformationMessage(
          "✅ MCP Smoke Loop (agent-orchestrator): PASS",
        );
      } else {
        vscode.window.showErrorMessage(
          "❌ MCP Smoke Loop (agent-orchestrator): FAIL",
        );
      }
    };
    this.mcpSmokeLoop.on("update", onMcpSmokeUpdate);
    this.disposables.push({
      dispose: () => this.mcpSmokeLoop.off("update", onMcpSmokeUpdate),
    });

    this.refresh();

    // Tab config polling (every 30s) from SaaS backend
    if (this.ctx.getSaasClient) {
      this.tabConfigInterval = setInterval(() => {
        this.refreshTabConfig();
        this.refreshExtensionUpdate();
      }, 30_000);
    }

    // Refresh tab config immediately when panel becomes visible
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          this.refreshTabConfig();
        }
      },
      null,
      this.disposables,
    );

    // Dispose cleanup
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Swarm state → webview bridge
    this.disposables.push(
      onDidChangeSwarmState((state) => {
        this.panel.webview.postMessage({
          type: "swarmUpdate",
          data: state,
        });
      }),
    );

    // Orchestration state → webview bridge
    this.disposables.push(
      onDidChangeOrchState((state) => {
        this.panel.webview.postMessage({
          type: "orchUpdate",
          data: state,
        });
      }),
    );

    // Loop state → webview bridge
    this.disposables.push(
      onDidChangeLoopState((state) => {
        this.panel.webview.postMessage({
          type: "loopUpdate",
          data: state,
        });

        // Keep bridge workerLoopState in sync with live loop transitions.
        for (const bridgeView of getAllBridgeSessionViews()) {
          this.panel.webview.postMessage({
            type: "autoLoopBridgeSessionUpdated",
            session: bridgeView,
          });
        }
      }),
    );

    // Loop control (pause/resume) → webview bridge
    this.disposables.push(
      onDidChangeLoopControl(({ sessionId, state: controlState }) => {
        this.panel.webview.postMessage({
          type: "loopControlUpdate",
          sessionId,
          controlState,
        });
      }),
    );

    // Auto Loop Bridge state → webview bridge (convert to View before posting)
    this.disposables.push(
      onDidChangeBridgeState((state) => {
        const view = getBridgeSessionView(state.sessionId);
        if (view) {
          this.panel.webview.postMessage({
            type: "autoLoopBridgeSessionUpdated",
            session: view,
          });
        }
      }),
    );

    // Synthesis pushed → auto-navigate to bridge tab and select the session
    this.disposables.push(
      onDidEmitBridgeEvent((event) => {
        if (event.type === "synthesis_pushed") {
          const view = getBridgeSessionView(event.sessionId);
          if (view) {
            this.panel.webview.postMessage({
              type: "autoLoopBridgeSessionUpdated",
              session: view,
            });
            this.panel.webview.postMessage({
              type: "autoLoopBridgeActiveChanged",
              sessionId: event.sessionId,
            });
            this.navigateToTab("bridge");
          }
        }
      }),
    );

    // Loop state changes → refresh bridge views (workerLoopState is computed on-the-fly)
    this.disposables.push(
      onDidChangeLoopState(() => {
        const views = getAllBridgeSessionViews();
        if (views.length > 0) {
          this.panel.webview.postMessage({
            type: "autoLoopBridgeState",
            sessions: views,
          });
        }
      }),
    );

    // Handle webview → extension messages
    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          this.ctx.log(`[BrainHQ] message error: ${err}`);
        }
      },
      null,
      this.disposables,
    );
  }

  // ─── Gateway Ref ────────────────────────────────────────────────────

  public setGateway(gw: McpGateway | null): void {
    this.gateway = gw;
  }

  // ─── Message Handler ────────────────────────────────────────────────

  private async handleMessage(msg: any): Promise<void> {
    await handleBrainHqMessage(msg, {
      ctx: this.ctx,
      panel: this.panel,
      mcpSmokeLoop: this.mcpSmokeLoop,
      gateway: this.gateway,
      refresh: () => this.refresh(),
      sendInitialData: () => this.sendInitialData(),
      sendMemoryFiles: () => this.sendMemoryFiles(),
      sendSessionHistory: () => this.sendSessionHistory(),
      sendConversationHistory: () => this.sendConversationHistory(),
      searchConversationHistory: (q: string, m: "search" | "temporal") =>
        this.searchConversationHistory(q, m),
      setActiveTab: (tab: string) => {
        this.activeTab = tab;
      },
      setMcpSmokeStopRequestedByUser: (val: boolean) => {
        this.mcpSmokeStopRequestedByUser = val;
      },
      consumePendingTab: () => {
        const tab = this.pendingTab;
        this.pendingTab = undefined;
        return tab;
      },
    });
  }

  /** Navigate the webview to a specific tab. */
  public navigateToTab(tab: string): void {
    this.activeTab = tab;
    this.pendingTab = tab; // Survives refresh so webviewReady can deliver it
    this.panel.webview.postMessage({ type: "navigateToTab", tab });
  }

  // ─── Data Providers ─────────────────────────────────────────────────

  private getStats() {
    return getProjectStats({
      memoryPath: this.ctx.memoryPath,
      workspaceFsPath: this.ctx.workspaceFolder.uri.fsPath,
      opinionCount: this.ctx.opinionBank?.count ?? 0,
      loadIdentity: () => this.ctx.identityManager?.loadIdentity(),
    });
  }

  private async sendMemoryFiles(): Promise<void> {
    const memoryFiles = await scanMemoryDir(this.ctx.memoryPath, "");
    // Also scan parent docs/ directory for .md files
    const docsDir = path.dirname(this.ctx.memoryPath);
    const memoryDirName = path.basename(this.ctx.memoryPath);
    const docsFiles = await scanDocsRootDir(docsDir, memoryDirName);
    const files = [...memoryFiles, ...docsFiles];
    await this.panel.webview.postMessage({
      type: "memoryFiles",
      data: files,
    });
  }

  private async sendSessionHistory(): Promise<void> {
    const handoffPath = path.join(this.ctx.memoryPath, "07_SESSION_HANDOFF.md");
    let content = "";
    try {
      if (fs.existsSync(handoffPath)) {
        content = fs.readFileSync(handoffPath, "utf-8");
      }
    } catch {
      /* ignore */
    }
    await this.panel.webview.postMessage({
      type: "sessionHistory",
      data: content,
    });
  }

  private async sendConversationHistory(): Promise<void> {
    const data = loadConversationHistory(this.ctx.memoryPath);
    await this.panel.webview.postMessage({ type: "conversationHistory", data });
  }

  private async searchConversationHistory(
    query: string,
    mode: "search" | "temporal",
  ): Promise<void> {
    const data = searchConversationHistoryEntries(
      this.ctx.memoryPath,
      query,
      mode,
    );
    await this.panel.webview.postMessage({
      type: "conversationSearchResults",
      data,
      query,
    });
  }

  // ─── Refresh ────────────────────────────────────────────────────────

  public async refresh(): Promise<void> {
    this.panel.webview.html = generateReactHtml(
      this.panel.webview,
      this.ctx.extensionUri,
    );
  }

  /** Sends initialData to the webview after it signals 'webviewReady'. */
  public async sendInitialData(): Promise<void> {
    const stats = this.getStats();
    const swarm = getSwarmState();
    const allLoops = getAllLoopStates();
    let loop: import("./loop-engine").LoopUiState | undefined;
    for (const [, s] of allLoops) {
      if (s.state !== "idle" && s.state !== "completed") {
        loop = s;
        break;
      }
    }
    const loopMaxCyclesDefault = vscode.workspace
      .getConfiguration("projectBrain")
      .get<number>("loop.maxCycles", 15);
    await this.panel.webview.postMessage({
      type: "initialData",
      stats,
      swarm,
      loop,
      memoryPath: this.ctx.memoryPath,
      loopMaxCyclesDefault,
      initialTab: this.pendingTab || undefined,
    });
    await this.panel.webview.postMessage({
      type: "mcpSmokeLoopUpdate",
      data: this.mcpSmokeLoopState,
    });
    // Gateway state piggybacked on init (no extra round-trip)
    const gwTokens = this.gateway ? await this.gateway.listTokens() : [];
    const gwLog = this.gateway?.getRequestLog() ?? [];
    await this.panel.webview.postMessage({
      type: "gatewayState",
      data: {
        running: this.gateway?.isRunning() ?? false,
        port: this.gateway?.getPort() ?? 3200,
        tokens: gwTokens.map((t) => ({
          label: t.label,
          scopes: t.scopes,
          createdAt: t.createdAt,
          lastUsed: t.lastUsed ?? null,
          expiresAt: t.expiresAt ?? null,
        })),
        sessions: this.gateway?.getSessionCount?.() ?? 0,
        requestLog: gwLog,
      },
    });
    // Tab visibility config from SaaS
    const saasClient = this.ctx.getSaasClient?.();
    if (saasClient) {
      try {
        const tabs = await saasClient.fetchTabConfig();
        await this.panel.webview.postMessage({ type: "tabConfig", tabs });
      } catch { /* tabs default to visible */ }
    }
  }

  /** Fetch tab visibility config from SaaS and push to webview. */
  public async refreshTabConfig(): Promise<void> {
    const saasClient = this.ctx.getSaasClient?.();
    if (!saasClient) return;
    try {
      const tabs = await saasClient.fetchTabConfig();
      await this.panel.webview.postMessage({ type: "tabConfig", tabs });
    } catch { /* silent — tabs default to visible */ }
  }

  /** Check for extension updates and push result to webview. */
  public async refreshExtensionUpdate(): Promise<void> {
    const saasClient = this.ctx.getSaasClient?.();
    if (!saasClient) return;
    try {
      const result = await saasClient.checkExtensionUpdate();
      const currentVersion =
        vscode.extensions.getExtension("crismart.project-brain")
          ?.packageJSON?.version ?? "0.0.0";
      const hasUpdate = result.available && result.version !== currentVersion;
      await this.panel.webview.postMessage({
        type: "extensionUpdateResult",
        available: hasUpdate,
        currentVersion,
        latestVersion: result.version,
        publishedAt: result.publishedAt,
        changelog: result.changelog,
        size: result.size,
      });
    } catch { /* silent */ }
  }

  /** Refresh hibernated loops list in webview (call after hibernate/resume operations). */
  public async refreshHibernatedLoops(): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return;
    const { listHibernatedLoops } = await import("./loop-hibernate");
    const hibernated = listHibernatedLoops(wsRoot).map((h) => ({
      sessionId: h.sessionId,
      goal: h.goal || "(sin objetivo)",
      currentRound: h.currentRound ?? 0,
      branchName: h.branchName,
      hibernatedAt: h.hibernatedAt,
      summary: h.summary || "",
    }));
    await this.panel.webview.postMessage({
      type: "hibernatedLoops",
      data: hibernated,
    });
  }

  /** Refresh finalized loops list in webview. */
  public async refreshFinalizedLoops(): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return;
    const { listFinalizedLoops } = await import("./loop-finalize");
    const finalized = listFinalizedLoops(wsRoot).map((f) => ({
      sessionId: f.sessionId,
      goal: f.goal || "(sin objetivo)",
      totalRounds: f.totalRounds ?? 0,
      branchName: f.branchName,
      finalizedAt: f.finalizedAt,
      summary: f.summary || "",
    }));
    await this.panel.webview.postMessage({
      type: "finalizedLoops",
      data: finalized,
    });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────

  private dispose(): void {
    BrainHQPanel.currentPanel = undefined;

    if (this.tabConfigInterval) {
      clearInterval(this.tabConfigInterval);
      this.tabConfigInterval = null;
    }

    try {
      this.mcpSmokeLoop.dispose();
    } catch {
      /* ignore */
    }

    disposeLearningHandler();

    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
