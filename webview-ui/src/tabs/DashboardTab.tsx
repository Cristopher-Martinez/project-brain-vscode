import { useEffect } from "react";
import { GatewayWidget } from "../components/GatewayWidget";
import { useAppState } from "../store/AppContext";
import type { McpSmokeLoopUpdate } from "../types/messages";
import { postMessage } from "../vscode";

function UpdateBanner() {
  const { state, dispatch } = useAppState();
  const { extensionUpdate } = state;

  useEffect(() => {
    dispatch({ type: "SET_EXTENSION_UPDATE_CHECK", checking: true });
    postMessage({ type: "checkExtensionUpdate" });
  }, [dispatch]);

  // Error state — show inline in dashboard
  if (extensionUpdate.installStatus === "error") {
    return (
      <div className="mb-4 p-3 bg-red-900/30 border border-red-600 rounded-lg flex items-center gap-3">
        <span className="text-lg">❌</span>
        <span className="text-sm">Update failed: {extensionUpdate.installError}</span>
        <button
          className="ml-auto px-3 py-1 text-xs bg-red-700 hover:bg-red-600 rounded cursor-pointer"
          onClick={() => postMessage({ type: "installExtensionUpdate" })}
        >
          Retry
        </button>
      </div>
    );
  }

  if (extensionUpdate.checking) {
    return (
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs animate-pulse opacity-50">🔍 Checking for updates...</span>
      </div>
    );
  }

  // "Up to date" + manual check button (only on dashboard)
  if (!extensionUpdate.available && !extensionUpdate.installing && extensionUpdate.installStatus !== "done") {
    return (
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs opacity-40">
          v{extensionUpdate.currentVersion ?? "?"} — up to date
        </span>
        <button
          className="text-xs opacity-40 hover:opacity-70 underline transition-opacity cursor-pointer"
          onClick={() => {
            dispatch({ type: "SET_EXTENSION_UPDATE_CHECK", checking: true });
            postMessage({ type: "checkExtensionUpdate" });
          }}
        >
          Check now
        </button>
      </div>
    );
  }

  // Update available / installing / done states are handled by GlobalUpdateAlert in App.tsx
  return null;
}

function McpSmokeBox({ data }: { data: McpSmokeLoopUpdate }) {
  const status = data.running
    ? "⏳ Running"
    : data.done
      ? data.pass
        ? "✅ PASS"
        : "❌ FAIL"
      : "Idle";

  return (
    <div className="mt-3 p-3 bg-vsc-header border border-vsc-border rounded-lg text-xs space-y-1">
      <Row label="Status" value={status} />
      <Row label="Attempt" value={`${data.attempt || 0}/10`} />
      <Row label="Consecutive OK" value={`${data.consecutiveOk || 0}/3`} />
      <Row
        label="Tools"
        value={data.toolsCount !== undefined ? String(data.toolsCount) : "—"}
      />
      <Row label="Last Error" value={data.lastError || "—"} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="opacity-50">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function DashboardTab() {
  const { state } = useAppState();
  const { stats, swarm, mcpSmoke, gateway } = state;

  // Request gateway state on mount
  useEffect(() => {
    postMessage({ type: "requestGatewayState" });
  }, []);

  const runCmd = (cmd: string) =>
    postMessage({ type: "runCommand", commandId: cmd });

  return (
    <div>
      {/* Extension Update Banner */}
      <UpdateBanner />

      {/* Agent Card */}
      <div className="flex items-center gap-4 p-4 bg-vsc-header border border-vsc-border rounded-lg mb-5">
        <span className="text-[42px]">{stats.agentEmoji}</span>
        <div className="flex-1">
          <h3 className="text-base font-bold">{stats.agentName}</h3>
          <p className="text-xs opacity-60">{stats.agentCreature}</p>
        </div>
        <span className="text-xs opacity-50">🌿 {stats.branch}</span>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <StatCard
          value={stats.memoryFiles}
          label="Memory Files"
          accent="accent"
        />
        <StatCard value={stats.opinions} label="Opinions" accent="success" />
        <StatCard value={stats.skills} label="Skills" accent="warning" />
        <StatCard
          value={swarm.running ? "🔴" : "⚪"}
          label="Swarm"
          accent={swarm.running ? "accent" : undefined}
        />
      </div>

      {/* MCP Gateway */}
      <GatewayWidget gateway={gateway} />

      {/* Quick Actions */}
      <h3 className="text-sm font-semibold mb-3 opacity-80">Quick Actions</h3>
      <div className="grid grid-cols-3 gap-2 mb-5">
        <ActionBtn
          icon="🚀"
          label="Init Project"
          onClick={() => runCmd("projectBrain.init")}
        />
        <ActionBtn
          icon="🔍"
          label="Scan & Update"
          onClick={() => runCmd("projectBrain.scan")}
        />
        <ActionBtn
          icon="🧲"
          label="Auto-Vectorize"
          onClick={() => runCmd("projectBrain.startAutoVectorization")}
        />
        <ActionBtn
          icon="📂"
          label="Open Memory"
          onClick={() => runCmd("projectBrain.openMemory")}
        />
        <ActionBtn
          icon="📋"
          label="Status"
          onClick={() => runCmd("projectBrain.status")}
        />
        <ActionBtn
          icon="🔄"
          label="Refresh HQ"
          onClick={() => postMessage({ type: "refresh" })}
        />
      </div>

      {/* MCP Smoke Loop */}
      <h3 className="text-sm font-semibold mb-3 opacity-80">
        MCP Smoke Loop (agent-orchestrator)
      </h3>
      <div className="flex gap-2 mb-1">
        <button
          onClick={() => postMessage({ type: "startMcpSmokeLoop" })}
          disabled={mcpSmoke.running}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 disabled:opacity-30 cursor-pointer">
          🧪 Start
        </button>
        <button
          onClick={() => postMessage({ type: "stopMcpSmokeLoop" })}
          disabled={!mcpSmoke.running}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 disabled:opacity-30 cursor-pointer">
          🛑 Stop
        </button>
      </div>
      <McpSmokeBox data={mcpSmoke} />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  accent,
}: {
  value: number | string;
  label: string;
  accent?: string;
}) {
  const borderClass =
    accent === "accent"
      ? "border-l-vsc-accent"
      : accent === "success"
        ? "border-l-vsc-success"
        : accent === "warning"
          ? "border-l-vsc-warning"
          : "border-l-vsc-border";

  return (
    <div
      className={`p-3 bg-vsc-header border border-vsc-border rounded-lg border-l-3 ${borderClass} text-center`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[10px] opacity-60 mt-1">{label}</div>
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 transition-colors cursor-pointer">
      <span>{icon}</span> {label}
    </button>
  );
}
