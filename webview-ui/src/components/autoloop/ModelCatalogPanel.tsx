import { useState, useMemo } from "react";
import { useAppState } from "../../store/AppContext";
import { postMessage } from "../../vscode";

/**
 * ModelCatalogPanel — Compact model picker organized by provider/section.
 * For OpenRouter: groups models by provider prefix (anthropic, openai, google, etc.)
 * For Gemini: flat list since all are Google models.
 */
export function ModelCatalogPanel({ providerId }: { providerId: string }) {
  const { state } = useAppState();
  const catalog = state.bridgeModelCatalog[providerId];
  const loading = state.bridgeCatalogLoading;

  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string> | null>(null);

  // Derive enabled set from pending (local) or catalog (persisted)
  const enabledIds = useMemo(() => {
    if (pendingIds) { return pendingIds; }
    return new Set(catalog?.enabledModelIds ?? []);
  }, [pendingIds, catalog?.enabledModelIds]);

  const groups = catalog?.groups ?? {};
  const sortedGroupNames = useMemo(() => Object.keys(groups).sort(), [groups]);

  // Filter groups/models by search
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) { return groups; }
    const result: Record<string, Array<{ id: string; label: string }>> = {};
    for (const [group, models] of Object.entries(groups)) {
      const matches = models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
      );
      if (matches.length > 0) { result[group] = matches; }
    }
    return result;
  }, [groups, search]);

  const filteredGroupNames = useMemo(() => Object.keys(filtered).sort(), [filtered]);
  const totalModels = Object.values(groups).reduce((s, g) => s + g.length, 0);

  function handleFetchCatalog() {
    postMessage({ type: "requestBridgeModelCatalog", providerId } as never);
  }

  function toggleModel(modelId: string) {
    const next = new Set(enabledIds);
    if (next.has(modelId)) { next.delete(modelId); } else { next.add(modelId); }
    setPendingIds(next);
  }

  function toggleGroup(groupName: string) {
    const models = groups[groupName] ?? [];
    const allEnabled = models.every((m) => enabledIds.has(m.id));
    const next = new Set(enabledIds);
    for (const m of models) {
      if (allEnabled) { next.delete(m.id); } else { next.add(m.id); }
    }
    setPendingIds(next);
  }

  function toggleExpanded(groupName: string) {
    const next = new Set(expandedGroups);
    if (next.has(groupName)) { next.delete(groupName); } else { next.add(groupName); }
    setExpandedGroups(next);
  }

  function handleSave() {
    if (!pendingIds) { return; }
    postMessage({
      type: "saveBridgeEnabledModels",
      providerId,
      enabledModelIds: Array.from(pendingIds),
    } as never);
    setPendingIds(null);
  }

  if (!catalog) {
    return (
      <div className="space-y-2">
        <button
          onClick={handleFetchCatalog}
          disabled={loading}
          className="px-3 py-1.5 rounded text-xs bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] disabled:opacity-50"
        >
          {loading ? "Loading catalog..." : `🔍 Load ${providerId} models`}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {enabledIds.size} / {totalModels} models enabled
        </span>
        <div className="flex gap-1">
          <button
            onClick={handleFetchCatalog}
            className="px-2 py-0.5 text-xs rounded opacity-60 hover:opacity-100"
            title="Refresh catalog"
          >
            🔄
          </button>
          {pendingIds && (
            <button
              onClick={handleSave}
              className="px-2 py-0.5 text-xs rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
            >
              💾 Save
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter models..."
        className="w-full px-2 py-1 rounded text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)]"
      />

      {/* Groups */}
      <div className="max-h-64 overflow-y-auto space-y-1">
        {filteredGroupNames.map((groupName) => {
          const models = filtered[groupName];
          const expanded = expandedGroups.has(groupName);
          const enabledInGroup = models.filter((m) => enabledIds.has(m.id)).length;

          return (
            <div key={groupName} className="border border-[var(--vscode-panel-border)] rounded">
              <div
                className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)]"
                onClick={() => toggleExpanded(groupName)}
              >
                <span className="text-xs opacity-60">{expanded ? "▼" : "▶"}</span>
                <input
                  type="checkbox"
                  checked={models.every((m) => enabledIds.has(m.id))}
                  onChange={(e) => { e.stopPropagation(); toggleGroup(groupName); }}
                  className="accent-[var(--vscode-button-background)]"
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="text-xs font-medium flex-1">{groupName}</span>
                <span className="text-xs opacity-50">
                  {enabledInGroup}/{models.length}
                </span>
              </div>

              {expanded && (
                <div className="px-2 pb-1 space-y-0.5">
                  {models.map((m) => (
                    <label
                      key={m.id}
                      className="flex items-center gap-2 text-xs py-0.5 px-2 rounded hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={enabledIds.has(m.id)}
                        onChange={() => toggleModel(m.id)}
                        className="accent-[var(--vscode-button-background)]"
                      />
                      <span className="truncate" title={m.id}>{m.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filteredGroupNames.length === 0 && (
          <div className="text-xs opacity-50 text-center py-2">
            {search ? "No models match search" : "No models available"}
          </div>
        )}
      </div>
    </div>
  );
}
