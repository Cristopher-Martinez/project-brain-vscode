import { useMemo, useState } from "react";
import type {
  ActivityEntry,
  LoopMailboxMessage,
  LoopUiState,
} from "../../types/messages";
import { postMessage } from "../../vscode";
import { LoopMonitor } from "./LoopMonitor";

interface LoopActiveTableProps {
  sessions: Record<string, LoopUiState>;
  activeId: string | null;
  onSelect: (sid: string) => void;
  onEnd: (sid: string) => void;
  onDismiss: (sid: string) => void;
  globalMaxCycles?: number;
  mailboxBySession: Record<
    string,
    { messages: LoopMailboxMessage[]; unreadCount: number }
  >;
  activityBySession: Record<string, ActivityEntry[]>;
}

const STATE_BADGE: Record<string, { label: string; color: string }> = {
  spawning: { label: "Spawning", color: "bg-blue-500" },
  active: { label: "Working", color: "bg-sky-600" },
  awaiting: { label: "Espera usr", color: "bg-amber-500 animate-pulse" },
  completed: { label: "Done", color: "bg-emerald-600" },
  idle: { label: "Idle", color: "bg-zinc-500" },
  disconnected: { label: "Desconectado", color: "bg-red-700" },
};

/** Derive badge from awaitingFeedback (same source of truth as FeedbackPanel) */
function resolveBadge(s: LoopUiState): { label: string; color: string } {
  if (s.protocolMonitor?.status === "degraded") {
    return { label: "Protocolo", color: "bg-rose-700 animate-pulse" };
  }
  if (s.protocolMonitor?.status === "warning") {
    return { label: "Monitoreo", color: "bg-orange-600" };
  }
  if (s.state === "disconnected") {
    return { label: "Desconectado", color: "bg-red-700" };
  }
  if (s.awaitingFeedback) {
    return { label: "Espera usr", color: "bg-amber-500 animate-pulse" };
  }
  if (s.state === "awaiting" || s.state === "active") {
    return { label: "Working", color: "bg-sky-600" };
  }
  return STATE_BADGE[s.state] ?? STATE_BADGE.idle;
}

function relativeTime(ts?: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

export function LoopActiveTable({
  sessions,
  activeId,
  onSelect,
  onEnd,
  onDismiss,
  globalMaxCycles,
  mailboxBySession,
  activityBySession,
}: LoopActiveTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sortedSessions = useMemo(() => {
    return Object.values(sessions)
      .filter((s) =>
        [
          "spawning",
          "active",
          "awaiting",
          "completed",
          "disconnected",
        ].includes(s.state),
      )
      .sort((a, b) => {
        // Awaiting feedback first, then active, then disconnected, then others
        const priority: Record<string, number> = {
          awaiting: 0,
          active: 1,
          spawning: 2,
          completed: 3,
          disconnected: 4,
        };
        const pa = priority[a.state] ?? 9;
        const pb = priority[b.state] ?? 9;
        if (pa !== pb) return pa - pb;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });
  }, [sessions]);

  const toggleExpand = (sid: string) => {
    setExpandedId(expandedId === sid ? null : sid);
    onSelect(sid);
  };

  if (sortedSessions.length === 0) {
    return (
      <div className="text-center py-10 opacity-50">
        <div className="text-3xl mb-2">🔁</div>
        <p className="text-xs">No hay loops activos</p>
        <p className="text-[11px] mt-1 opacity-60">
          Lanza uno arriba para empezar
        </p>
      </div>
    );
  }

  return (
    <div className="border border-vsc-border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-vsc-header border-b border-vsc-border">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold w-8" />
            <th className="px-2 py-1.5 text-left font-semibold">Objetivo</th>
            <th className="px-2 py-1.5 text-center font-semibold w-24">
              Estado
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-16">
              Rondas
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-16">
              Tiempo
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-40">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedSessions.map((s) => {
            const sid = s.sessionId!;
            const isExpanded = expandedId === sid;
            const isAwaiting = s.awaitingFeedback;
            const badge = resolveBadge(s);
            const iterCount = s.iterations?.length ?? 0;
            const goalText = s._displayName || (s.goal || sid).substring(0, 50);

            return (
              <LoopActiveRow
                key={sid}
                sid={sid}
                goalText={goalText}
                badge={badge}
                iterCount={iterCount}
                startedAt={s.startedAt}
                isExpanded={isExpanded}
                isAwaiting={isAwaiting}
                isSelected={activeId === sid}
                session={s}
                globalMaxCycles={globalMaxCycles}
                mailbox={mailboxBySession[sid]}
                activityEntries={activityBySession[sid] ?? []}
                onToggle={() => toggleExpand(sid)}
                onEnd={() => onEnd(sid)}
                onDismiss={() => onDismiss(sid)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Single row ──────────────────────────────────────────────

interface RowProps {
  sid: string;
  goalText: string;
  badge: { label: string; color: string };
  iterCount: number;
  startedAt?: number;
  isExpanded: boolean;
  isAwaiting: boolean;
  isSelected: boolean;
  session: LoopUiState;
  globalMaxCycles?: number;
  mailbox?: { messages: LoopMailboxMessage[]; unreadCount: number };
  activityEntries: ActivityEntry[];
  onToggle: () => void;
  onEnd: () => void;
  onDismiss: () => void;
}

function LoopActiveRow({
  sid,
  goalText,
  badge,
  iterCount,
  startedAt,
  isExpanded,
  isAwaiting,
  isSelected,
  session,
  globalMaxCycles,
  mailbox,
  activityEntries,
  onToggle,
  onEnd,
  onDismiss,
}: RowProps) {
  return (
    <>
      {/* Main row */}
      <tr
        className={`border-b border-vsc-border/30 transition-colors cursor-pointer ${
          isAwaiting
            ? "bg-amber-900/10 hover:bg-amber-900/20"
            : isSelected
              ? "bg-vsc-header/50 hover:bg-vsc-header/70"
              : "hover:bg-vsc-header/30"
        }`}
        onClick={onToggle}>
        <td className="px-2 py-2 text-center">
          <span className="text-[10px]">{isExpanded ? "▼" : "▶"}</span>
        </td>
        <td className="px-2 py-2">
          <span className="font-medium">{goalText}</span>
          {isAwaiting && (
            <span className="ml-2 text-[10px] text-amber-400 animate-pulse">
              ● espera feedback
            </span>
          )}
          {session.protocolMonitor?.status !== "healthy" &&
            session.protocolMonitor?.lastViolation && (
              <span className="ml-2 text-[10px] text-rose-300">
                ● {session.protocolMonitor.lastViolation.code}
              </span>
            )}
        </td>
        <td className="px-2 py-2 text-center">
          <span
            className={`inline-block px-2 py-0.5 text-[10px] rounded-full text-white ${badge.color}`}>
            {badge.label}
          </span>
        </td>
        <td className="px-2 py-2 text-center font-mono opacity-70">
          {iterCount}
        </td>
        <td className="px-2 py-2 text-center opacity-60">
          {relativeTime(startedAt)}
        </td>
        <td className="px-2 py-2 text-center">
          <div
            className="flex gap-1 justify-center items-center flex-wrap"
            onClick={(e) => e.stopPropagation()}>
            {(session.state === "active" || session.state === "awaiting") && (
              <>
                <button
                  onClick={() =>
                    postMessage({
                      type: "runCommand",
                      commandId: "projectBrain.loopPauseToggle",
                      args: [sid],
                    })
                  }
                  className={`px-1.5 py-0.5 text-[10px] rounded border cursor-pointer transition-colors ${
                    session.controlState === "paused"
                      ? "border-green-500/50 text-green-300 hover:bg-green-700/30"
                      : "border-yellow-500/40 text-yellow-300 hover:bg-yellow-700/30"
                  }`}
                  title={
                    session.controlState === "paused" ? "Resume" : "Pause"
                  }>
                  {session.controlState === "paused" ? "▶" : "⏸"}
                </button>
                <button
                  onClick={onEnd}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 cursor-pointer transition-colors"
                  title="End Loop">
                  🛑
                </button>
                <button
                  onClick={() =>
                    postMessage({
                      type: "runCommand",
                      commandId: "projectBrain.loopHibernate",
                      args: [sid],
                    })
                  }
                  className="px-1.5 py-0.5 text-[10px] rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors"
                  title="Hibernate">
                  💤
                </button>
                <button
                  onClick={() =>
                    postMessage({
                      type: "runCommand",
                      commandId: "projectBrain.loopSendMessage",
                      args: [sid],
                    })
                  }
                  className="relative px-1.5 py-0.5 text-[10px] rounded border border-orange-500/40 text-orange-300 hover:bg-orange-700/30 cursor-pointer transition-colors"
                  title="Urgente">
                  🚨
                  {!!mailbox?.unreadCount && mailbox.unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 px-0.5 min-w-3 h-3 text-[7px] font-bold rounded-full bg-orange-500 text-white flex items-center justify-center animate-pulse">
                      {mailbox.unreadCount > 9 ? "9+" : mailbox.unreadCount}
                    </span>
                  )}
                </button>
                {session.commitBypass && (
                  <span
                    className="px-1 py-0.5 text-[8px] font-semibold rounded-full bg-yellow-600/30 border border-yellow-500/40 text-yellow-300 animate-pulse"
                    title="Commit gate bypass activo">
                    ⚡
                  </span>
                )}
              </>
            )}
            {session.state === "completed" && (
              <button
                onClick={onDismiss}
                className="px-1.5 py-0.5 text-[10px] rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors"
                title="Descartar">
                ✕
              </button>
            )}
            {session.state === "disconnected" && (
              <>
                <button
                  onClick={() =>
                    postMessage({
                      type: "resumeDisconnectedLoop",
                      sessionId: sid,
                    })
                  }
                  className="px-1.5 py-0.5 text-[10px] rounded border border-green-500/50 text-green-300 hover:bg-green-700/30 cursor-pointer transition-colors"
                  title="Reconectar loop desconectado">
                  ↺ Reconectar
                </button>
                <button
                  onClick={onDismiss}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors"
                  title="Descartar">
                  ✕
                </button>
              </>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded detail — full Live Monitor */}
      {isExpanded && (
        <tr>
          <td colSpan={6} className="p-0">
            <div className="border-t border-vsc-border/50 bg-vsc-header/20 px-4 py-3">
              <LoopMonitor
                session={session}
                mailbox={mailbox}
                activityEntries={activityEntries}
                globalMaxCycles={globalMaxCycles}
                onEndClick={onEnd}
                onDismiss={onDismiss}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
