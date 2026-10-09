import { useState } from "react";
import { useAppState } from "../store/AppContext";
import type { ConversationHistoryEntry } from "../types/messages";
import { postMessage } from "../vscode";

// ─── Temporal Quick Filters ─────────────────────────────────────────────────

const TEMPORAL_FILTERS = [
  { label: "Hoy", query: "today" },
  { label: "Ayer", query: "yesterday" },
  { label: "Esta semana", query: "this week" },
  { label: "Últimos 7d", query: "last 7 days" },
  { label: "Últimos 30d", query: "last 30 days" },
] as const;

// ─── Component ──────────────────────────────────────────────────────────────

export function HistoryTab() {
  const { state } = useAppState();
  const [searchInput, setSearchInput] = useState("");
  const [searchMode, setSearchMode] = useState<"search" | "temporal">("search");
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const doSearch = (query: string, mode: "search" | "temporal") => {
    if (!query.trim()) return;
    postMessage({ type: "searchConversationHistory", query, mode });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveFilter(null);
    doSearch(searchInput, searchMode);
  };

  const handleTemporalFilter = (query: string) => {
    setActiveFilter(query);
    setSearchInput("");
    doSearch(query, "temporal");
  };

  const clearSearch = () => {
    setSearchInput("");
    setActiveFilter(null);
    postMessage({ type: "getConversationHistory" });
  };

  const formatDate = (dateStr: string): string => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  const conversations = state.conversationHistory;
  const hasSearch = state.conversationSearchQuery.length > 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold opacity-80">
          📜 Historial de Conversaciones
        </h2>
        <button
          onClick={() => postMessage({ type: "getConversationHistory" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer"
        >
          🔄 Actualizar
        </button>
      </div>

      {/* Search Bar */}
      <form onSubmit={handleSearchSubmit} className="flex gap-2 mb-3">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={
            searchMode === "search"
              ? "Buscar en conversaciones..."
              : "Ej: last 3 days, hace 2 semanas..."
          }
          className="flex-1 px-3 py-1.5 text-xs rounded border border-vsc-border bg-vsc-input-bg text-vsc-input-fg placeholder:opacity-40"
        />
        <select
          value={searchMode}
          onChange={(e) =>
            setSearchMode(e.target.value as "search" | "temporal")
          }
          className="px-2 py-1.5 text-xs rounded border border-vsc-border bg-vsc-input-bg text-vsc-input-fg cursor-pointer"
        >
          <option value="search">🔍 Texto</option>
          <option value="temporal">📅 Fecha</option>
        </select>
        <button
          type="submit"
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-bg text-vsc-btn-fg hover:opacity-80 cursor-pointer"
        >
          Buscar
        </button>
      </form>

      {/* Temporal Quick Filters */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {TEMPORAL_FILTERS.map((f) => (
          <button
            key={f.query}
            onClick={() => handleTemporalFilter(f.query)}
            className={`px-2.5 py-1 text-[11px] rounded-full border cursor-pointer transition-colors ${
              activeFilter === f.query
                ? "bg-vsc-accent text-white border-vsc-accent"
                : "border-vsc-border hover:bg-vsc-hover"
            }`}
          >
            {f.label}
          </button>
        ))}
        {hasSearch && (
          <button
            onClick={clearSearch}
            className="px-2.5 py-1 text-[11px] rounded-full border border-red-400 text-red-400 hover:bg-red-400/10 cursor-pointer"
          >
            ✕ Limpiar
          </button>
        )}
      </div>

      {/* Search indicator */}
      {hasSearch && (
        <div className="text-[11px] opacity-60 mb-3">
          📌 Mostrando resultados para: &quot;{state.conversationSearchQuery}&quot;
          ({conversations.length} encontrados)
        </div>
      )}

      {/* Conversation List */}
      {conversations.length === 0 ? (
        <EmptyState hasSearch={hasSearch} />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto space-y-1.5">
          {conversations.map((conv) => (
            <ConversationCard key={conv.chatSessionId} conv={conv} formatDate={formatDate} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="text-center py-10 opacity-50">
      <div className="text-3xl mb-2">{hasSearch ? "🔍" : "📜"}</div>
      <p className="text-xs">
        {hasSearch
          ? "No se encontraron conversaciones con esos criterios"
          : "Haz click en \"Actualizar\" para cargar el historial"}
      </p>
    </div>
  );
}

interface CardProps {
  conv: ConversationHistoryEntry;
  formatDate: (d: string) => string;
}

function ConversationCard({ conv, formatDate }: CardProps) {
  return (
    <div className="p-3 rounded border border-vsc-border hover:bg-vsc-hover transition-colors">
      {/* Top row: date + turns */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] opacity-70">{formatDate(conv.date)}</span>
        <span className="text-[11px] opacity-50">
          💬 {conv.turns} turnos
        </span>
      </div>

      {/* Preview */}
      <p className="text-xs leading-relaxed mb-2 line-clamp-2">{conv.preview}</p>

      {/* Tools */}
      {conv.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {conv.tools.slice(0, 6).map((tool) => (
            <span
              key={tool}
              className="px-1.5 py-0.5 text-[10px] rounded bg-vsc-badge-bg text-vsc-badge-fg"
            >
              🔧 {tool}
            </span>
          ))}
          {conv.tools.length > 6 && (
            <span className="text-[10px] opacity-50">
              +{conv.tools.length - 6} más
            </span>
          )}
        </div>
      )}
    </div>
  );
}
