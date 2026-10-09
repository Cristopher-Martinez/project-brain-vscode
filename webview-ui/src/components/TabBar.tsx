import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";

const TABS = [
  { id: "dashboard", label: "📊 Dashboard" },
  { id: "swarm", label: "⚡ Swarm" },
  { id: "orchestration", label: "⚓ Orchestration" },
  { id: "loop", label: "🔁 Loop" },
  { id: "backlog", label: "📋 Backlog" },
  { id: "memory", label: "📁 Memory" },
  { id: "learning", label: "🔬 Learning" },
  { id: "sessions", label: "🕐 Sessions" },
  { id: "history", label: "📜 History" },
  { id: "bridge", label: "🌉 Bridge" },
  { id: "vault", label: "🔐 Vault" },
  { id: "settings", label: "⚙️ Settings" },
] as const;

export function TabBar() {
  const { state, dispatch } = useAppState();

  const switchTab = (tabId: string) => {
    dispatch({ type: "SET_TAB", tab: tabId });
    postMessage({ type: "switchTab", tab: tabId });

    // Auto-load data on tab switch
    if (tabId === "memory") postMessage({ type: "getMemoryFiles" });
    if (tabId === "sessions") postMessage({ type: "getSessionHistory" });
    if (tabId === "swarm") postMessage({ type: "requestSwarmState" });
    if (tabId === "orchestration") {
      postMessage({ type: "getAgentCatalog" });
      postMessage({ type: "getAvailableModels" });
      postMessage({ type: "requestOrchState" });
    }
    if (tabId === "loop" && state.activeLoopSessionId) {
      postMessage({
        type: "requestLoopState",
        sessionId: state.activeLoopSessionId,
      });
    }
    if (tabId === "backlog") {
      postMessage({ type: "requestPendingBranches" });
      postMessage({ type: "requestAllBranches" });
      postMessage({ type: "requestHibernatedLoops" });
    }
    if (tabId === "history") postMessage({ type: "getConversationHistory" });
    if (tabId === "learning") {
      postMessage({ type: "sl:getRepos" } as never);
      postMessage({ type: "sl:getConfig" } as never);
    }
    if (tabId === "bridge") {
      postMessage({ type: "requestAutoLoopBridgeState" } as never);
    }
  };

  const getBadge = (tabId: string): string | null => {
    if (tabId === "swarm" && state.swarm.running) return "LIVE";
    if (tabId === "loop") {
      const activeCount = Object.values(state.loopSessions).filter(
        (s) => s.state === "active" || s.state === "awaiting",
      ).length;
      const interruptedCount = state.interruptedLoops.length;
      if (activeCount > 0) return `${activeCount} LIVE`;
      if (interruptedCount > 0) return `${interruptedCount} ⚡`;
    }
    if (tabId === "orchestration") {
      const activeCount = Object.values(state.orchSessions).filter(
        (s) => s.state === "active" || s.state === "planning",
      ).length;
      if (activeCount > 0) return `${activeCount} LIVE`;
    }
    if (
      tabId === "backlog" &&
      (state.pendingBranches.length > 0 ||
        state.hibernatedLoops.length > 0 ||
        state.interruptedLoops.length > 0)
    ) {
      const total =
        state.pendingBranches.length +
        state.hibernatedLoops.length +
        state.interruptedLoops.length;
      return `${total}`;
    }
    return null;
  };

  return (
    <div className="flex border-b border-vsc-border bg-vsc-header overflow-x-auto">
      {TABS.filter((tab) => {
        // If tabConfig has an entry for this tab, use it; otherwise visible by default
        const cfg = state.tabConfig[tab.id];
        return cfg === undefined || cfg === true;
      }).map((tab) => {
        const badge = getBadge(tab.id);
        const isActive = state.activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className={`
              relative px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors
              border-b-2 cursor-pointer
              ${
                isActive
                  ? "border-vsc-accent text-vsc-accent"
                  : "border-transparent opacity-60 hover:opacity-100"
              }
            `}>
            {tab.label}
            {badge && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-red-500 text-white rounded-full animate-pulse">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
