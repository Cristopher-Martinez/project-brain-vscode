import { useState, useEffect } from "react";
import { useAppState } from "../../store/AppContext";
import { postMessage } from "../../vscode";
import { ModelCatalogPanel } from "./ModelCatalogPanel";

export function BridgeSettingsToggle() {
  const [open, setOpen] = useState(false);
  const { dispatch } = useAppState();

  return (
    <button
      onClick={() => {
        const next = !open;
        setOpen(next);
        if (next) postMessage({ type: "requestBridgeProviders" } as never);
        dispatch({ type: "SET_TAB", tab: open ? "bridge" : "bridge" });
      }}
      className="px-2 py-1 text-xs rounded opacity-60 hover:opacity-100"
      data-settings-open={open}
    >
      ⚙️ Settings
    </button>
  );
}

export function BridgeSettingsPanel() {
  const { state, dispatch } = useAppState();
  const [expanded, setExpanded] = useState(true);
  const [apiKey, setApiKey] = useState("");

  const providers = state.bridgeProviders ?? [];
  const selectedProvider = state.selectedBridgeProviderId ?? "";

  useEffect(() => {
    if (expanded && providers.length === 0) {
      postMessage({ type: "requestBridgeProviders" } as never);
    }
  }, [expanded]);

  useEffect(() => {
    if (selectedProvider) {
      postMessage({ type: "requestBridgeModels", providerId: selectedProvider } as never);
    }
  }, [selectedProvider]);

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="text-xs opacity-50 hover:opacity-100"
      >
        ▶ Model Provider Settings
      </button>
    );
  }

  return (
    <div className="border border-[var(--vscode-panel-border)] rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">⚙️ PM Provider Settings</h3>
        <button onClick={() => setExpanded(false)} className="text-xs opacity-60 hover:opacity-100">
          ▼ Collapse
        </button>
      </div>

            {/* API Key Status */}
      <div className="text-xs px-2 py-1 rounded" style={{
        background: "var(--vscode-editor-background)",
        opacity: 0.8,
      }}>
        &#x1F511; API Key: <span style={{ color: "var(--vscode-charts-green, #4ec9b0)" }}>
          Configured via VS Code Settings
        </span>
      </div>

      {state.bridgeSettingsError && (
        <div className="text-xs text-red-400 bg-red-900/20 px-2 py-1 rounded">
          {state.bridgeSettingsError}
        </div>
      )}

      {/* Provider selector */}
      <div className="space-y-1">
        <label className="text-xs font-medium">Provider</label>
        <div className="flex gap-2">
          {providers.map((p) => (
            <button
              key={p.providerId}
              onClick={() => {
                dispatch({ type: "SET_ACTIVE_BRIDGE_PROVIDER", providerId: p.providerId });
                if (!p.isDefault) {
                  postMessage({
                    type: "setBridgeDefaultProvider",
                    providerId: p.providerId,
                  } as never);
                }
              }}
              className={`px-3 py-1 rounded text-xs ${
                p.isDefault
                  ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
                  : "bg-[var(--vscode-editor-background)] hover:opacity-80"
              }`}
            >
              {p.label} {p.isDefault && "✓"}
            </button>
          ))}
          {providers.length === 0 && (
            <span className="text-xs opacity-50">Loading providers...</span>
          )}
        </div>
      </div>

      {/* Model Catalog */}
      {selectedProvider && (
        <div className="space-y-1">
          <label className="text-xs font-medium">Model Catalog ({selectedProvider})</label>
          <ModelCatalogPanel providerId={selectedProvider} />
        </div>
      )}

      {/* API Key */}
      {selectedProvider && (
        <div className="space-y-1">
          <label className="text-xs font-medium">API Key ({selectedProvider})</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter API key..."
              className="flex-1 px-2 py-1 rounded text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)]"
            />
            <button
              onClick={() => {
                if (apiKey.trim()) {
                  postMessage({
                    type: "saveBridgeApiKey",
                    providerId: selectedProvider,
                    apiKey,
                  } as never);
                  setApiKey("");
                }
              }}
              disabled={!apiKey.trim()}
              className="px-3 py-1 rounded text-xs bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
