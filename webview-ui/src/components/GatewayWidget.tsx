// ─── MCP Gateway Widget — Token management, request log, connection snippets ─
// Extracted from DashboardTab.tsx to stay under 400-line limit.
import { useEffect, useState } from "react";
import type {
  GatewayRequestLog,
  GatewayState,
  GatewayTokenInfo,
} from "../types/messages";
import { postMessage } from "../vscode";

interface GatewayWidgetProps {
  gateway: GatewayState;
}

export function GatewayWidget({ gateway }: GatewayWidgetProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["read"]);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [createdToast, setCreatedToast] = useState<string | null>(null);
  const [createdTokenValue, setCreatedTokenValue] = useState<string | null>(
    null,
  );

  // Auto-refresh gateway state every 5s while running
  useEffect(() => {
    if (!gateway.running) return;
    const interval = setInterval(() => {
      postMessage({ type: "requestGatewayState" });
    }, 5000);
    return () => clearInterval(interval);
  }, [gateway.running]);

  // Listen for token created events
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "gatewayTokenCreated") {
        setCreatedTokenValue(msg.token);
        setCreatedToast(msg.label);
        setTimeout(() => {
          setCreatedToast(null);
          setCreatedTokenValue(null);
        }, 15000); // Show for 15 seconds
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const allScopes = ["read", "write", "loop", "orchestrate"];

  const toggleScope = (s: string) => {
    setNewScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  };

  const handleCreate = () => {
    if (!newLabel.trim()) return;
    postMessage({
      type: "createGatewayToken",
      label: newLabel.trim(),
      scopes: newScopes,
    });
    setNewLabel("");
    setNewScopes(["read"]);
    setShowCreate(false);
  };

  const handleRevoke = (label: string) => {
    if (
      !confirm(
        `Revoke token "${label}"? External clients using it will lose access.`,
      )
    )
      return;
    postMessage({ type: "revokeGatewayToken", label });
  };

  return (
    <div className="p-4 bg-vsc-header border border-vsc-border rounded-lg mb-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold opacity-80">🔌 MCP Gateway</h3>
        <div className="flex items-center gap-2">
          {gateway.running && (
            <span className="text-[10px] opacity-50">
              {gateway.sessions} session{gateway.sessions !== 1 ? "s" : ""}
            </span>
          )}
          <span
            className={`text-xs px-2 py-0.5 rounded ${gateway.running ? "bg-green-800 text-green-200" : "bg-gray-700 text-gray-300"}`}>
            {gateway.running ? `Running :${gateway.port}` : "Stopped"}
          </span>
        </div>
      </div>
      <p className="text-xs opacity-50 mb-3">
        HTTP server for external MCP clients (Telegram, Discord, CLIs)
      </p>

      {/* Controls */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <button
          onClick={() => postMessage({ type: "toggleGateway" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer">
          {gateway.running ? "🛑 Stop" : "🚀 Start"}
        </button>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer">
          🔑 {showCreate ? "Cancel" : "New Token"}
        </button>
        <button
          onClick={() => {
            setShowLog(!showLog);
            if (!showLog) postMessage({ type: "requestGatewayLog" });
          }}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer">
          📊 {showLog ? "Hide Log" : "Request Log"}
        </button>
        <button
          onClick={() => postMessage({ type: "requestGatewayState" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer opacity-60">
          🔄
        </button>
      </div>

      {/* Create Token Form */}
      {showCreate && (
        <div className="p-3 bg-vsc-bg border border-vsc-border rounded mb-3 space-y-2">
          <input
            type="text"
            placeholder="Token label (e.g. telegram-bot)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="w-full px-2 py-1 text-xs bg-vsc-input-bg border border-vsc-border rounded text-vsc-fg outline-none focus:border-vsc-accent"
          />
          <div className="flex gap-1 flex-wrap">
            {allScopes.map((scope) => (
              <button
                key={scope}
                onClick={() => toggleScope(scope)}
                className={`px-2 py-0.5 text-[10px] rounded cursor-pointer ${
                  newScopes.includes(scope)
                    ? "bg-vsc-accent text-white"
                    : "bg-vsc-btn-sec-bg text-vsc-btn-sec-fg opacity-50"
                }`}>
                {scope}
              </button>
            ))}
          </div>
          <button
            onClick={handleCreate}
            disabled={!newLabel.trim()}
            className="px-3 py-1 text-xs rounded bg-vsc-accent text-white hover:opacity-80 disabled:opacity-30 cursor-pointer">
            Create Token
          </button>
        </div>
      )}

      {/* Token Created Toast (shows actual token for copying) */}
      {createdToast && (
        <div className="p-3 bg-green-900 border border-green-700 rounded text-xs text-green-200 mb-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold">
              🔑 Token "{createdToast}" created!
            </span>
            <button
              onClick={() => {
                setCreatedToast(null);
                setCreatedTokenValue(null);
              }}
              className="text-[10px] opacity-50 hover:opacity-100 cursor-pointer">
              ✕
            </button>
          </div>
          {createdTokenValue && (
            <>
              <div className="font-mono text-[10px] bg-green-950 p-2 rounded break-all select-all">
                {createdTokenValue}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    postMessage({
                      type: "runCommand",
                      commandId: "projectBrain.gateway.showToken",
                    });
                  }}
                  className="px-2 py-1 text-[10px] rounded bg-green-800 hover:opacity-80 cursor-pointer">
                  📋 Copy to Clipboard
                </button>
                <SnippetButtons tokenLabel={createdToast} />
              </div>
            </>
          )}
        </div>
      )}

      {/* Token List */}
      {(gateway.tokens?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] opacity-50 mb-1 uppercase tracking-wider">
            Active Tokens ({gateway.tokens.length})
          </div>
          {gateway.tokens.map((t) => (
            <TokenRow
              key={t.label}
              token={t}
              copied={copiedToken === t.label}
              onCopy={() => {
                postMessage({
                  type: "runCommand",
                  commandId: "projectBrain.gateway.showToken",
                });
                setCopiedToken(t.label);
                setTimeout(() => setCopiedToken(null), 2000);
              }}
              onRevoke={() => handleRevoke(t.label)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {(gateway.tokens?.length ?? 0) === 0 && !showCreate && (
        <p className="text-[10px] opacity-40 italic">
          No tokens yet — create one to connect external clients
        </p>
      )}

      {/* Request Log */}
      {showLog && <RequestLogPanel log={gateway.requestLog ?? []} />}
    </div>
  );
}

// ─── Token Row ────────────────────────────────────────────────────────────────

function TokenRow({
  token,
  copied,
  onCopy,
  onRevoke,
}: {
  token: GatewayTokenInfo;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const createdDate = new Date(token.createdAt).toLocaleDateString();
  const lastUsed = token.lastUsed
    ? new Date(token.lastUsed).toLocaleDateString()
    : "never";
  const isExpired = token.expiresAt && new Date(token.expiresAt) < new Date();

  return (
    <div
      className={`flex items-center justify-between p-2 bg-vsc-bg border rounded text-xs group ${
        isExpired ? "border-red-700 opacity-50" : "border-vsc-border"
      }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold truncate">🏷️ {token.label}</span>
          <span className="text-[10px] opacity-40">{createdDate}</span>
          {isExpired && (
            <span className="text-[9px] text-red-400">EXPIRED</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <div className="flex gap-1">
            {token.scopes.map((s) => (
              <span
                key={s}
                className="px-1.5 py-0 text-[9px] rounded bg-vsc-btn-sec-bg opacity-60">
                {s}
              </span>
            ))}
          </div>
          <span className="text-[9px] opacity-30">last used: {lastUsed}</span>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <SnippetButtons tokenLabel={token.label} />
        <button
          onClick={onCopy}
          className="px-2 py-1 text-[10px] rounded bg-vsc-btn-sec-bg hover:opacity-80 cursor-pointer"
          title="Copy token to clipboard">
          {copied ? "✅" : "👁️"}
        </button>
        <button
          onClick={onRevoke}
          className="px-2 py-1 text-[10px] rounded bg-red-900 text-red-200 hover:opacity-80 cursor-pointer"
          title="Revoke token">
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Connection Snippet Buttons ───────────────────────────────────────────────

function SnippetButtons({ tokenLabel }: { tokenLabel: string }) {
  const copySnippet = (language: "curl" | "node" | "python") => {
    postMessage({ type: "copyConnectionSnippet", tokenLabel, language });
  };

  return (
    <div className="flex gap-0.5">
      <button
        onClick={() => copySnippet("curl")}
        className="px-1.5 py-1 text-[9px] rounded bg-vsc-btn-sec-bg hover:opacity-80 cursor-pointer"
        title="Copy curl snippet">
        curl
      </button>
      <button
        onClick={() => copySnippet("node")}
        className="px-1.5 py-1 text-[9px] rounded bg-vsc-btn-sec-bg hover:opacity-80 cursor-pointer"
        title="Copy Node.js snippet">
        node
      </button>
      <button
        onClick={() => copySnippet("python")}
        className="px-1.5 py-1 text-[9px] rounded bg-vsc-btn-sec-bg hover:opacity-80 cursor-pointer"
        title="Copy Python snippet">
        py
      </button>
    </div>
  );
}

// ─── Request Log Panel ────────────────────────────────────────────────────────

function RequestLogPanel({ log }: { log: GatewayRequestLog[] }) {
  if (log.length === 0) {
    return (
      <div className="mt-3 p-3 bg-vsc-bg border border-vsc-border rounded text-xs opacity-40 italic">
        No requests logged yet. Tool calls will appear here.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-1">
      <div className="text-[10px] opacity-50 uppercase tracking-wider mb-1">
        Recent Requests ({log.length})
      </div>
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {log.map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const statusIcon =
            entry.status === "ok"
              ? "✅"
              : entry.status === "denied"
                ? "🚫"
                : "❌";
          return (
            <div
              key={i}
              className="flex items-center justify-between p-1.5 bg-vsc-bg border border-vsc-border rounded text-[10px]">
              <div className="flex items-center gap-2">
                <span>{statusIcon}</span>
                <span className="font-mono opacity-70">{entry.tool}</span>
                <span className="opacity-30">via {entry.tokenLabel}</span>
              </div>
              <div className="flex items-center gap-2 opacity-40">
                {entry.durationMs !== undefined && (
                  <span>{entry.durationMs}ms</span>
                )}
                <span>{time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
