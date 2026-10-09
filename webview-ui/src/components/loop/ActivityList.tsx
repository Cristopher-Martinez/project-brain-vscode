/**
 * ActivityList — Compact timeline fallback for the Neural Pulse visualization.
 * Shows grouped activity entries with category colors and timestamps.
 */

import { useMemo } from "react";
import type { ActivityEntry, ActivityCategory } from "../../types/messages";

// ─── Category display config ─────────────────────────────────────
const CAT_META: Record<ActivityCategory, { color: string; emoji: string; label: string }> = {
  edit: { color: "#f97316", emoji: "✏️", label: "Edit" },
  search: { color: "#3b82f6", emoji: "🔍", label: "Search" },
  read: { color: "#8b5cf6", emoji: "📖", label: "Read" },
  terminal: { color: "#22c55e", emoji: "💻", label: "Terminal" },
  brain: { color: "#ec4899", emoji: "🧠", label: "Brain" },
  agent: { color: "#06b6d4", emoji: "🤖", label: "Agent" },
};

function timeAgo(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5) return "ahora";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

/** Group consecutive entries of the same category. */
interface GroupedEntry {
  category: ActivityCategory;
  entries: ActivityEntry[];
  latestTs: number;
}

function groupConsecutive(entries: ActivityEntry[]): GroupedEntry[] {
  const groups: GroupedEntry[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.category === entry.category) {
      last.entries.push(entry);
      last.latestTs = Math.max(last.latestTs, entry.timestamp);
    } else {
      groups.push({
        category: entry.category,
        entries: [entry],
        latestTs: entry.timestamp,
      });
    }
  }
  return groups;
}

// ─── Single grouped row ─────────────────────────────────────────
function ActivityRow({ group }: { group: GroupedEntry }) {
  const meta = CAT_META[group.category];
  const count = group.entries.length;
  const latest = group.entries[group.entries.length - 1];

  return (
    <div className="flex items-start gap-2 py-1 px-2 hover:bg-zinc-800/50 rounded text-xs">
      {/* Category dot */}
      <span
        className="mt-1 inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: meta.color }}
      />
      {/* Content */}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-zinc-200">
          {meta.emoji} {latest?.summary ?? meta.label}
          {count > 1 && (
            <span className="ml-1 text-zinc-500">×{count}</span>
          )}
        </span>
        {latest?.tool && (
          <span className="ml-1.5 text-zinc-500 truncate">
            {latest.tool}
          </span>
        )}
      </div>
      {/* Timestamp */}
      <span className="text-zinc-600 shrink-0">{timeAgo(group.latestTs)}</span>
    </div>
  );
}

// ─── Stats bar ──────────────────────────────────────────────────
function StatsBar({ entries }: { entries: ActivityEntry[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, [entries]);

  const total = entries.length;
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-700/50 text-[10px] text-zinc-500">
      <span>{total} actividades</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden flex">
        {Object.entries(counts).map(([cat, count]) => (
          <div
            key={cat}
            style={{
              width: `${(count / total) * 100}%`,
              backgroundColor: CAT_META[cat as ActivityCategory]?.color ?? "#555",
            }}
            className="h-full"
          />
        ))}
      </div>
    </div>
  );
}

// ─── Public component ───────────────────────────────────────────
export interface ActivityListProps {
  entries: ActivityEntry[];
  maxVisible?: number;
}

export function ActivityList({ entries, maxVisible = 30 }: ActivityListProps) {
  const reversed = useMemo(() => [...entries].reverse(), [entries]);
  const groups = useMemo(() => groupConsecutive(reversed).slice(0, maxVisible), [reversed, maxVisible]);

  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/60 overflow-hidden">
      <StatsBar entries={entries} />
      <div className="max-h-48 overflow-y-auto divide-y divide-zinc-800/30">
        {groups.map((g, i) => (
          <ActivityRow key={`${g.category}-${g.latestTs}-${i}`} group={g} />
        ))}
      </div>
    </div>
  );
}
