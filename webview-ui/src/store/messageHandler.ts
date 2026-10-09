import type { ExtensionToWebviewMessage } from "../types/messages";
import { postMessage } from "../vscode";
import type { Action } from "./reducer";

/**
 * Creates the message handler that maps ExtensionToWebviewMessage → dispatch(Action).
 * Extracted from AppProvider to keep AppContext.tsx slim.
 */
export function createMessageHandler(
  dispatch: React.Dispatch<Action>,
): (msg: ExtensionToWebviewMessage) => void {
  return (msg: ExtensionToWebviewMessage) => {
    switch (msg.type) {
      case "initialData":
        dispatch({
          type: "SET_INITIAL_DATA",
          stats: msg.stats,
          swarm: msg.swarm,
          loop: msg.loop,
          memoryPath: msg.memoryPath,
          loopMaxCyclesDefault: msg.loopMaxCyclesDefault,
          initialTab: msg.initialTab,
        });
        break;
      case "mcpSmokeLoopUpdate":
        dispatch({ type: "SET_MCP_SMOKE", data: msg.data });
        break;
      case "swarmUpdate":
        dispatch({ type: "SET_SWARM", data: msg.data });
        break;
      case "memoryFiles":
        dispatch({ type: "SET_MEMORY_FILES", data: msg.data });
        break;
      case "sessionHistory":
        dispatch({ type: "SET_SESSION_HISTORY", data: msg.data });
        break;
      case "agentCatalog":
        dispatch({ type: "SET_AGENT_CATALOG", data: msg.data });
        break;
      case "availableModels":
        dispatch({
          type: "SET_MODELS",
          data: msg.data,
          allModels: msg.allModels,
          enabledIds: msg.enabledIds,
        });
        break;
      case "orchUpdate":
        dispatch({ type: "SET_ORCH_STATE", data: msg.data });
        break;
      case "loopUpdate":
        // Forwards full LoopUiState (includes currentLoopIterations for migration display)
        dispatch({ type: "SET_LOOP_STATE", data: msg.data });
        break;
      case "loopControlUpdate":
        dispatch({
          type: "SET_LOOP_CONTROL",
          sessionId: msg.sessionId,
          controlState: msg.controlState,
        });
        break;
      case "loopSpawnTimeout": {
        const sid = msg.sessionId as string;
        if (sid) {
          dispatch({
            type: "SET_LOOP_CONTROL",
            sessionId: sid,
            controlState: "paused",
          });
        }
        break;
      }
      case "pendingBranches":
        dispatch({ type: "SET_PENDING_BRANCHES", data: msg.data });
        break;
      case "mergeResult":
      case "branchDiscarded":
        postMessage({ type: "requestPendingBranches" });
        break;
      case "branchAudit":
        dispatch({
          type: "SET_BRANCH_AUDIT",
          sessionId: msg.sessionId,
          data: msg.data,
          trend: msg.trend,
          history: msg.history,
        });
        break;
      case "staleBranchesAlert":
        dispatch({ type: "SET_STALE_BRANCHES", staleIds: msg.staleIds });
        break;
      case "branchCheckedOut":
        dispatch({ type: "SET_CHECKED_OUT_BRANCH", sessionId: msg.sessionId });
        break;
      case "branchReturned":
        dispatch({ type: "SET_CHECKED_OUT_BRANCH", sessionId: null });
        break;
      case "branchChangesStarted":
        postMessage({ type: "requestPendingBranches" });
        postMessage({ type: "requestAllBranches" });
        break;
      case "availableBranches":
        dispatch({ type: "SET_AVAILABLE_BRANCHES", data: msg.data });
        break;
      case "allBranches":
        dispatch({ type: "SET_ALL_BRANCHES", data: msg.data });
        break;
      case "branchRenamed":
        postMessage({ type: "requestAllBranches" });
        postMessage({ type: "requestPendingBranches" });
        break;
      case "gatewayState":
        dispatch({ type: "SET_GATEWAY", data: msg.data });
        break;
      case "gatewayTokenCreated":
        postMessage({ type: "requestGatewayState" });
        break;
      case "gatewayRequestLog":
        dispatch({ type: "SET_GATEWAY_REQUEST_LOG", data: msg.data });
        break;
      case "hibernatedLoops":
        dispatch({ type: "SET_HIBERNATED_LOOPS", data: msg.data });
        break;
      case "interruptedLoops":
        dispatch({ type: "SET_INTERRUPTED_LOOPS", data: msg.data });
        break;
      case "finalizedLoops":
        dispatch({ type: "SET_FINALIZED_LOOPS", data: msg.data });
        break;
      case "tabConfig":
        dispatch({ type: "SET_TAB_CONFIG", tabs: msg.tabs });
        break;
      case "extensionUpdateResult":
        dispatch({
          type: "SET_EXTENSION_UPDATE_RESULT",
          available: msg.available,
          currentVersion: msg.currentVersion,
          latestVersion: msg.latestVersion,
          publishedAt: msg.publishedAt,
          changelog: msg.changelog,
          size: msg.size,
        });
        break;
      case "extensionUpdateProgress":
        dispatch({
          type: "SET_EXTENSION_UPDATE_PROGRESS",
          status: msg.status,
          error: msg.error,
        });
        break;
      case "conversationHistory":
        dispatch({ type: "SET_CONVERSATION_HISTORY", data: msg.data });
        break;
      case "conversationSearchResults":
        dispatch({
          type: "SET_CONVERSATION_SEARCH",
          data: msg.data,
          query: msg.query,
        });
        break;
      case "navigateToTab":
        dispatch({ type: "SET_TAB", tab: msg.tab });
        break;

      case "loopMaxCyclesDefaultUpdate":
        dispatch({
          type: "SET_LOOP_MAX_CYCLES_DEFAULT",
          maxCycles: msg.maxCycles,
        });
        break;

      case "mailboxUpdate":
        dispatch({
          type: "SET_MAILBOX",
          sessionId: msg.sessionId,
          messages: msg.messages,
          unreadCount: msg.unreadCount,
        });
        break;

      case "activityFeedUpdate":
        dispatch({
          type: "SET_ACTIVITY_FEED",
          sessionId: msg.sessionId,
          entries: msg.entries,
        });
        break;

      // Self-Learning
      case "sl:repos":
        dispatch({ type: "SL_SET_REPOS", data: msg.data });
        break;
      case "sl:config":
        dispatch({ type: "SL_SET_CONFIG", data: msg.data });
        break;
      case "sl:repoUpdate":
        dispatch({ type: "SL_UPDATE_REPO", repo: msg.repo });
        break;
      case "sl:analysisUpdate":
        dispatch({ type: "SL_SET_ANALYSIS", session: msg.session });
        break;
      case "sl:error":
        dispatch({ type: "SL_SET_ERROR", message: msg.message });
        break;
      case "sl:providerStatus":
        dispatch({
          type: "SL_SET_PROVIDER_STATUS",
          provider: msg.provider,
          available: msg.available,
        });
        break;
      case "sl:progress":
        dispatch({
          type: "SL_SET_PROGRESS",
          repoId: msg.repoId,
          phase: msg.phase,
          detail: msg.detail,
          percent: msg.percent,
        });
        // Auto-clear done/error progress after 5 seconds
        if (msg.phase === "done" || msg.phase === "error") {
          setTimeout(() => {
            dispatch({ type: "SL_CLEAR_PROGRESS", repoId: msg.repoId });
          }, 5000);
        }
        break;

      // ─── Auto Loop Bridge ───
      case "autoLoopBridgeState": {
        // Extension sends sessions as array, reducer expects Record<id, session>
        const arr = (msg.sessions ?? []) as Array<{ sessionId: string }>;
        const record: Record<string, unknown> = {};
        for (const s of arr) { record[s.sessionId] = s; }
        dispatch({ type: "SET_BRIDGE_STATE", sessions: record as never, activeSessionId: msg.activeSessionId });
        break;
      }
      case "autoLoopBridgeSessionCreated":
      case "autoLoopBridgeSessionUpdated":
        dispatch({ type: "SET_BRIDGE_SESSION", session: msg.session });
        break;
      case "autoLoopBridgeActiveChanged":
        dispatch({ type: "SET_ACTIVE_BRIDGE", sessionId: msg.sessionId });
        break;
      case "autoLoopFeedbackDraftUpdated":
        dispatch({
          type: "SET_BRIDGE_DRAFT",
          sessionId: msg.sessionId,
          draft: (msg as { text?: string; draft?: string }).text ?? (msg as { draft?: string }).draft ?? "",
        });
        break;
      case "autoLoopFeedbackDispatched":
        // Refresh state after dispatch
        postMessage({ type: "requestAutoLoopBridgeState" } as never);
        break;
      case "autoLoopSessionClosed":
        dispatch({ type: "REMOVE_BRIDGE_SESSION", sessionId: msg.sessionId });
        break;
      case "autoLoopPmSuggestion":
        // PM suggestion is part of the session update, so request fresh state
        // Session already updated via autoLoopBridgeSessionUpdated � no refetch needed
        break;
      case "autoLoopError":
        // Could show a notification; for now just re-request state
        // Dispatch error locally instead of destructive refetch
        break;

      // ─── Bridge Settings (Phase F) ───
      case "bridgeProviders":
        dispatch({ type: "SET_BRIDGE_PROVIDERS", providers: msg.providers });
        break;
      case "bridgeModels":
        dispatch({ type: "SET_BRIDGE_MODELS", providerId: msg.providerId, models: msg.models });
        break;
      case "bridgeDefaultProviderSet":
        if (msg.success) postMessage({ type: "requestBridgeProviders" } as never);
        break;
      case "bridgeProviderValidation":
        // Could update UI with validation result
        if (!msg.result.valid) {
          dispatch({ type: "SET_BRIDGE_SETTINGS_ERROR", error: msg.result.error ?? "Validation failed" });
        }
        break;
      case "bridgeApiKeySaved":
        if (msg.success) postMessage({ type: "requestBridgeProviders" } as never);
        break;
      case "bridgeSettingsError":
        dispatch({ type: "SET_BRIDGE_SETTINGS_ERROR", error: msg.error });
        break;
      case "bridgeModelCatalog":
        dispatch({
          type: "SET_BRIDGE_MODEL_CATALOG",
          providerId: msg.providerId,
          groups: msg.groups,
          enabledModelIds: msg.enabledModelIds,
        });
        break;
      case "bridgeEnabledModelsSaved":
        if (msg.success) {
          dispatch({
            type: "SET_BRIDGE_ENABLED_MODELS_SAVED",
            providerId: msg.providerId,
            enabledModelIds: msg.enabledModelIds,
          });
        }
        break;
    }
  };
}