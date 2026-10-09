// ─── Shared types between extension host and webview UI ─────────────────────
// These mirror the extension-side types but without VS Code dependencies.

import type {
  SLAnalysisSession,
  SLEmbeddingConfig,
  SLRepoEntry,
} from "./messages-learning";
import type { ModelTier, OrchUiState } from "./messages-orch";

export type {
  SLAgentId,
  SLAgentMeta,
  SLAgentResult,
  SLAgentStatus,
  SLAnalysisSession,
  SLEmbeddingConfig,
  SLEmbeddingProvider,
  SLPipelinePhase,
  SLProgressInfo,
  SLRepoEntry,
  SLRepoStatus,
} from "./messages-learning";

// ─── Swarm ──────────────────────────────────────────────────────────────────

export interface SwarmUiWorkerState {
  taskId: string;
  message?: string;
  success?: boolean;
  error?: string;
  model?: string;
  tier?: string;
  rounds?: number;
  toolCalls?: number;
  durationMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface SwarmUiState {
  running: boolean;
  goal?: string;
  concurrency?: number;
  startedAt?: number;
  updatedAt: number;
  summary?: string;
  workers: SwarmUiWorkerState[];
}

// ─── Loop ───────────────────────────────────────────────────────────────────

export interface LoopIteration {
  index: number;
  prompt: string;
  synthesis?: string;
  feedback?: string;
  /** Number of images attached in this iteration's feedback */
  imageCount?: number;
  startedAt: number;
  completedAt?: number;
}

export interface LoopUiState {
  sessionId: string | null;
  state:
    | "idle"
    | "spawning"
    | "active"
    | "awaiting"
    | "completed"
    | "disconnected";
  controlState?: "running" | "paused";
  goal?: string;
  iterations: LoopIteration[];
  currentIteration?: LoopIteration;
  startedAt?: number;
  updatedAt: number;
  pendingSynthesis?: string;
  awaitingFeedback: boolean;
  branchIsolation?: {
    branchName: string;
    originalBranch: string;
    status: "active" | "completed" | "merged" | "discarded";
  };
  /** User-assigned display name (double-click rename) */
  _displayName?: string;
  /** Color tag for chip border indicator */
  color?: string;
  /** User-assigned tags for categorization */
  tags?: string[];
  /** Whether commit-gate bypass is active (skip commit confirmation) */
  commitBypass?: boolean;
  /** Whether audit-gate bypass is active (skip pre-synthesis audit) */
  auditBypass?: boolean;
  /** Max cycles before automatic migration */
  maxCycles?: number;
  /** Current loop iteration count (synced from config file) */
  currentLoopIterations?: number;
  protocolMonitor?: {
    mode: "monitor-only" | "repair-blocking";
    status: "healthy" | "warning" | "degraded";
    totalViolations: number;
    consecutiveViolations: number;
    lastHealthyAt?: string;
    updatedAt: string;
    repair?: {
      attempts: number;
      maxAttempts: number;
      lastAttemptAt: string;
      lastReason: string;
      blocking: boolean;
      recommendedAction: "resumeDisconnectedLoop" | "endLoop";
      checkpoint?: string;
    };
    lastViolation?: {
      code: string;
      severity: "warn" | "error";
      message: string;
      occurredAt: string;
      details?: Record<string, string | number | boolean | null>;
    };
  };
}

// ─── Loop Mailbox ────────────────────────────────────────────────────────────

export type LoopMailboxMessageType =
  | "warning"
  | "finding"
  | "question"
  | "answer"
  | "broadcast"
  | "conflict";

export interface LoopMailboxMessage {
  id: string;
  from: string;
  to: string | null;
  type: LoopMailboxMessageType;
  content: string;
  timestamp: number;
  read: boolean;
  replyTo?: string;
  status?: "active" | "resolved" | "acknowledged";
  channel?: "loop" | "orchestration";
  /** Whether the agent has seen/processed this message */
  delivered?: boolean;
}

// ─── Activity Feed (Neural Pulse) ─────────────────────────────────────
export type ActivityCategory =
  | "edit"
  | "search"
  | "read"
  | "terminal"
  | "brain"
  | "agent";

export interface ActivityEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  tool: string;
  category: ActivityCategory;
  icon: string;
  summary: string;
}

// ─── Orchestration (extracted to messages-orch.ts) ──────────────────────────

export type {
  MailboxMessage,
  MailboxMessageType,
  MailboxStats,
  ModelTier,
  OrchAgentSlot,
  OrchRoundState,
  OrchUiState,
  OrchWorkerState,
  PlanApprovalRequest,
  PlanApprovalStatus,
  TaskPlan,
} from "./messages-orch";

// ─── Dashboard ──────────────────────────────────────────────────────────────

export interface ProjectStats {
  memoryFiles: number;
  opinions: number;
  skills: number;
  agentName: string;
  agentEmoji: string;
  agentCreature: string;
  branch: string;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export interface MemoryFileInfo {
  name: string;
  relativePath: string;
  sizeKb: number;
  modifiedAt: string;
  createdAt: string;
  isDir: boolean;
  tags: string[];
  category: string;
  excerpt: string;
}

// ─── Conversation History ───────────────────────────────────────────────────

export interface ConversationHistoryEntry {
  chatSessionId: string;
  date: string;
  turns: number;
  tools: string[];
  preview: string;
  filePath: string;
}

// ─── Agent Catalog ──────────────────────────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  source: string;
  defaultTier: string;
  icon: string;
  tools?: string[];
}

export interface AvailableModel {
  id: string;
  vendor: string;
  family: string;
  tier: ModelTier;
}

// ─── MCP Smoke ──────────────────────────────────────────────────────────────

export interface McpSmokeLoopUpdate {
  attempt: number;
  consecutiveOk: number;
  running: boolean;
  done: boolean;
  pass?: boolean;
  toolsCount?: number;
  lastError?: string;
}

// ─── Branch Isolation ───────────────────────────────────────────────────────

export type BranchIsolationStatus =
  | "active"
  | "completed"
  | "merged"
  | "discarded";

export interface BranchIsolationInfo {
  sessionId: string;
  type: "loop" | "orch";
  branchName: string;
  originalBranch: string;
  createdAt: number;
  status: BranchIsolationStatus;
  description?: string;
  summary?: string;
  reportPath?: string;
}

export interface BranchAuditResult {
  compatible: boolean;
  conflictFiles: string[];
  aheadBehind: { ahead: number; behind: number };
  diffSummary: string;
}

export type AuditTrend = "improving" | "stable" | "degrading" | "unknown";

export interface AuditHistoryEntry {
  compatible: boolean;
  conflicts: number;
  behind: number;
  timestamp: number;
}

export interface BranchAuditWithTrend {
  result: BranchAuditResult;
  trend: AuditTrend;
  history: AuditHistoryEntry[];
}

// ─── MCP Gateway ────────────────────────────────────────────────────────────

export interface GatewayTokenInfo {
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsed?: string | null;
  expiresAt?: string | null;
}

export interface GatewayRequestLog {
  timestamp: string;
  tokenLabel: string;
  tool: string;
  status: "ok" | "error" | "denied";
  durationMs?: number;
}

export interface GatewayState {
  running: boolean;
  port: number;
  tokens: GatewayTokenInfo[];
  sessions: number;
  requestLog?: GatewayRequestLog[];
}

// ─── Hibernated Loop (lightweight for webview) ─────────────────────────────

export interface HibernatedLoopInfo {
  sessionId: string;
  goal: string;
  currentRound: number;
  branchName?: string;
  hibernatedAt: number;
  summary: string;
}

// ─── Interrupted Loop (recovered from persistence) ─────────────────────────

export interface InterruptedLoopInfo {
  sessionId: string;
  goal: string;
  iterationCount: number;
  lastSynthesis?: string;
  state: string;
  startedAt: number;
  persistedAt: number;
}

// ─── Finalized Loop (manually archived) ────────────────────────────────────

export interface FinalizedLoopInfo {
  sessionId: string;
  goal: string;
  totalRounds: number;
  branchName?: string;
  finalizedAt: number;
  summary: string;
}

// ─── Context Enricher Types ──────────────────────────────────────────────────

export interface EnrichFileReference {
  path: string;
  lines: number;
  summary: string;
  relevance: number;
  hotspot: boolean;
  relatedLearnings: string[];
}

export interface EnrichResultPayload {
  pack: {
    originalPrompt: string;
    rewrittenPrompt: string;
    intent: { action: string; domain: string[]; entities: string[] };
    fileMap: EnrichFileReference[];
    contextBlocks: Array<{ type: string; title: string; content: string; confidence: number }>;
    memoryGraph: { nodes: Array<{ id: string; type: string; relevance: number }>; edges: Array<{ from: string; to: string; type: string }> };
    risks: string[];
    confidence: number;
  };
  formattedMarkdown: string;
  durationMs: number;
}

// ─── Messages: Extension → Webview ──────────────────────────────────────────

export type ExtensionToWebviewMessage =
  | {
      type: "initialData";
      stats: ProjectStats;
      swarm: SwarmUiState;
      loop?: LoopUiState;
      memoryPath: string;
      loopMaxCyclesDefault?: number;
      initialTab?: string;
    }
  | { type: "mcpSmokeLoopUpdate"; data: McpSmokeLoopUpdate }
  | { type: "swarmUpdate"; data: SwarmUiState }
  | { type: "memoryFiles"; data: MemoryFileInfo[] }
  | { type: "sessionHistory"; data: string }
  | { type: "agentCatalog"; data: AgentDefinition[] }
  | {
      type: "availableModels";
      data: AvailableModel[];
      allModels: AvailableModel[];
      enabledIds: string[];
    }
  | { type: "orchUpdate"; data: OrchUiState }
  | { type: "loopUpdate"; data: LoopUiState }
  | {
      type: "loopControlUpdate";
      sessionId: string;
      controlState: "running" | "paused";
    }
  | { type: "loopSpawnTimeout"; sessionId: string }
  | { type: "enrichResult"; result: EnrichResultPayload; source: "goal" | "feedback" }
  | { type: "enrichLoading"; loading: boolean }
  | { type: "enrichError"; error: string }
  | { type: "pendingBranches"; data: BranchIsolationInfo[] }
  | { type: "diffPreview"; sessionId: string; data: string }
  | {
      type: "mergeResult";
      sessionId: string;
      data: { success: boolean; conflicts?: string[]; message: string };
    }
  | { type: "branchDiscarded"; sessionId: string }
  | {
      type: "branchCheckedOut";
      sessionId: string;
      branchName: string;
      previousBranch: string;
      stashed: boolean;
    }
  | { type: "branchReturned"; sessionId: string }
  | {
      type: "branchAudit";
      sessionId: string;
      data: BranchAuditResult;
      trend?: AuditTrend;
      history?: AuditHistoryEntry[];
    }
  | { type: "branchChangesStarted"; sessionId: string; loopSessionId: string }
  | { type: "staleBranchesAlert"; staleIds: string[] }
  | {
      type: "mailboxUpdate";
      sessionId: string;
      messages: LoopMailboxMessage[];
      unreadCount: number;
    }
  | { type: "availableBranches"; data: string[] }
  | { type: "allBranches"; data: BranchIsolationInfo[] }
  | {
      type: "branchRenamed";
      sessionId: string;
      newName: string;
      success: boolean;
      message: string;
    }
  | { type: "gatewayState"; data: GatewayState }
  | { type: "gatewayTokenCreated"; token: string; label: string }
  | { type: "gatewayRequestLog"; data: GatewayRequestLog[] }
  | { type: "hibernatedLoops"; data: HibernatedLoopInfo[] }
  | { type: "interruptedLoops"; data: InterruptedLoopInfo[] }
  | { type: "finalizedLoops"; data: FinalizedLoopInfo[] }
  | {
      type: "activityFeedUpdate";
      sessionId: string;
      entries: ActivityEntry[];
    }
  | { type: "navigateToTab"; tab: string }
  | { type: "loopMaxCyclesDefaultUpdate"; maxCycles: number }
  | { type: "conversationHistory"; data: ConversationHistoryEntry[] }
  | {
      type: "conversationSearchResults";
      data: ConversationHistoryEntry[];
      query: string;
    }
  // ─── Self-Learning ───
  | { type: "sl:repos"; data: SLRepoEntry[] }
  | { type: "sl:config"; data: SLEmbeddingConfig }
  | { type: "sl:repoUpdate"; repo: SLRepoEntry }
  | { type: "sl:analysisUpdate"; session: SLAnalysisSession }
  | {
      type: "sl:providerStatus";
      provider: string;
      available: boolean;
      error?: string;
    }
  | { type: "sl:error"; message: string }
  | {
      type: "sl:progress";
      repoId: number;
      phase: string;
      detail: string;
      percent?: number;
    }
  // ─── Auto Loop Bridge ───
  | { type: "autoLoopBridgeState"; sessions: import("./autoloop").AutoLoopBridgeSessionView[]; activeSessionId?: string | null }
  | { type: "autoLoopBridgeSessionCreated"; session: import("./autoloop").AutoLoopBridgeSessionView }
  | { type: "autoLoopBridgeSessionUpdated"; session: import("./autoloop").AutoLoopBridgeSessionView }
  | { type: "autoLoopBridgeActiveChanged"; sessionId: string }
  | { type: "autoLoopPmSuggestion"; sessionId: string; suggestion: import("./autoloop").PmSuggestionView }
  | { type: "autoLoopFeedbackDraftUpdated"; sessionId: string; text: string }
  | { type: "autoLoopFeedbackDispatched"; sessionId: string; dispatchedAt?: number }
  | { type: "autoLoopSessionClosed"; sessionId: string }
  | { type: "autoLoopError"; sessionId?: string; message: string }
  // ─── Bridge Settings (Phase F) ───
  | { type: "bridgeProviders"; providers: Array<{ providerId: string; label: string; isDefault: boolean }> }
  | { type: "bridgeModels"; providerId: string; models: Array<{ modelId: string; label: string; isDefault: boolean }> }
  | { type: "bridgeDefaultProviderSet"; providerId: string; success: boolean }
  | { type: "bridgeProviderValidation"; providerId: string; result: { valid: boolean; error?: string } }
  | { type: "bridgeApiKeySaved"; providerId: string; success: boolean }
  | { type: "bridgeSettingsError"; error: string }
  | { type: "tabConfig"; tabs: { tabId: string; visible: boolean }[] }
  | { type: "extensionUpdateResult"; available: boolean; currentVersion?: string; latestVersion?: string; publishedAt?: string; changelog?: string; size?: number; error?: string }
  | { type: "extensionUpdateProgress"; status: "downloading" | "installing" | "done" | "error"; error?: string };

// ─── Messages: Webview → Extension ──────────────────────────────────────────

export type WebviewToExtensionMessage =
  | { type: "webviewReady" }
  | { type: "webviewError"; error: string }
  | { type: "refresh" }
  | { type: "switchTab"; tab: string }
  | { type: "runCommand"; commandId: string; args?: unknown[] }
  | { type: "openFile"; filePath: string }
  | { type: "getMemoryFiles" }
  | { type: "getSessionHistory" }
  | { type: "requestSwarmState" }
  | { type: "requestTabConfig" }
  | { type: "checkExtensionUpdate" }
  | { type: "installExtensionUpdate" }
  | { type: "startMcpSmokeLoop" }
  | { type: "stopMcpSmokeLoop" }
  | { type: "getAgentCatalog" }
  | { type: "getAvailableModels" }
  | { type: "toggleModel"; modelId: string }
  | { type: "enableAllModels" }
  | {
      type: "createOrchSession";
      goal: string;
      team: { agentId: string; modelId: string; tier: string }[];
      mode: string;
      orchestratorModelId: string;
      useMailbox: boolean;
      requiresPlanApproval: boolean;
      autoApproveLowRisk: boolean;
      enhancePrompt: boolean;
      useBranchIsolation: boolean;
    }
  | { type: "addOrchTask"; sessionId: string; prompt: string }
  | { type: "endOrchSession"; sessionId: string }
  | { type: "requestOrchState"; sessionId?: string }
  | { type: "requestAllOrchStates" }
  | { type: "requestAllLoopStates" }
  | { type: "orchFeedback"; sessionId: string; feedback: string }
  | { type: "approvePlan"; sessionId: string; taskId: string }
  | { type: "rejectPlan"; sessionId: string; taskId: string; reason?: string }
  | { type: "approveAllPlans"; sessionId: string }
  | { type: "rejectAllPlans"; sessionId: string; reason?: string }
  | { type: "endLoopSession"; sessionId: string }
  | { type: "setLoopMaxCyclesDefault"; maxCycles: number }
  | { type: "loopMigrate"; sessionId: string; feedback: string }
  | { type: "addIterations"; sessionId: string; amount: number }
  | { type: "setMaxCycles"; sessionId: string; maxCycles: number } // routed via brain-hq-message-handler
  | {
      type: "createLoopSession";
      goal: string;
      useBranchIsolation?: boolean;
      baseBranch?: string;
    }
  | { type: "requestLoopState"; sessionId: string }
  | {
      type: "loopFeedback";
      sessionId: string;
      feedback: string;
      images?: string[];
    }
  | { type: "toggleCommitBypass"; sessionId: string; enabled: boolean }
  | { type: "toggleAuditBypass"; sessionId: string; enabled: boolean }
  | { type: "enrichGoal"; goal: string }
  | { type: "enrichFeedback"; feedback: string; sessionId: string; lastSynthesis?: string; loopGoal?: string }
  | { type: "setEnrichMode"; sessionId?: string; mode: "off" | "preview" | "auto" }
  | { type: "requestPendingBranches" }
  | { type: "getDiffPreview"; sessionId: string }
  | { type: "mergeBranch"; sessionId: string }
  | { type: "discardBranch"; sessionId: string }
  | { type: "keepBranch"; sessionId: string }
  | { type: "checkoutBranch"; sessionId: string }
  | { type: "returnFromBranch"; sessionId: string }
  | { type: "auditBranch"; sessionId: string; targetBranch?: string }
  | { type: "openForkInVSCode"; sessionId: string }
  | { type: "openBranch"; sessionId: string }
  | { type: "requestBranchChanges"; sessionId: string; instructions: string }
  | { type: "requestAvailableBranches" }
  | { type: "requestAllBranches" }
  | { type: "renameBranch"; sessionId: string; newName: string }
  | { type: "updateBranchSummary"; sessionId: string; summary: string }
  | { type: "toggleGateway" }
  | { type: "requestGatewayState" }
  | { type: "createGatewayToken"; label: string; scopes: string[] }
  | { type: "revokeGatewayToken"; label: string }
  | { type: "requestGatewayTokens" }
  | { type: "requestGatewayLog" }
  | { type: "requestHibernatedLoops" }
  | { type: "requestFinalizedLoops" }
  | { type: "finalizeLoopSession"; sessionId: string }
  | { type: "deleteFinalizedLoop"; sessionId: string }
  | { type: "archiveHibernatedLoop"; sessionId: string }
  | { type: "resumeLoopSession"; sessionId: string }
  | { type: "discardInterruptedLoop"; sessionId: string }
  | {
      type: "copyConnectionSnippet";
      tokenLabel: string;
      language: "curl" | "node" | "python";
    }
  | { type: "getConversationHistory" }
  | {
      type: "searchConversationHistory";
      query: string;
      mode: "search" | "temporal";
    }
  // ─── Self-Learning ───
  | { type: "sl:getRepos" }
  | { type: "sl:addRepo"; source: string }
  | { type: "sl:removeRepo"; repoId: number }
  | { type: "sl:vectorizeRepo"; repoId: number }
  | {
      type: "sl:analyzeRepo";
      repoId: number;
      llmModel: string;
      targetDescription: string;
    }
  | { type: "sl:getConfig" }
  | { type: "sl:saveConfig"; config: SLEmbeddingConfig }
  | { type: "sl:checkProvider"; provider: string }
  | { type: "sl:cancelOperation"; repoId: number }
  | {
      type: "sl:analyzeSingleAgent";
      repoId: number;
      llmModel: string;
      targetDescription: string;
      agentIds: string[];
    }
  | { type: "sl:openAnalysis"; repoId: number; agentId: string }
  | { type: "sl:getAnalysisStatus"; repoId: number }
  | { type: "sl:startPipeline"; repoId: number }
  | { type: "requestMailbox"; sessionId: string }
  | { type: "requestActivityFeed"; sessionId: string }
  | {
      type: "sendLoopMailboxMessage";
      sessionId: string;
      content: string;
    }
  | { type: "resolveMailboxMessage"; sessionId: string; messageId: string }
  | { type: "markLoopDisconnected"; sessionId: string }
  | { type: "resumeDisconnectedLoop"; sessionId: string };
