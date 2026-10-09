import { useState, useMemo } from "react";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";
import type { MemoryFileInfo } from "../types/messages";

// ─── Constants ──────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "all", label: "Todos", icon: "📋" },
  { id: "plan", label: "Planes", icon: "🗺️" },
  { id: "skill", label: "Skills", icon: "🧠" },
  { id: "learning", label: "Learnings", icon: "💡" },
  { id: "troubleshooting", label: "Troubleshoot", icon: "🔧" },
  { id: "architecture", label: "Arquitectura", icon: "🏗️" },
  { id: "session", label: "Sesiones", icon: "📝" },
  { id: "reference", label: "Referencia", icon: "📚" },
  { id: "other", label: "Otros", icon: "📄" },
] as const;

type SortField = "name" | "date" | "size";

// ─── Helpers ────────────────────────────────────────────────────────────────

function matchesSearch(file: MemoryFileInfo, query: string): boolean {
  const q = query.toLowerCase();
  return (
    file.name.toLowerCase().includes(q) ||
    file.relativePath.toLowerCase().includes(q) ||
    file.excerpt.toLowerCase().includes(q) ||
    file.tags.some((t) => t.toLowerCase().includes(q))
  );
}

function collectAllTags(files: MemoryFileInfo[]): string[] {
  const tagSet = new Set<string>();
  for (const f of files) {
    for (const t of f.tags) tagSet.add(t.toLowerCase());
  }
  return [...tagSet].sort();
}

function sortFiles(files: MemoryFileInfo[], field: SortField): MemoryFileInfo[] {
  return [...files].sort((a, b) => {
    if (field === "name") return a.name.localeCompare(b.name);
    if (field === "date") return (b.createdAt || b.modifiedAt || "").localeCompare(a.createdAt || a.modifiedAt || "");
    return b.sizeKb - a.sizeKb;
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MemoryTab() {
  const { state } = useAppState();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sortField, setSortField] = useState<SortField>("date");

  const allTags = useMemo(() => collectAllTags(state.memoryFiles), [state.memoryFiles]);

  const filtered = useMemo(() => {
    let files = state.memoryFiles.filter((f) => !f.isDir);
    if (activeCategory !== "all") {
      files = files.filter((f) => f.category === activeCategory);
    }
    if (activeTags.length > 0) {
      files = files.filter((f) =>
        activeTags.every((tag) => f.tags.some((t) => t.toLowerCase() === tag)),
      );
    }
    if (searchQuery.trim()) {
      files = files.filter((f) => matchesSearch(f, searchQuery));
    }
    return sortFiles(files, sortField);
  }, [state.memoryFiles, activeCategory, activeTags, searchQuery, sortField]);

  const dirs = useMemo(
    () => state.memoryFiles.filter((f) => f.isDir),
    [state.memoryFiles],
  );

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const openMemFile = (relativePath: string) => {
    const base = state.memoryPath.replace(/\\/g, "\\\\");
    const rel = relativePath.replace(/\//g, "\\\\");
    postMessage({ type: "openFile", filePath: `${base}\\\\${rel}` });
  };

  const clearFilters = () => {
    setSearchQuery("");
    setActiveCategory("all");
    setActiveTags([]);
  };

  const hasFilters = searchQuery || activeCategory !== "all" || activeTags.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* ─── Action Bar ─── */}
      <div className="flex gap-2 items-center">
        <button
          onClick={() => postMessage({ type: "getMemoryFiles" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer"
        >
          🔄 Refresh
        </button>
        <button
          onClick={() => postMessage({ type: "runCommand", commandId: "projectBrain.openMemory" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer"
        >
          📂 Explorer
        </button>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="px-3 py-1.5 text-xs rounded bg-red-800/30 text-red-300 hover:bg-red-800/50 cursor-pointer"
          >
            ✕ Limpiar filtros
          </button>
        )}
        <span className="ml-auto text-xs opacity-50">
          {filtered.length}/{state.memoryFiles.filter((f) => !f.isDir).length} archivos
        </span>
      </div>

      {/* ─── Search Input ─── */}
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar por nombre, contenido o tags..."
          className="w-full px-3 py-2 text-xs rounded bg-vsc-input-bg text-vsc-input-fg border border-vsc-input-border focus:outline-none focus:border-vsc-focus-border"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs opacity-50 hover:opacity-100 cursor-pointer"
          >
            ✕
          </button>
        )}
      </div>

      {/* ─── Category Pills ─── */}
      <div className="flex flex-wrap gap-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`px-2 py-1 text-[10px] rounded-full cursor-pointer transition-colors ${
              activeCategory === cat.id
                ? "bg-vsc-btn-bg text-vsc-btn-fg"
                : "bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80"
            }`}
          >
            {cat.icon} {cat.label}
          </button>
        ))}
      </div>

      {/* ─── Tag Chips ─── */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {allTags.slice(0, 20).map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`px-2 py-0.5 text-[10px] rounded cursor-pointer transition-colors ${
                activeTags.includes(tag)
                  ? "bg-blue-600/40 text-blue-200 border border-blue-500/50"
                  : "bg-vsc-btn-sec-bg/50 text-vsc-btn-sec-fg/70 hover:opacity-80"
              }`}
            >
              #{tag}
            </button>
          ))}
          {allTags.length > 20 && (
            <span className="text-[10px] opacity-40 self-center">+{allTags.length - 20} más</span>
          )}
        </div>
      )}

      {/* ─── Sort Controls ─── */}
      <div className="flex gap-2 items-center text-[10px] opacity-60">
        <span>Ordenar:</span>
        {(["name", "date", "size"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setSortField(f)}
            className={`cursor-pointer hover:opacity-100 ${sortField === f ? "opacity-100 underline" : ""}`}
          >
            {f === "name" ? "Nombre" : f === "date" ? "Fecha" : "Tamaño"}
          </button>
        ))}
      </div>

      {/* ─── File List ─── */}
      {state.memoryFiles.length === 0 ? (
        <div className="text-center py-10 opacity-50">
          <div className="text-3xl mb-2">📁</div>
          <p className="text-xs">Click "Refresh" para cargar archivos de memoria</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-6 opacity-50">
          <div className="text-2xl mb-2">🔍</div>
          <p className="text-xs">Sin resultados para los filtros seleccionados</p>
        </div>
      ) : (
        <div className="max-h-[55vh] overflow-y-auto">
          {/* Directories (only when no filters active) */}
          {!hasFilters &&
            dirs.map((d) => (
              <div
                key={d.relativePath}
                className="flex items-center gap-2 px-3 py-1.5 text-xs opacity-70"
              >
                <span>📁</span>
                <span className="font-medium">{d.name}/</span>
                <span className="opacity-40 text-[10px]">
                  {state.memoryFiles.filter(
                    (f) => !f.isDir && f.relativePath.startsWith(d.relativePath + "/"),
                  ).length}{" "}
                  archivos
                </span>
              </div>
            ))}

          {/* Files */}
          <ul className="space-y-0.5">
            {filtered.map((f) => (
              <li
                key={f.relativePath}
                onClick={() => openMemFile(f.relativePath)}
                className="flex flex-col gap-0.5 px-3 py-2 text-xs rounded cursor-pointer hover:bg-vsc-hover transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px]">
                    {CATEGORIES.find((c) => c.id === f.category)?.icon || "📄"}
                  </span>
                  <span className="flex-1 font-medium truncate">{f.name}</span>
                  <span className="opacity-40 text-[10px]">{f.sizeKb}KB</span>
                  <span className="opacity-40 text-[10px]">
                    {f.modifiedAt ? new Date(f.modifiedAt).toLocaleDateString() : ""}
                  </span>
                </div>
                {f.excerpt && (
                  <p className="text-[10px] opacity-40 truncate pl-5 group-hover:opacity-60">
                    {f.excerpt}
                  </p>
                )}
                {f.tags.length > 0 && (
                  <div className="flex gap-1 pl-5 flex-wrap">
                    {f.tags.slice(0, 5).map((t) => (
                      <span
                        key={t}
                        className="px-1.5 py-0 text-[9px] rounded bg-vsc-btn-sec-bg/30 opacity-50"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
