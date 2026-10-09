import type {
  ActivityEntry,
  AgentDefinition,
  AuditHistoryEntry,
  AuditTrend,
  AvailableModel,
  BranchAuditResult,
  BranchIsolationInfo,
  ConversationHistoryEntry,
  FinalizedLoopInfo,
  GatewayRequestLog,
  GatewayState,
  HibernatedLoopInfo,
  InterruptedLoopInfo,
  LoopMailboxMessage,
  LoopUiState,
  McpSmokeLoopUpdate,
  MemoryFileInfo,
  OrchUiState,
  ProjectStats,
  SLAnalysisSession,
  SLEmbeddingConfig,
  SLProgressInfo,
  SLRepoEntry,
  SwarmUiState,
} from "../types/messages";
import type { AutoLoopBridgeSessionView } from "../types/autoloop";

// ─── State Shape ────────────────────────────────────────────────────────────

export interface AppState {
  activeTab: string;
  stats: ProjectStats;
  memoryPath: string;
  swarm: SwarmUiState;
  mcpSmoke: McpSmokeLoopUpdate;
  memoryFiles: MemoryFileInfo[];
  sessionHistory: string;
  agentCatalog: AgentDefinition[];
  availableModels: AvailableModel[];
  allModels: AvailableModel[];
  enabledModelIds: string[];
  orchSessions: Record<string, OrchUiState>;
  activeOrchSessionId: string | null;
  loopSessions: Record<string, LoopUiState>;
  activeLoopSessionId: string | null;
  hibernatedLoops: HibernatedLoopInfo[];
  interruptedLoops: InterruptedLoopInfo[];
  finalizedLoops: FinalizedLoopInfo[];
  pendingBranches: BranchIsolationInfo[];
  branchAudits: Record<
    string,
    {
      result: BranchAuditResult;
      trend?: AuditTrend;
      history?: AuditHistoryEntry[];
    }
  >;
  checkedOutBranchId: string | null;
  staleBranches: string[];
  availableBranches: string[];
  allBranches: BranchIsolationInfo[];
  gateway: GatewayState;
  conversationHistory: ConversationHistoryEntry[];
  conversationSearchQuery: string;
  // Self-Learning
  slRepos: SLRepoEntry[];
  slConfig: SLEmbeddingConfig | null;
  slAnalysis: SLAnalysisSession | null;
  slError: string | null;
  slProviderStatus: { provider: string; available: boolean } | null;
  slProgress: Record<number, SLProgressInfo>;
  /** Mailbox messages per loop session */
  mailboxBySession: Record<
    string,
    { messages: LoopMailboxMessage[]; unreadCount: number }
  >;
  /** Activity feed entries per loop session (Neural Pulse) */
  activityBySession: Record<string, ActivityEntry[]>;
  /** Global default for loop max cycles */
  loopMaxCyclesDefault: number;
  // Auto Loop Bridge
  bridgeSessions: Record<string, AutoLoopBridgeSessionView>;
  activeBridgeSessionId: string | null;
  bridgeProviders: Array<{ providerId: string; label: string; isDefault: boolean }>;
  selectedBridgeProviderId: string | null;
  bridgeModels: Record<string, Array<{ modelId: string; label: string; isDefault: boolean }>>;
  bridgeSettingsError: string | null;
  bridgeModelCatalog: Record<string, { groups: Record<string, Array<{ id: string; label: string }>>; enabledModelIds: string[] }>;
  bridgeCatalogLoading: boolean;
  /** Remote tab visibility config from SaaS */
  tabConfig: Record<string, boolean>;
  /** Extension update state */
  extensionUpdate: {
    checking: boolean;
    available: boolean;
    currentVersion?: string;
    latestVersion?: string;
    publishedAt?: string;
    changelog?: string;
    size?: number;
    installing: boolean;
    installStatus?: "downloading" | "installing" | "done" | "error";
    installError?: string;
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type Action =
  | { type: "SET_TAB"; tab: string }
  | {
      type: "SET_INITIAL_DATA";
      stats: ProjectStats;
      swarm: SwarmUiState;
      loop?: LoopUiState;
      memoryPath: string;
      loopMaxCyclesDefault?: number;
      initialTab?: string;
    }
  | { type: "SET_SWARM"; data: SwarmUiState }
  | { type: "SET_MCP_SMOKE"; data: McpSmokeLoopUpdate }
  | { type: "SET_MEMORY_FILES"; data: MemoryFileInfo[] }
  | { type: "SET_SESSION_HISTORY"; data: string }
  | { type: "SET_AGENT_CATALOG"; data: AgentDefinition[] }
  | {
      type: "SET_MODELS";
      data: AvailableModel[];
      allModels: AvailableModel[];
      enabledIds: string[];
    }
  | { type: "SET_ORCH_STATE"; data: OrchUiState }
  | { type: "SET_LOOP_STATE"; data: LoopUiState } // includes currentLoopIterations
  | { type: "SET_ACTIVE_ORCH"; sessionId: string | null }
  | { type: "SET_ACTIVE_LOOP"; sessionId: string | null }
  | {
      type: "SET_LOOP_CONTROL";
      sessionId: string;
      controlState: "running" | "paused";
    }
  | { type: "REMOVE_ORCH"; sessionId: string }
  | { type: "REMOVE_LOOP"; sessionId: string }
  | { type: "RENAME_LOOP"; sessionId: string; displayName: string }
  | { type: "SET_LOOP_COLOR"; sessionId: string; color: string }
  | { type: "SET_LOOP_TAGS"; sessionId: string; tags: string[] }
  | { type: "SET_PENDING_BRANCHES"; data: BranchIsolationInfo[] }
  | {
      type: "SET_BRANCH_AUDIT";
      sessionId: string;
      data: BranchAuditResult;
      trend?: AuditTrend;
      history?: AuditHistoryEntry[];
    }
  | { type: "SET_CHECKED_OUT_BRANCH"; sessionId: string | null }
  | { type: "SET_STALE_BRANCHES"; staleIds: string[] }
  | { type: "SET_AVAILABLE_BRANCHES"; data: string[] }
  | { type: "SET_ALL_BRANCHES"; data: BranchIsolationInfo[] }
  | { type: "SET_GATEWAY"; data: GatewayState }
  | { type: "SET_GATEWAY_REQUEST_LOG"; data: GatewayRequestLog[] }
  | { type: "SET_HIBERNATED_LOOPS"; data: HibernatedLoopInfo[] }
  | { type: "SET_INTERRUPTED_LOOPS"; data: InterruptedLoopInfo[] }
  | { type: "SET_FINALIZED_LOOPS"; data: FinalizedLoopInfo[] }
  | { type: "REMOVE_INTERRUPTED_LOOP"; sessionId: string }
  | { type: "SET_CONVERSATION_HISTORY"; data: ConversationHistoryEntry[] }
  | {
      type: "SET_CONVERSATION_SEARCH";
      data: ConversationHistoryEntry[];
      query: string;
    }
  // Self-Learning
  | { type: "SL_SET_REPOS"; data: SLRepoEntry[] }
  | { type: "SL_SET_CONFIG"; data: SLEmbeddingConfig }
  | { type: "SL_UPDATE_REPO"; repo: SLRepoEntry }
  | { type: "SL_SET_ANALYSIS"; session: SLAnalysisSession }
  | { type: "SL_SET_ERROR"; message: string }
  | { type: "SL_SET_PROVIDER_STATUS"; provider: string; available: boolean }
  | {
      type: "SL_SET_PROGRESS";
      repoId: number;
      phase: string;
      detail: string;
      percent?: number;
    }
  | { type: "SL_CLEAR_PROGRESS"; repoId: number }
  | { type: "SL_CLEAR_ERROR" }
  | {
      type: "SET_MAILBOX";
      sessionId: string;
      messages: LoopMailboxMessage[];
      unreadCount: number;
    }
  | { type: "SET_LOOP_MAX_CYCLES_DEFAULT"; maxCycles: number }
  | { type: "SET_ACTIVITY_FEED"; sessionId: string; entries: ActivityEntry[] }
  // Auto Loop Bridge
  | { type: "SET_BRIDGE_STATE"; sessions: Record<string, AutoLoopBridgeSessionView>; activeSessionId: string | null }
  | { type: "SET_BRIDGE_SESSION"; session: AutoLoopBridgeSessionView }
  | { type: "SET_ACTIVE_BRIDGE"; sessionId: string | null }
  | { type: "REMOVE_BRIDGE_SESSION"; sessionId: string }
  | { type: "SET_BRIDGE_DRAFT"; sessionId: string; draft: string }
  | { type: "SET_BRIDGE_PROVIDERS"; providers: Array<{ providerId: string; label: string; isDefault: boolean }> }
  | { type: "SET_ACTIVE_BRIDGE_PROVIDER"; providerId: string | null }
  | { type: "SET_BRIDGE_MODELS"; providerId: string; models: Array<{ modelId: string; label: string; isDefault: boolean }> }
  | { type: "SET_BRIDGE_SETTINGS_ERROR"; error: string | null }
  | { type: "SET_BRIDGE_MODEL_CATALOG"; providerId: string; groups: Record<string, Array<{ id: string; label: string }>>; enabledModelIds: string[] }
  | { type: "SET_BRIDGE_CATALOG_LOADING"; loading: boolean }
  | { type: "SET_BRIDGE_ENABLED_MODELS_SAVED"; providerId: string; enabledModelIds: string[] }
  | { type: "SET_TAB_CONFIG"; tabs: { tabId: string; visible: boolean }[] }
  | { type: "SET_EXTENSION_UPDATE_CHECK"; checking: boolean }
  | { type: "SET_EXTENSION_UPDATE_RESULT"; available: boolean; currentVersion?: string; latestVersion?: string; publishedAt?: string; changelog?: string; size?: number }
  | { type: "SET_EXTENSION_UPDATE_PROGRESS"; status: "downloading" | "installing" | "done" | "error"; error?: string };

// ─── Initial State ──────────────────────────────────────────────────────────

export const initialState: AppState = {
  activeTab: "dashboard",
  stats: {
    memoryFiles: 0,
    opinions: 0,
    skills: 0,
    agentName: "Brain",
    agentEmoji: "\u{1F9E0}",
    agentCreature: "AI Assistant",
    branch: "unknown",
  },
  memoryPath: "",
  swarm: { running: false, updatedAt: Date.now(), workers: [] },
  mcpSmoke: { attempt: 0, consecutiveOk: 0, running: false, done: false },
  memoryFiles: [],
  sessionHistory: "",
  agentCatalog: [],
  availableModels: [],
  allModels: [],
  enabledModelIds: [],
  orchSessions: {},
  activeOrchSessionId: null,
  loopSessions: {},
  activeLoopSessionId: null,
  hibernatedLoops: [],
  interruptedLoops: [],
  finalizedLoops: [],
  pendingBranches: [],
  branchAudits: {},
  checkedOutBranchId: null,
  staleBranches: [],
  availableBranches: [],
  allBranches: [],
  gateway: { running: false, port: 3200, tokens: [], sessions: 0 },
  conversationHistory: [],
  conversationSearchQuery: "",
  // Self-Learning
  slRepos: [],
  slConfig: null,
  slAnalysis: null,
  slError: null,
  slProviderStatus: null,
  slProgress: {},
  mailboxBySession: {},
  activityBySession: {},
  loopMaxCyclesDefault: 15,
  // Auto Loop Bridge
  bridgeSessions: {},
  activeBridgeSessionId: null,
  bridgeProviders: [],
  selectedBridgeProviderId: null,
  bridgeModels: {},
  bridgeSettingsError: null,
  bridgeModelCatalog: {},
  bridgeCatalogLoading: false,
  tabConfig: {},
  extensionUpdate: {
    checking: false,
    available: false,
    installing: false,
  },
};

// ─── Reducer ────────────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_TAB":
      return { ...state, activeTab: action.tab };

    case "SET_INITIAL_DATA": {
      const newState = {
        ...state,
        stats: action.stats,
        swarm: action.swarm,
        memoryPath: action.memoryPath,
        loopMaxCyclesDefault:
          action.loopMaxCyclesDefault ?? state.loopMaxCyclesDefault,
      };
      if (
        action.loop &&
        action.loop.sessionId &&
        action.loop.state !== "idle"
      ) {
        newState.loopSessions = {
          ...newState.loopSessions,
          [action.loop.sessionId]: action.loop,
        };
        newState.activeLoopSessionId = action.loop.sessionId;
        newState.activeTab = action.initialTab || "loop";
      }
      if (action.initialTab) {
        newState.activeTab = action.initialTab;
      }
      return newState;
    }

    case "SET_SWARM":
      return { ...state, swarm: action.data };

    case "SET_MCP_SMOKE":
      return { ...state, mcpSmoke: action.data };

    case "SET_MEMORY_FILES":
      return { ...state, memoryFiles: action.data };

    case "SET_SESSION_HISTORY":
      return { ...state, sessionHistory: action.data };

    case "SET_AGENT_CATALOG":
      return { ...state, agentCatalog: action.data };

    case "SET_MODELS":
      return {
        ...state,
        availableModels: action.data,
        allModels: action.allModels,
        enabledModelIds: action.enabledIds,
      };

    case "SET_ORCH_STATE": {
      const sid = action.data.sessionId;
      if (!sid) return state;
      const sessions = { ...state.orchSessions, [sid]: action.data };
      let activeId = state.activeOrchSessionId;
      if (!activeId && action.data.state !== "idle") activeId = sid;
      return {
        ...state,
        orchSessions: sessions,
        activeOrchSessionId: activeId,
      };
    }

    case "SET_LOOP_STATE": {
      const sid = action.data.sessionId;
      if (!sid) return state;
      const sessions = { ...state.loopSessions, [sid]: action.data };
      let activeId = state.activeLoopSessionId;
      if (
        !activeId &&
        action.data.state !== "idle" &&
        action.data.state !== "completed"
      )
        activeId = sid;
      const wasIdle = !state.activeLoopSessionId;
      const isActive =
        action.data.state === "spawning" ||
        action.data.state === "active" ||
        action.data.state === "awaiting";
      const newTab = wasIdle && isActive ? "loop" : state.activeTab;
      // Auto-remove from interrupted if this session is now live
      const filteredInterrupted = state.interruptedLoops.filter(
        (il) => il.sessionId !== sid,
      );
      return {
        ...state,
        loopSessions: sessions,
        activeLoopSessionId: activeId,
        activeTab: newTab,
        interruptedLoops: filteredInterrupted,
      };
    }

    case "SET_ACTIVE_ORCH":
      return { ...state, activeOrchSessionId: action.sessionId };

    case "SET_ACTIVE_LOOP":
      return { ...state, activeLoopSessionId: action.sessionId };

    case "SET_LOOP_CONTROL": {
      const existing = state.loopSessions[action.sessionId];
      if (!existing) return state;
      return {
        ...state,
        loopSessions: {
          ...state.loopSessions,
          [action.sessionId]: {
            ...existing,
            controlState: action.controlState,
          },
        },
      };
    }

    case "REMOVE_ORCH": {
      const { [action.sessionId]: _, ...rest } = state.orchSessions;
      const newActive =
        state.activeOrchSessionId === action.sessionId
          ? Object.keys(rest)[0] || null
          : state.activeOrchSessionId;
      return { ...state, orchSessions: rest, activeOrchSessionId: newActive };
    }

    case "REMOVE_LOOP": {
      const { [action.sessionId]: _, ...rest } = state.loopSessions;
      const newActive =
        state.activeLoopSessionId === action.sessionId
          ? Object.keys(rest)[0] || null
          : state.activeLoopSessionId;
      return { ...state, loopSessions: rest, activeLoopSessionId: newActive };
    }

    case "RENAME_LOOP": {
      const existing = state.loopSessions[action.sessionId];
      if (!existing) return state;
      return {
        ...state,
        loopSessions: {
          ...state.loopSessions,
          [action.sessionId]: { ...existing, _displayName: action.displayName },
        },
      };
    }

    case "SET_LOOP_COLOR": {
      const existing = state.loopSessions[action.sessionId];
      if (!existing) return state;
      return {
        ...state,
        loopSessions: {
          ...state.loopSessions,
          [action.sessionId]: { ...existing, color: action.color },
        },
      };
    }

    case "SET_LOOP_TAGS": {
      const existing = state.loopSessions[action.sessionId];
      if (!existing) return state;
      return {
        ...state,
        loopSessions: {
          ...state.loopSessions,
          [action.sessionId]: { ...existing, tags: action.tags },
        },
      };
    }

    case "SET_PENDING_BRANCHES":
      return { ...state, pendingBranches: action.data };

    case "SET_BRANCH_AUDIT":
      return {
        ...state,
        branchAudits: {
          ...state.branchAudits,
          [action.sessionId]: {
            result: action.data,
            trend: action.trend,
            history: action.history,
          },
        },
      };

    case "SET_STALE_BRANCHES":
      return { ...state, staleBranches: action.staleIds };

    case "SET_AVAILABLE_BRANCHES":
      return { ...state, availableBranches: action.data };

    case "SET_ALL_BRANCHES":
      return { ...state, allBranches: action.data };

    case "SET_CHECKED_OUT_BRANCH":
      return { ...state, checkedOutBranchId: action.sessionId };

    case "SET_GATEWAY_REQUEST_LOG":
      return {
        ...state,
        gateway: { ...state.gateway, requestLog: action.data },
      };

    case "SET_HIBERNATED_LOOPS":
      return { ...state, hibernatedLoops: action.data };

    case "SET_INTERRUPTED_LOOPS":
      return { ...state, interruptedLoops: action.data };

    case "SET_FINALIZED_LOOPS":
      return { ...state, finalizedLoops: action.data };

    case "REMOVE_INTERRUPTED_LOOP":
      return {
        ...state,
        interruptedLoops: state.interruptedLoops.filter(
          (l) => l.sessionId !== action.sessionId,
        ),
      };

    case "SET_CONVERSATION_HISTORY":
      return { ...state, conversationHistory: action.data };

    case "SET_CONVERSATION_SEARCH":
      return {
        ...state,
        conversationHistory: action.data,
        conversationSearchQuery: action.query,
      };

    // Self-Learning
    case "SL_SET_REPOS":
      return { ...state, slRepos: action.data, slError: null };
    case "SL_SET_CONFIG":
      return { ...state, slConfig: action.data };
    case "SL_UPDATE_REPO": {
      const repos = state.slRepos.map((r) =>
        r.id === action.repo.id ? action.repo : r,
      );
      // If not found, append (new repo from addRepo)
      if (!repos.some((r) => r.id === action.repo.id)) repos.push(action.repo);
      return { ...state, slRepos: repos };
    }
    case "SL_SET_ANALYSIS":
      return { ...state, slAnalysis: action.session };
    case "SL_SET_ERROR":
      return { ...state, slError: action.message };
    case "SL_SET_PROVIDER_STATUS":
      return {
        ...state,
        slProviderStatus: {
          provider: action.provider,
          available: action.available,
        },
      };
    case "SL_CLEAR_ERROR":
      return { ...state, slError: null };
    case "SL_SET_PROGRESS": {
      const progress = { ...state.slProgress };
      const existing = progress[action.repoId];
      progress[action.repoId] = {
        repoId: action.repoId,
        phase: action.phase as SLProgressInfo["phase"],
        detail: action.detail,
        percent: action.percent,
        startedAt: existing?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      return { ...state, slProgress: progress };
    }
    case "SL_CLEAR_PROGRESS": {
      const progress = { ...state.slProgress };
      delete progress[action.repoId];
      return { ...state, slProgress: progress };
    }

    case "SET_MAILBOX":
      return {
        ...state,
        mailboxBySession: {
          ...state.mailboxBySession,
          [action.sessionId]: {
            messages: action.messages,
            unreadCount: action.unreadCount,
          },
        },
      };

    case "SET_ACTIVITY_FEED":
      return {
        ...state,
        activityBySession: {
          ...state.activityBySession,
          [action.sessionId]: action.entries,
        },
      };

    case "SET_LOOP_MAX_CYCLES_DEFAULT":
      return { ...state, loopMaxCyclesDefault: action.maxCycles };

    // ─── Auto Loop Bridge ───
    case "SET_BRIDGE_STATE":
      return { ...state, bridgeSessions: action.sessions, activeBridgeSessionId: action.activeSessionId ?? state.activeBridgeSessionId };

    case "SET_BRIDGE_SESSION": {
      const sid = action.session.sessionId;
      return {
        ...state,
        bridgeSessions: { ...state.bridgeSessions, [sid]: action.session },
        activeBridgeSessionId: state.activeBridgeSessionId ?? sid,
      };
    }

    case "SET_ACTIVE_BRIDGE":
      return { ...state, activeBridgeSessionId: action.sessionId };

    case "REMOVE_BRIDGE_SESSION": {
      const { [action.sessionId]: _, ...rest } = state.bridgeSessions;
      const newActive = state.activeBridgeSessionId === action.sessionId
        ? Object.keys(rest)[0] || null
        : state.activeBridgeSessionId;
      return { ...state, bridgeSessions: rest, activeBridgeSessionId: newActive };
    }

    case "SET_BRIDGE_DRAFT": {
      const existing = state.bridgeSessions[action.sessionId];
      if (!existing) return state;
      return {
        ...state,
        bridgeSessions: {
          ...state.bridgeSessions,
          [action.sessionId]: { ...existing, workerFeedbackDraft: action.draft },
        },
      };
    }

    case "SET_BRIDGE_PROVIDERS": {
      const currentStillExists = action.providers.some((provider) => provider.providerId === state.selectedBridgeProviderId);
      const fallbackProviderId = action.providers.find((provider) => provider.isDefault)?.providerId
        ?? action.providers[0]?.providerId
        ?? null;
      return {
        ...state,
        bridgeProviders: action.providers,
        selectedBridgeProviderId: currentStillExists ? state.selectedBridgeProviderId : fallbackProviderId,
        bridgeSettingsError: null,
      };
    }

    case "SET_ACTIVE_BRIDGE_PROVIDER":
      return { ...state, selectedBridgeProviderId: action.providerId };

    case "SET_BRIDGE_MODELS": {
      const mapped = action.models.map((m: any) => ({
        id: m.id ?? m.modelId,
        label: m.label,
      }));
      // Also propagate to all bridge sessions' availableModels
      const updatedSessions = { ...state.bridgeSessions };
      for (const [sid, session] of Object.entries(updatedSessions)) {
        updatedSessions[sid] = { ...session, availableModels: mapped };
      }
      return {
        ...state,
        bridgeModels: { ...state.bridgeModels, [action.providerId]: action.models },
        bridgeSessions: updatedSessions,
        bridgeSettingsError: null,
      };
    }

    case "SET_BRIDGE_SETTINGS_ERROR":
      return { ...state, bridgeSettingsError: action.error };

    case "SET_BRIDGE_MODEL_CATALOG":
      return {
        ...state,
        bridgeModelCatalog: {
          ...state.bridgeModelCatalog,
          [action.providerId]: { groups: action.groups, enabledModelIds: action.enabledModelIds },
        },
        bridgeCatalogLoading: false,
      };

    case "SET_BRIDGE_CATALOG_LOADING":
      return { ...state, bridgeCatalogLoading: action.loading };

    case "SET_BRIDGE_ENABLED_MODELS_SAVED": {
      const prev = state.bridgeModelCatalog[action.providerId];
      return {
        ...state,
        bridgeModelCatalog: {
          ...state.bridgeModelCatalog,
          [action.providerId]: prev
            ? { ...prev, enabledModelIds: action.enabledModelIds }
            : { groups: {}, enabledModelIds: action.enabledModelIds },
        },
      };
    }

    case "SET_TAB_CONFIG": {
      const config: Record<string, boolean> = {};
      for (const t of action.tabs) config[t.tabId] = t.visible;
      return { ...state, tabConfig: config };
    }

    case "SET_EXTENSION_UPDATE_CHECK":
      return {
        ...state,
        extensionUpdate: { ...state.extensionUpdate, checking: action.checking },
      };

    case "SET_EXTENSION_UPDATE_RESULT":
      return {
        ...state,
        extensionUpdate: {
          ...state.extensionUpdate,
          checking: false,
          available: action.available,
          currentVersion: action.currentVersion,
          latestVersion: action.latestVersion,
          publishedAt: action.publishedAt,
          changelog: action.changelog,
          size: action.size,
        },
      };

    case "SET_EXTENSION_UPDATE_PROGRESS":
      return {
        ...state,
        extensionUpdate: {
          ...state.extensionUpdate,
          installing: action.status === "downloading" || action.status === "installing",
          installStatus: action.status,
          installError: action.error,
        },
      };

    default:
      return state;
  }
}
