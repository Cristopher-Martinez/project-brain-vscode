import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

function _istageLog(stage: string): void {
  const ts = new Date().toISOString();
  const mem = process.memoryUsage();
  const line = `[${ts}] INTEL: ${stage} | rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB\n`;
  try { fs.appendFileSync(path.join(os.tmpdir(), "project-brain-stages.log"), line); } catch { /* */ }
}
import { AdaptiveLatencyTracker } from "./adaptive-latency";
import type { AdminDB } from "./admin-db";
import { AgentRegistry } from "./agent-registry";
import type { AutoCapture } from "./auto-capture";
import { registerChatParticipant } from "./chat-participant";
import type { CloudSync } from "./cloud-sync";
import { registerCronCommands } from "./cron-commands";
import { initializeCronLayer } from "./cron-init";
import type { CronNotificationManager } from "./cron-notifications";
import type { CronScheduler } from "./cron-scheduler";
import { registerDelegateCommand } from "./delegate-command";
import type { DualOpinionBank } from "./dual-opinion-bank";
import { initializeGateway } from "./extension-gateway";
import type { FolderState } from "./extension-types";
import { GlobalConfigProvider } from "./global-config-provider";
import { GlobalKnowledgeManager } from "./global-knowledge";
import { registerIdentityCommands } from "./identity-commands";
import type { LearningIngester } from "./learning-ingester";
import { registerLMTools } from "./lm-tools";
import type { LoginWebviewProvider } from "./login-webview";
import { McpGateway } from "./mcp-gateway";
import type { MemoryFS } from "./memory-fs";
import { runRetention } from "./memory-retention";
import { ModelRouter } from "./model-router";
import {
  initializeNeuroplasticity,
  initializeSessionDB,
} from "./neuroplasticity-init";
import type { NeuroInitResult } from "./neuroplasticity-init";
import type { LMToolRefs } from "./lm-tools";
import type { OfflineManager } from "./offline-manager";
import type { OpinionBank } from "./opinion-bank";
import { OrchestrationManager } from "./orchestration-manager";
import { registerPanelCommands } from "./panel-commands";
import { PromptLoader } from "./prompt-loader";
import { PromptManager } from "./prompt-manager";
import type { SaaSClient } from "./saas-client";
import { registerSaaSCommands } from "./saas-commands";
import { initializeSaaSLayer } from "./saas-init";
import type { SessionDB } from "./session-db";
import { SessionSummarizer } from "./session-summarizer";
import { SkillManager } from "./skill-manager";
import { TranscriptIndexer } from "./transcript-indexer";
import { BrainTreeDataProvider } from "./tree-view";
import type { UpgradePromptManager } from "./upgrade-prompts";

export interface ExtensionRuntimeRefs {
  activeOpinionBank: OpinionBank | null;
  activeAutoCapture: AutoCapture | null;
  activeLearningIngester: LearningIngester | null;
  flushInterval: ReturnType<typeof setInterval> | null;
  reflectInterval: ReturnType<typeof setInterval> | null;
  activeSaasClient: SaaSClient | null;
  activeOfflineManager: OfflineManager | null;
  activeDualOpinionBank: DualOpinionBank | null;
  activeSkillManager: SkillManager | null;
  activeLoginWebview: LoginWebviewProvider | null;
  activeUpgradePrompts: UpgradePromptManager | null;
  activeCronScheduler: CronScheduler | null;
  activeCronNotifications: CronNotificationManager | null;
  activeAdminDb: AdminDB | null;
  activeSessionDb: SessionDB | null;
  activeMemoryFS: MemoryFS | null;
  activeCloudSync: CloudSync | null;
  activeModelRouter: ModelRouter | null;
  activeAgentRegistry: AgentRegistry | null;
  activeGateway: McpGateway | null;
  activeGlobalKnowledge: GlobalKnowledgeManager | null;
}

export interface IntelligenceInitArgs {
  context: vscode.ExtensionContext;
  folders: readonly vscode.WorkspaceFolder[];
  treeView: vscode.TreeView<unknown>;
  orchestrationManager: OrchestrationManager;
  folderStates: Map<string, FolderState>;
  treeDataProvider: BrainTreeDataProvider;
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
  getState: (
    folder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
  ) => FolderState;
  projectPathHash: (fsPath: string) => string;
  getGlobalConfig: () => GlobalConfigProvider | null;
  log: (msg: string) => void;
  refs: ExtensionRuntimeRefs;
}

export function initIntelligenceLayer(
  args: IntelligenceInitArgs,
): ExtensionRuntimeRefs {
  _istageLog("intel-start");
  const primaryFolder = args.folders[0];
  const primaryState = args.getState(primaryFolder, args.context);
  const searchMemoryFn = async (q: string, opts?: { category?: string; topic?: string }) =>
    primaryState.mcpManager.searchMemory(q, 5, opts);
  const config = vscode.workspace.getConfiguration("projectBrain");
  const memoryFolder = config.get<string>(
    "memoryFolder",
    ".project-brain/memory",
  );
  const memoryPath = path.join(primaryFolder.uri.fsPath, memoryFolder);

  _istageLog("pre-model-router");
  const latencyTracker = new AdaptiveLatencyTracker();
  const modelRouter = new ModelRouter(args.context, args.log);
  modelRouter.latencyTracker = latencyTracker;
  modelRouter
    .discoverModels()
    .catch((e) => args.log(`[ModelRouter] Discovery failed: ${e}`));
  args.context.subscriptions.push({ dispose: () => modelRouter.dispose() });
  args.refs.activeModelRouter = modelRouter;

  _istageLog("pre-agent-registry");
  const agentRegistry = new AgentRegistry(
    args.context.extensionPath,
    memoryPath,
    args.log,
  );
  agentRegistry
    .loadAgents()
    .catch((e) => args.log(`[AgentRegistry] Load failed: ${e}`));
  args.refs.activeAgentRegistry = agentRegistry;

  _istageLog("pre-neuroplasticity");
  const neuro = initializeNeuroplasticity({
    memoryPath,
    log: args.log,
    getSkillManager: () => args.refs.activeSkillManager,
    getAdminDb: () => args.refs.activeAdminDb,
    getSessionDb: () => args.refs.activeSessionDb,
  });
  args.refs.activeOpinionBank = neuro.opinionBank;
  args.refs.activeAutoCapture = neuro.autoCapture;
  if (args.refs.activeAutoCapture && args.refs.activeGlobalKnowledge) {
    args.refs.activeAutoCapture.setGlobalKnowledge(
      args.refs.activeGlobalKnowledge,
    );
  }
  if (args.refs.activeAutoCapture) {
    // Wire agent diaries: route captured learnings to the active mode's diary.
    // The main "project-brain" agent is the only mode in active use; subagents
    // may override via setCurrentAgentMode when they spawn.
    args.refs.activeAutoCapture.setDiaryConfig(memoryPath);
    args.refs.activeAutoCapture.setCurrentAgentMode("project-brain");
  }
  args.refs.activeLearningIngester = neuro.learningIngester;
  if (args.refs.activeLearningIngester && args.refs.activeGlobalKnowledge) {
    args.refs.activeLearningIngester.setGlobalKnowledge(
      args.refs.activeGlobalKnowledge,
    );
  }
  args.refs.flushInterval = neuro.flushInterval;
  args.refs.reflectInterval = neuro.reflectInterval;
  void initializeSessionDB({ memoryPath, log: args.log }).then((sdb) => {
    args.refs.activeSessionDb = sdb;
  });

  const promptLoader = new PromptLoader(args.log);
  if (modelRouter) modelRouter.promptLoader = promptLoader;
  const promptManager = new PromptManager(memoryPath, args.log);

  _istageLog("pre-chat-participant");
  registerChatParticipant(
    args.context,
    searchMemoryFn,
    primaryState.identityManager,
    args.log,
    modelRouter,
    neuro.autoCapture,
    promptLoader,
    promptManager,
  );
  _istageLog("pre-lm-tools");
  const lmToolRefs = registerLMTools(
    args.context,
    primaryFolder,
    searchMemoryFn,
    primaryState.identityManager,
    args.log,
    modelRouter,
    primaryState.mcpManager,
    neuro.opinionBank,
    neuro.autoCapture,
    neuro.autoRecall,
    { get: () => args.refs.activeSkillManager },
    { get: () => args.refs.activeAdminDb },
    { get: () => args.refs.activeMemoryFS },
    args.orchestrationManager,
  );

  if (args.refs.activeGlobalKnowledge) {
    lmToolRefs.searchMemory.setGlobalKnowledge(args.refs.activeGlobalKnowledge);
  }

  _istageLog("pre-cron");
  const cronResult = initializeCronLayer({
    memoryPath,
    workspacePath: primaryFolder.uri.fsPath,
    context: args.context,
    opinionBank: neuro.opinionBank,
    treeDataProvider: args.treeDataProvider,
    treeView: args.treeView,
    getSaasClient: () => args.refs.activeSaasClient,
    log: args.log,
  });
  if (cronResult) {
    args.refs.activeCronScheduler = cronResult.cronScheduler;
    args.refs.activeCronNotifications = cronResult.cronNotifications;
  }
  registerCronCommands(args.context, {
    getSaasClient: () => args.refs.activeSaasClient,
    getUpgradePrompts: () => args.refs.activeUpgradePrompts,
    getCronScheduler: () => args.refs.activeCronScheduler,
    getMemoryPath: () => memoryPath,
    treeDataProvider: args.treeDataProvider,
  });

  _istageLog("pre-summarizer");
  const summarizer = new SessionSummarizer(
    primaryFolder,
    args.log,
    neuro.autoCapture,
    { get: () => args.refs.activeSessionDb },
  );
  summarizer
    .checkAndSummarize()
    .catch((e: unknown) => args.log(`[SessionSummarizer] Error: ${e}`));

  // Defer heavy post-summarizer init to next tick — gives GC breathing room
  setTimeout(() => {
    // Use V8 heap_size_limit (actual max) instead of heapTotal (current allocation)
    // heapTotal starts at ~76MB and grows dynamically — checking headroom against it
    // was causing false positives (18MB "headroom" when 4GB max is available)
    const v8Stats = require("v8").getHeapStatistics();
    const heapUsedMB = Math.round(v8Stats.used_heap_size / 1024 / 1024);
    const heapLimitMB = Math.round(v8Stats.heap_size_limit / 1024 / 1024);
    const headroomMB = heapLimitMB - heapUsedMB;
    _istageLog(`deferred-init-start (used=${heapUsedMB}MB limit=${heapLimitMB}MB headroom=${headroomMB}MB)`);
    const lowMem = headroomMB < 150;
    if (lowMem) {
      args.log(`[Extension] Low memory mode — ${heapUsedMB}/${heapLimitMB}MB (${headroomMB}MB free). Skipping heavy init.`);
      _istageLog(`deferred-init-LOW-MEM (headroom=${headroomMB}MB)`);
    }
    _deferredInit(args, memoryPath, primaryFolder, neuro, promptLoader, lmToolRefs, lowMem);
  }, 50);

  return args.refs;
}

/** Heavy initialization deferred to avoid OOM during activate() */
function _deferredInit(
  args: IntelligenceInitArgs,
  memoryPath: string,
  primaryFolder: vscode.WorkspaceFolder,
  neuro: NeuroInitResult,
  promptLoader: PromptLoader,
  lmToolRefs: LMToolRefs,
  lowMem: boolean,
): void {
  // --- Heavy operations: skip in low-memory mode ---
  if (!lowMem) {
    _istageLog("deferred-pre-retention");
    const retCfg = vscode.workspace.getConfiguration("projectBrain.retention");
    runRetention(memoryPath, {
      maxConversations: retCfg.get<number>("maxConversations", 20),
      maxSessions: retCfg.get<number>("maxSessions", 30),
      autoSummaryMaxAgeDays: retCfg.get<number>("autoSummaryMaxAgeDays", 60),
    })
      .then(
        (r: {
          conversationsDeleted: number;
          sessionsDeleted: number;
          summariesPruned: number;
        }) => {
          if (r.conversationsDeleted || r.sessionsDeleted || r.summariesPruned) {
            args.log(
              `[Retention] Cleaned: ${r.conversationsDeleted} convs, ${r.sessionsDeleted} sessions, ${r.summariesPruned} summaries`,
            );
          }
        },
      )
      .catch((e: unknown) => args.log(`[Retention] Error: ${e}`));

    _istageLog("deferred-pre-indexer");
    // Defer transcript indexing 30s to avoid blocking event loop during activation
    setTimeout(() => {
      try {
        // Skip indexer if heap is already heavy (> 300MB used)
        const heapUsed = process.memoryUsage().heapUsed;
        if (heapUsed > 300 * 1024 * 1024) {
          args.log(`[TranscriptIndexer] Skipped — heap too high (${(heapUsed / 1024 / 1024).toFixed(0)}MB)`);
          return;
        }
        const indexer = new TranscriptIndexer(memoryPath);
        void indexer
          .indexAll()
          .catch((e) =>
            args.log(`[TranscriptIndexer] Background indexing error: ${e}`),
          );
      } catch (e) {
        args.log(`[TranscriptIndexer] Init error: ${e}`);
      }
    }, 30_000);

    _istageLog("deferred-pre-saas");
    try {
      const saasResult = initializeSaaSLayer({
        context: args.context,
        primaryFolder,
        memoryPath,
        opinionBank: neuro.opinionBank,
        folderStates: args.folderStates,
        treeDataProvider: args.treeDataProvider,
        promptLoader,
        lmToolRefs,
        projectPathHash: args.projectPathHash,
        log: args.log,
        getCronScheduler: () => args.refs.activeCronScheduler,
        getSkillManager: () => args.refs.activeSkillManager,
        setSkillManager: (v) => {
          args.refs.activeSkillManager = v;
        },
        getDualOpinionBank: () => args.refs.activeDualOpinionBank,
      });
      args.refs.activeSaasClient = saasResult.saasClient;
      args.refs.activeOfflineManager = saasResult.offlineManager;
      args.refs.activeDualOpinionBank = saasResult.dualOpinionBank;
      args.refs.activeSkillManager = saasResult.skillManager;
      args.refs.activeLoginWebview = saasResult.loginWebview;
      args.refs.activeUpgradePrompts = saasResult.upgradePrompts;
      args.refs.activeAdminDb = saasResult.adminDb;
      args.refs.activeMemoryFS = saasResult.memoryFS;
      args.refs.activeCloudSync = saasResult.cloudSync;
    } catch (e) {
      args.log(`[SaaS] Cloud layer init failed (non-fatal): ${e}`);
    }
    _istageLog("deferred-post-saas");
  }

  if (!args.refs.activeSkillManager) {
    args.refs.activeSkillManager = initializeStandaloneSkillManager({
      memoryPath,
      extensionPath: args.context.extensionPath,
      log: args.log,
    });
  }

  // --- Commands: always register (lightweight callbacks) ---
  _istageLog("deferred-pre-commands");
  registerSaaSCommands(args.context, {
    getSaasClient: () => args.refs.activeSaasClient,
    getOfflineManager: () => args.refs.activeOfflineManager,
    getDualOpinionBank: () => args.refs.activeDualOpinionBank,
    getLoginWebview: () => args.refs.activeLoginWebview,
    getUpgradePrompts: () => args.refs.activeUpgradePrompts,
    folderStates: args.folderStates,
  });
  registerIdentityCommands(args.context, {
    pickWorkspaceFolder: args.pickWorkspaceFolder,
    getState: args.getState,
    getSaasClient: () => args.refs.activeSaasClient,
    getUpgradePrompts: () => args.refs.activeUpgradePrompts,
    getGlobalConfig: args.getGlobalConfig,
  });
  registerPanelCommands(args.context, {
    folderStates: args.folderStates,
    getAdminDb: () => args.refs.activeAdminDb,
    setAdminDb: (db) => {
      args.refs.activeAdminDb = db;
    },
    getSaasClient: () => args.refs.activeSaasClient,
    getOpinionBank: () => args.refs.activeOpinionBank,
    getAgentRegistry: () => args.refs.activeAgentRegistry,
    getModelRouter: () => args.refs.activeModelRouter,
    getOrchestrationManager: () => args.orchestrationManager,
    log: args.log,
  });
  registerDelegateCommand(args.context, {
    modelRouter: args.refs.activeModelRouter!,
    pickWorkspaceFolder: args.pickWorkspaceFolder,
    log: args.log,
  });

  _istageLog("deferred-pre-gateway");
  if (!lowMem) {
    try {
      initializeGateway({
        context: args.context,
        folder: primaryFolder,
        memoryPath,
        opinionBank: neuro.opinionBank,
        orchestrationManager: args.orchestrationManager,
        treeDataProvider: args.treeDataProvider,
        getState: args.getState,
        setActiveGateway: (gateway) => {
          args.refs.activeGateway = gateway;
        },
        log: args.log,
      });
    } catch (e) {
      args.log(`[Extension] initializeGateway failed: ${e}`);
    }
  }

  _istageLog(lowMem ? "deferred-init-complete-LOW-MEM" : "deferred-init-complete");
}

/** Standalone SkillManager fallback when SaaS is not available */
function initializeStandaloneSkillManager(opts: {
  memoryPath: string;
  extensionPath: string;
  log: (msg: string) => void;
}): SkillManager | null {
  try {
    const skillManager = new SkillManager({
      memoryPath: opts.memoryPath,
      extensionPath: opts.extensionPath,
      log: opts.log,
    });
    skillManager
      .initialize("free")
      .catch((e) => opts.log(`[SkillManager] Standalone init error: ${e}`));
    opts.log(
      "[SkillManager] Standalone mode \u2014 bundled + local skills loaded",
    );
    return skillManager;
  } catch (e) {
    opts.log(`[SkillManager] Standalone init failed (non-fatal): ${e}`);
    return null;
  }
}
