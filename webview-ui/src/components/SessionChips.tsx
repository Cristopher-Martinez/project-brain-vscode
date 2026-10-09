import { useCallback, useEffect, useRef, useState } from "react";

// ─── Color Palette ──────────────────────────────────────────────────────────

const CHIP_COLORS = [
  { name: "Default", value: "" },
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#eab308" },
  { name: "Green", value: "#22c55e" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionState {
  state: string;
  goal?: string;
  awaitingFeedback?: boolean;
  pendingSynthesis?: string;
  iterations?: { synthesis?: string }[];
  _displayName?: string;
  color?: string;
  tags?: string[];
  startedAt?: number;
}

interface SessionChipsProps {
  sessions: Record<string, SessionState>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  onColorChange?: (id: string, color: string) => void;
  onTagsChange?: (id: string, tags: string[]) => void;
  activeStates: string[];
  badges?: Record<string, number>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDotColor(state: string, activeStates: string[]): string {
  if (state === "completed") return "bg-green-500";
  if (state === "awaiting") return "bg-yellow-500 animate-pulse";
  if (activeStates.includes(state)) return "bg-red-500 animate-pulse";
  return "bg-gray-500";
}

function hasSynthesisReady(s: SessionState): boolean {
  return !!s.pendingSynthesis;
}

// ─── Context Menu ───────────────────────────────────────────────────────────

interface CtxMenuState {
  sid: string;
  x: number;
  y: number;
  showColors: boolean;
  showTags: boolean;
}

function ContextMenu({
  menu,
  sessions,
  onClose,
  onRename,
  onColorChange,
  onTagsChange,
}: {
  menu: CtxMenuState;
  sessions: Record<string, SessionState>;
  onClose: () => void;
  onRename: (id: string) => void;
  onColorChange?: (id: string, color: string) => void;
  onTagsChange?: (id: string, tags: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const s = sessions[menu.sid];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-vsc-header border border-vsc-border rounded shadow-lg py-1 min-w-[160px] text-[11px]"
      style={{ left: menu.x, top: menu.y }}>
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-vsc-hover"
        onClick={() => {
          onRename(menu.sid);
          onClose();
        }}>
        ✏️ Rename
      </button>

      {onColorChange && (
        <div className="px-3 py-1.5 hover:bg-vsc-hover">
          <span>🎨 Color</span>
          <div className="flex gap-1 mt-1">
            {CHIP_COLORS.map((c) => (
              <button
                key={c.name}
                title={c.name}
                className={`w-4 h-4 rounded-full border ${
                  (s?.color || "") === c.value
                    ? "border-white ring-1 ring-white"
                    : "border-vsc-border"
                }`}
                style={{
                  background: c.value || "var(--vscode-badge-background)",
                }}
                onClick={() => {
                  onColorChange(menu.sid, c.value);
                  onClose();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {onTagsChange && (
        <div className="px-3 py-1.5 hover:bg-vsc-hover">
          <span>🏷️ Tags</span>
          <div className="mt-1 flex gap-1 items-center">
            <input
              ref={tagInputRef}
              type="text"
              placeholder="tag1, tag2"
              defaultValue={(s?.tags || []).join(", ")}
              className="flex-1 bg-vsc-input border border-vsc-border rounded px-1.5 py-0.5 text-[10px] text-vsc-fg"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value;
                  const tags = val
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                  onTagsChange(menu.sid, tags);
                  onClose();
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline Rename Input ────────────────────────────────────────────────────

function InlineRename({
  currentName,
  onConfirm,
  onCancel,
}: {
  currentName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={currentName}
      maxLength={40}
      className="bg-vsc-input border border-vsc-accent rounded px-1 py-0 text-[11px] text-vsc-fg w-[120px]"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onConfirm((e.target as HTMLInputElement).value.trim());
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      onBlur={(e) => onConfirm(e.target.value.trim())}
    />
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function SessionChips({
  sessions,
  activeId,
  onSelect,
  onRemove,
  onRename,
  onColorChange,
  onTagsChange,
  activeStates,
  badges,
}: SessionChipsProps) {
  const ids = Object.keys(sessions).sort((a, b) => {
    const ta = sessions[a]?.startedAt ?? 0;
    const tb = sessions[b]?.startedAt ?? 0;
    return tb - ta; // desc: newest first
  });
  const [renamingSid, setRenamingSid] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const closeMenu = useCallback(() => setCtxMenu(null), []);

  const handleContextMenu = useCallback((e: React.MouseEvent, sid: string) => {
    e.preventDefault();
    setCtxMenu({
      sid,
      x: e.clientX,
      y: e.clientY,
      showColors: false,
      showTags: false,
    });
  }, []);

  const startRename = useCallback((sid: string) => {
    setRenamingSid(sid);
  }, []);

  const confirmRename = useCallback(
    (sid: string, name: string) => {
      if (name && onRename) onRename(sid, name);
      setRenamingSid(null);
    },
    [onRename],
  );

  if (ids.length === 0) {
    return <span className="text-[11px] opacity-40">No sessions yet</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((sid) => {
        const s = sessions[sid];
        const isActive = sid === activeId;
        const label = s._displayName || (s.goal || sid).substring(0, 30);
        const badgeCount = badges?.[sid] ?? 0;
        const isAwaiting = s.awaitingFeedback || s.state === "awaiting";
        const synthReady = hasSynthesisReady(s);
        const chipColor = s.color || "";

        return (
          <div
            key={sid}
            onClick={() => onSelect(sid)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename(sid);
            }}
            onContextMenu={(e) => handleContextMenu(e, sid)}
            title={s.goal || sid}
            className={`
              relative flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full cursor-pointer transition-colors
              ${
                isActive
                  ? "bg-vsc-accent/20 border border-vsc-accent"
                  : "bg-vsc-header border border-vsc-border hover:bg-vsc-hover"
              }
              ${synthReady ? "has-synthesis" : ""}
            `}
            style={
              chipColor
                ? { borderLeftColor: chipColor, borderLeftWidth: 3 }
                : undefined
            }>
            <span
              className={`w-2 h-2 rounded-full ${getDotColor(s.state, activeStates)}`}
            />

            {renamingSid === sid ? (
              <InlineRename
                currentName={label}
                onConfirm={(name) => confirmRename(sid, name)}
                onCancel={() => setRenamingSid(null)}
              />
            ) : (
              <span className="chip-label">{label}</span>
            )}

            {/* Tag micro-badges */}
            {s.tags && s.tags.length > 0 && (
              <span className="flex gap-0.5">
                {s.tags.slice(0, 2).map((t) => (
                  <span
                    key={t}
                    className="px-1 py-0 text-[8px] bg-vsc-badge rounded opacity-60">
                    {t}
                  </span>
                ))}
                {s.tags.length > 2 && (
                  <span className="text-[8px] opacity-40">
                    +{s.tags.length - 2}
                  </span>
                )}
              </span>
            )}

            {isAwaiting && !isActive && (
              <span
                className="text-yellow-400 text-[10px]"
                title="Awaiting feedback">
                💬
              </span>
            )}
            {badgeCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[9px] font-bold bg-orange-500 text-white rounded-full">
                {badgeCount}
              </span>
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onRemove(sid);
              }}
              className="ml-1 opacity-40 hover:opacity-100 cursor-pointer"
              title="Remove session">
              ✕
            </span>
          </div>
        );
      })}

      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          sessions={sessions}
          onClose={closeMenu}
          onRename={startRename}
          onColorChange={onColorChange}
          onTagsChange={onTagsChange}
        />
      )}
    </div>
  );
}
