// â”€â”€â”€ Extension Entry Point (thin orchestrator) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// All heavy logic is extracted to domain-specific modules.
// This file: activate/deactivate + module-level state + wiring.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// ─── Crash Diagnostic Trap (temporary) ──────────────────────────────────────
const _crashLogPath = path.join(os.tmpdir(), "project-brain-crash.log");
function _writeCrashDiag(label: string, err: unknown): void {
  const ts = new Date().toISOString();
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  const line = `[${ts}] ${label}: ${msg}\n`;
  try { fs.appendFileSync(_crashLogPath, line); } catch { /* best-effort */ }
  console.error(`[Project Brain CRASH] ${label}:`, err);
}
process.on("uncaughtException", (err) => _writeCrashDiag("uncaughtException", err));
process.on("unhandledRejection", (err) => _writeCrashDiag("unhandledRejection", err));
import type { AdminDB } from "./admin-db";
import { AgentIdentityManager } from "./agent-identity";
import { AgentRegistry } from "./agent-registry";
import type { AutoCapture } from "./auto-capture";
import { setupAutoSaveListener } from "./auto-save-listener";
import { Bootstrapper } from "./bootstrapper";
import { ensureProjectBrainDirs, migrateFromLegacyPaths } from "./brain-paths";
import { startGlobalStaleChecker } from "./branch-stale-checker";
import { excludeFromGit, registerCloudCommands } from "./cloud-commands";
import type { CloudSync } from "./cloud-sync";
import type { CronNotificationManager } from "./cron-notifications";
import type { CronScheduler } from "./cron-scheduler";
import type { DualOpinionBank } from "./dual-opinion-bank";
import { deactivateExtension } from "./extension-deactivate";
import { registerExtensionUpdateCommands } from "./extension-update-commands";
import {
  registerNoWorkspaceCommands,
  registerRestrictedCommands,
} from "./extension-guards";
import { initIntelligenceLayer } from "./extension-intelligence";
import type { FolderState } from "./extension-types";
import { cleanupOrphans, restoreState } from "./fork-isolation";
import { GlobalConfigProvider } from "./global-config-provider";
import { setGlobalConfig } from "./global-config-accessor";
import { GlobalKnowledgeManager } from "./global-knowledge";
import type { LearningIngester } from "./learning-ingester";
import {
  registerBatchCommands,
  registerLifecycleCommands,
} from "./lifecycle-commands";
import { appendOutputLine, setOutputChannel } from "./logger";
import { setSecretStorage } from "./brain-hq-bridge-settings-handler";
import type { LoginWebviewProvider } from "./login-webview";
import {
  registerConnectLoopCommand,
  registerLoopCommands,
} from "./loop-commands";
import { listHibernatedLoops } from "./loop-hibernate";
import {
  detectInterruptedLoops,
  showInterruptedLoopNotification,
} from "./loop-recovery";
import type { McpGateway } from "./mcp-gateway";
import { MCPManager } from "./mcp-manager";
import type { MemoryFS } from "./memory-fs";
import type { ModelRouter } from "./model-router";
import type { OfflineManager } from "./offline-manager";
import type { OpinionBank } from "./opinion-bank";
import { OrchestrationManager } from "./orchestration-manager";
import { OrchestratorSpawner } from "./orchestrator-spawner";
import { checkProjectMemory } from "./project-lifecycle";
import { refreshEnabledContextKey } from "./project-lifecycle-utils";
import type { SaaSClient } from "./saas-client";
import { ProjectScanner } from "./scanner";
import { registerSessionCommands } from "./session-commands";
import type { SessionDB } from "./session-db";
import { registerSessionLaunchers } from "./session-launchers";
import type { SkillManager } from "./skill-manager";
import { registerStrategyCommands } from "./strategy-commands";
import { registerGatesCommands } from "./gates-commands";
import { registerOpenCodeCommands } from "./opencode/opencode-commands";
import { startTerminalCwdGuard } from "./terminal-cwd-guard";
import { setupTestIntelligenceWatcher } from "./test-intelligence-watcher";
import { BrainTreeDataProvider } from "./tree-view";
import type { UpgradePromptManager } from "./upgrade-prompts";
import { setWorkspaceStorageRoot } from "./vscode-chat-reader";

const folderStates = new Map<string, FolderState>();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let treeDataProvider: BrainTreeDataProvider;
let activeOpinionBank: OpinionBank | null = null;
let activeAutoCapture: AutoCapture | null = null;
let activeLearningIngester: LearningIngester | null = null;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let reflectInterval: ReturnType<typeof setInterval> | null = null;
let activeSaasClient: SaaSClient | null = null;
let activeOfflineManager: OfflineManager | null = null;
let activeDualOpinionBank: DualOpinionBank | null = null;
let activeSkillManager: SkillManager | null = null;
let activeLoginWebview: LoginWebviewProvider | null = null;
let activeUpgradePrompts: UpgradePromptManager | null = null;
let activeCronScheduler: CronScheduler | null = null;
let activeCronNotifications: CronNotificationManager | null = null;
let activeAdminDb: AdminDB | null = null;
let activeSessionDb: SessionDB | null = null;
let activeMemoryFS: MemoryFS | null = null;
let activeCloudSync: CloudSync | null = null;
let activeModelRouter: ModelRouter | null = null;
let activeAgentRegistry: AgentRegistry | null = null;
let activeGateway: McpGateway | null = null;
let activeGlobalConfig: GlobalConfigProvider | null = null;
let activeGlobalKnowledge: GlobalKnowledgeManager | null = null;
function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  appendOutputLine(`[${ts}] ${msg}`);
}

function projectPathHash(fsPath: string): string {
  return crypto.createHash("sha256").update(fsPath).digest("hex");
}

function getState(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
): FolderState {
  const key = folder.uri.toString();
  let state = folderStates.get(key);
  if (!state) {
    state = {
      bootstrapper: new Bootstrapper(folder, context),
      scanner: new ProjectScanner(folder),
      mcpManager: new MCPManager(folder, context),
      autoVectorizer: null,
      identityManager: new AgentIdentityManager(
        folder,
        log,
        activeGlobalConfig,
      ),
    };
    folderStates.set(key, state);
  }
  return state;
}

async function pickWorkspaceFolder(): Promise<
  vscode.WorkspaceFolder | undefined
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: "Select a workspace folder for Project Brain",
  });
}

function getLifecycleDeps() {
  return {
    folderStates,
    getState,
    treeDataProvider,
    statusBarItem,
    getSaasClient: () => activeSaasClient,
    getLoginWebview: () => activeLoginWebview,
    getSessionDb: () => activeSessionDb,
    getGlobalConfig: () => activeGlobalConfig,
    getGlobalKnowledge: () => activeGlobalKnowledge,
    log,
  };
}
export function activate(context: vscode.ExtensionContext) {
  try { _activateInner(context); } catch (err) {
    _writeCrashDiag("activate() sync throw", err);
    throw err;
  }
}
function _stageLog(stage: string): void {
  const ts = new Date().toISOString();
  const mem = process.memoryUsage();
  const line = `[${ts}] STAGE: ${stage} | rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB\n`;
  try { fs.appendFileSync(path.join(os.tmpdir(), "project-brain-stages.log"), line); } catch { /* */ }
}
function _activateInner(context: vscode.ExtensionContext) {
  _stageLog("activate-start");
  console.log("[Project Brain] activate() called — starting up");
  outputChannel = vscode.window.createOutputChannel("Project Brain");
  context.subscriptions.push(outputChannel);
  setOutputChannel(outputChannel);
  setSecretStorage(context.secrets);
  log("Extension activated");
  activeGlobalConfig = new GlobalConfigProvider(context.globalStorageUri, log);
    setGlobalConfig(activeGlobalConfig);
  activeGlobalKnowledge = new GlobalKnowledgeManager(activeGlobalConfig, log);
  log(
    `[GlobalConfig] scope=${activeGlobalConfig.getScope()}, hasIdentity=${activeGlobalConfig.hasGlobalIdentity()}`,
  );

  _stageLog("global-config-done");
  const orchestrationManager = new OrchestrationManager();

  if (!vscode.workspace.isTrusted) {
    registerRestrictedCommands(context, log);
    return;
  }
  _stageLog("pre-orchestrator-spawner");
  // Auto-spawn is OFF by default: the detached daemon (port 3101) survived VS Code
  // close and accumulated as orphan processes, causing system-wide hard locks.
  // Opt-in via "projectBrain.orchestrator.autoStart" only.
  const orchestratorAutoStart = vscode.workspace
    .getConfiguration("projectBrain.orchestrator")
    .get<boolean>("autoStart", false);
  if (orchestratorAutoStart) {
    const orchestratorSpawner = new OrchestratorSpawner(context.extensionPath);
    context.subscriptions.push(orchestratorSpawner);
    void orchestratorSpawner.start();
  } else {
    log("[OrchestratorSpawner] auto-start disabled (projectBrain.orchestrator.autoStart=false)");
  }
  _stageLog("post-orchestrator-spawner");
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    registerNoWorkspaceCommands(context, log);
    return;
  }
  _stageLog("pre-workspace-setup");
  log(`Workspace folders: ${folders.map((f) => f.name).join(", ")}`);
  for (const f of folders) {
    ensureProjectBrainDirs(f.uri.fsPath);
    // Auto-exclude generated files from git (silent — no UI noise)
    void excludeFromGit(f, true);
    const migrated = migrateFromLegacyPaths(f.uri.fsPath);
    if (migrated.migratedMemory) {
      log(`[${f.name}] Migrated docs/memory/ â†’ .project-brain/memory/`);
    }
    if (migrated.migratedLoops) {
      log(`[${f.name}] Migrated .brain-loops/ â†’ .project-brain/loops/`);
    }
  }

  // Set context key for command enablement (hides commands when no workspace is enabled)
  refreshEnabledContextKey();

  if (context.storageUri) {
    setWorkspaceStorageRoot(path.dirname(context.storageUri.fsPath));
  }
  _stageLog("pre-ui-setup");
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "projectBrain.status";
  context.subscriptions.push(statusBarItem);
  treeDataProvider = new BrainTreeDataProvider();
  context.subscriptions.push(treeDataProvider);
  const treeView = vscode.window.createTreeView("projectBrain.memoryView", {
    treeDataProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  _stageLog("pre-commands-register");
  const lifecycleDeps = { ...getLifecycleDeps(), pickWorkspaceFolder, context };
  registerLifecycleCommands(context, lifecycleDeps);
  registerBatchCommands(context, pickWorkspaceFolder);
  registerSessionLaunchers(context);
  registerLoopCommands(context);
  registerConnectLoopCommand(context);
  _stageLog("pre-hibernated-loops");
  try {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      const hibernated = listHibernatedLoops(wsRoot);
      if (hibernated.length > 0) {
        void vscode.window
          .showInformationMessage(
            `ðŸ’¤ ${hibernated.length} loop(s) hibernado(s) encontrado(s). Â¿Quieres ver la lista?`,
            "Ver loops",
            "Ignorar",
          )
          .then((pick) => {
            if (pick === "Ver loops") {
              void vscode.commands.executeCommand(
                "projectBrain.openBrainHQ",
                "backlog",
              );
            }
          });
      }
    }
  } catch {
    /* non-fatal */
  }
  try {
    const interrupted = detectInterruptedLoops();
    if (interrupted.length > 0) {
      void showInterruptedLoopNotification(interrupted);
    }
  } catch {
    /* non-fatal */
  }
  registerStrategyCommands(context, {
    getCronNotifications: () => activeCronNotifications,
    treeDataProvider,
  });
  registerGatesCommands(context, {
    resolveRoot: async () => (await pickWorkspaceFolder())?.uri.fsPath,
  });
  registerOpenCodeCommands(context, {
    getWorkspaceRoot: async () => (await pickWorkspaceFolder())?.uri.fsPath,
  });
  registerCloudCommands(context, {
    getCloudSync: () => activeCloudSync,
    setCloudSync: (cs) => {
      activeCloudSync = cs;
    },
    getSaasClient: () => activeSaasClient,
    getMemoryFS: () => activeMemoryFS,
    setMemoryFS: (mfs) => {
      activeMemoryFS = mfs;
    },
    folderStates,
    treeDataProvider,
    projectPathHash,
    pickWorkspaceFolder,
  });
  registerExtensionUpdateCommands(context, {
    getSaasClient: () => activeSaasClient,
  });
  registerSessionCommands(context, {
    pickWorkspaceFolder,
    getSessionDb: () => activeSessionDb,
    getAutoCapture: () => activeAutoCapture,
    getGetState: () => getState,
    log,
  });
  _stageLog("pre-intelligence-layer");
  try {
    const refs = initIntelligenceLayer({
      context,
      folders,
      treeView,
      orchestrationManager,
      folderStates,
      treeDataProvider,
      pickWorkspaceFolder,
      getState,
      projectPathHash,
      getGlobalConfig: () => activeGlobalConfig,
      log,
      refs: {
        activeOpinionBank,
        activeAutoCapture,
        activeLearningIngester,
        flushInterval,
        reflectInterval,
        activeSaasClient,
        activeOfflineManager,
        activeDualOpinionBank,
        activeSkillManager,
        activeLoginWebview,
        activeUpgradePrompts,
        activeCronScheduler,
        activeCronNotifications,
        activeAdminDb,
        activeSessionDb,
        activeMemoryFS,
        activeCloudSync,
        activeModelRouter,
        activeAgentRegistry,
        activeGateway,
        activeGlobalKnowledge,
      },
    });
    activeOpinionBank = refs.activeOpinionBank;
    activeAutoCapture = refs.activeAutoCapture;
    activeLearningIngester = refs.activeLearningIngester;
    flushInterval = refs.flushInterval;
    reflectInterval = refs.reflectInterval;
    activeSaasClient = refs.activeSaasClient;
    activeOfflineManager = refs.activeOfflineManager;
    activeDualOpinionBank = refs.activeDualOpinionBank;
    activeSkillManager = refs.activeSkillManager;
    activeLoginWebview = refs.activeLoginWebview;
    activeUpgradePrompts = refs.activeUpgradePrompts;
    activeCronScheduler = refs.activeCronScheduler;
    activeCronNotifications = refs.activeCronNotifications;
    activeAdminDb = refs.activeAdminDb;
    activeSessionDb = refs.activeSessionDb;
    activeMemoryFS = refs.activeMemoryFS;
    activeCloudSync = refs.activeCloudSync;
    activeModelRouter = refs.activeModelRouter;
    activeAgentRegistry = refs.activeAgentRegistry;
    activeGateway = refs.activeGateway;
  } catch (err) {
    _stageLog("intelligence-layer-FAILED");
    log(`Chat participant / LM tools registration failed: ${err}`);
  }
  _stageLog("post-intelligence-layer");
  _stageLog("pre-fork-isolation");
  try {
    const repoRoot = folders[0].uri.fsPath;
    const restored = restoreState(repoRoot);
    if (restored > 0)
      log(`[BranchIsolation] Restored ${restored} session(s) from disk`);
    void cleanupOrphans(repoRoot).then((cleaned) => {
      if (cleaned > 0)
        log(`[BranchIsolation] Cleaned ${cleaned} orphan fork(s)`);
    });
    startGlobalStaleChecker(repoRoot);
    startTerminalCwdGuard(context.subscriptions);
  } catch (err) {
    log(`[BranchIsolation] Init failed (non-fatal): ${err}`);
  }
  setupAutoSaveListener(context, {
    getSessionDb: () => activeSessionDb,
    getState,
    log,
  });
  setupTestIntelligenceWatcher(context, {
    getModelRouter: () => activeModelRouter,
    log,
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        log(`Workspace folder added: ${added.name}`);
        checkProjectMemory(added, context, getLifecycleDeps()).catch((err) =>
          log(`[${added.name}] checkProjectMemory error: ${err}`),
        );
      }
      for (const removed of e.removed) {
        log(`Workspace folder removed: ${removed.name}`);
        const key = removed.uri.toString();
        const st = folderStates.get(key);
        if (st?.autoVectorizer) st.autoVectorizer.dispose();
        folderStates.delete(key);
      }
      refreshEnabledContextKey();
    }),
  );
  _stageLog("pre-checkProjectMemory");
  log(`Checking memory for ${folders.length} folder(s)...`);
  for (const folder of folders) {
    checkProjectMemory(folder, context, getLifecycleDeps()).catch((err) =>
      log(`[${folder.name}] checkProjectMemory error: ${err}`),
    );
  }
  _stageLog("activate-complete");
}

export async function deactivate(): Promise<void> {
  await deactivateExtension({
    flushInterval,
    reflectInterval,
    learningIngester: activeLearningIngester,
    autoCapture: activeAutoCapture,
    opinionBank: activeOpinionBank,
    dualOpinionBank: activeDualOpinionBank,
    offlineManager: activeOfflineManager,
    loginWebview: activeLoginWebview,
    sessionDb: activeSessionDb,
    adminDb: activeAdminDb,
    cronScheduler: activeCronScheduler,
    statusBarItem,
    folderStates,
    gateway: activeGateway,
    globalKnowledge: activeGlobalKnowledge,
  });
  activeOpinionBank = null;
  activeAutoCapture = null;
  activeLearningIngester = null;
  flushInterval = null;
  reflectInterval = null;
  activeSaasClient = null;
  activeOfflineManager = null;
  activeDualOpinionBank = null;
  activeSkillManager = null;
  activeLoginWebview = null;
  activeUpgradePrompts = null;
  activeCronScheduler = null;
  activeCronNotifications = null;
  activeAdminDb = null;
  activeSessionDb = null;
  activeMemoryFS = null;
  activeCloudSync = null;
  activeModelRouter = null;
  activeAgentRegistry = null;
  activeGlobalConfig = null;
  activeGlobalKnowledge = null;
}
