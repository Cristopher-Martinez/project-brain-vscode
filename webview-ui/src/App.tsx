import { useEffect } from "react";
import { Header } from "./components/Header";
import { TabBar } from "./components/TabBar";
import { useAppState } from "./store/AppContext";
import { BacklogTab } from "./tabs/BacklogTab";
import { DashboardTab } from "./tabs/DashboardTab";
import { HistoryTab } from "./tabs/HistoryTab";
import { LearningTab } from "./tabs/LearningTab";
import { LoopTab } from "./tabs/LoopTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { OrchestrationTab } from "./tabs/OrchestrationTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SwarmTab } from "./tabs/SwarmTab";
import { AutoLoopBridgeTab } from "./tabs/AutoLoopBridgeTab";
import { VaultTab } from "./tabs/VaultTab";
import { postMessage } from "./vscode";

/** Global update alert — always visible when an update is available */
function GlobalUpdateAlert() {
  const { state } = useAppState();
  const { extensionUpdate } = state;

  if (extensionUpdate.installStatus === "done") {
    return (
      <div className="px-4 py-2.5 bg-green-600 text-white text-center text-sm font-medium flex items-center justify-center gap-2">
        <span>✅</span>
        <span>Update installed — reload VS Code to apply</span>
        <button
          className="ml-3 px-3 py-1 text-xs bg-green-800 hover:bg-green-900 rounded font-medium cursor-pointer"
          onClick={() =>
            postMessage({ type: "runCommand", commandId: "workbench.action.reloadWindow" })
          }
        >
          Reload Now
        </button>
      </div>
    );
  }

  if (extensionUpdate.installing) {
    return (
      <div className="px-4 py-2.5 bg-blue-600 text-white text-center text-sm font-medium animate-pulse">
        ⏳ {extensionUpdate.installStatus === "downloading" ? "Downloading" : "Installing"} update...
      </div>
    );
  }

  if (!extensionUpdate.available) return null;

  const sizeMB = extensionUpdate.size
    ? `${(extensionUpdate.size / 1024 / 1024).toFixed(1)} MB`
    : "";

  return (
    <div className="px-4 py-2.5 bg-gradient-to-r from-yellow-600 to-amber-600 text-white text-sm font-medium flex items-center justify-center gap-3">
      <span className="text-lg">🆕</span>
      <span>
        Update available: <strong>v{extensionUpdate.latestVersion}</strong>
        <span className="opacity-80 ml-1">(current: v{extensionUpdate.currentVersion})</span>
        {sizeMB && <span className="opacity-70 ml-1">· {sizeMB}</span>}
      </span>
      <button
        className="ml-2 px-4 py-1 text-xs bg-white/20 hover:bg-white/30 rounded font-bold cursor-pointer transition-colors"
        onClick={() => postMessage({ type: "installExtensionUpdate" })}
      >
        Update Now
      </button>
      {extensionUpdate.changelog && (
        <span className="opacity-70 text-xs ml-2 hidden sm:inline">
          — {extensionUpdate.changelog}
        </span>
      )}
    </div>
  );
}

export function App() {
  const { state } = useAppState();

  // Signal readiness + request initial state
  useEffect(() => {
    postMessage({ type: "webviewReady" } as never);
    postMessage({ type: "requestAllOrchStates" });
    postMessage({ type: "requestAllLoopStates" });
  }, []);

  // Auto-refresh swarm state periodically
  // Only poll swarm state when the swarm tab is active
  useEffect(() => {
    if (state.activeTab !== "swarm") return;
    const timer = setInterval(() => {
      postMessage({ type: "requestSwarmState" });
    }, 2000);
    return () => clearInterval(timer);
  }, [state.activeTab]);

  const renderTab = () => {
    switch (state.activeTab) {
      case "dashboard":
        return <DashboardTab />;
      case "swarm":
        return <SwarmTab />;
      case "orchestration":
        return <OrchestrationTab />;
      case "loop":
        return <LoopTab />;
      case "backlog":
        return <BacklogTab />;
      case "memory":
        return <MemoryTab />;
      case "learning":
        return <LearningTab />;
      case "sessions":
        return <SessionsTab />;
      case "settings":
        return <SettingsTab />;
      case "history":
        return <HistoryTab />;
      case "bridge":
        return <AutoLoopBridgeTab />;
      case "vault":
        return <VaultTab />;
      default:
        return <DashboardTab />;
    }
  };

  return (
    <div className="min-h-screen">
      <Header />
      <GlobalUpdateAlert />
      <TabBar />
      <div className="p-5">{renderTab()}</div>
    </div>
  );
}
