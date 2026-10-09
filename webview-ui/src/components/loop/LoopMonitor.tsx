import { useEffect, useMemo, useState } from "react";
import type {
  ActivityEntry,
  LoopMailboxMessage,
  LoopUiState,
} from "../../types/messages";
import { postMessage } from "../../vscode";
import {
  ActivityList,
  FeedbackPanel,
  IterationTable,
  MailboxInbox,
  NeuralPulse,
  ProcessingIndicator,
} from "./index";

const ITER_PER_PAGE = 5;

interface LoopMonitorProps {
  session: LoopUiState;
  mailbox?: { messages: LoopMailboxMessage[]; unreadCount: number };
  activityEntries: ActivityEntry[];
  globalMaxCycles?: number;
  onEndClick: () => void;
  onDismiss: () => void;
}

export function LoopMonitor({
  session,
  mailbox,
  activityEntries,
  globalMaxCycles,
  onEndClick,
  onDismiss,
}: LoopMonitorProps) {
  const [activityView, setActivityView] = useState<"3d" | "list">("3d");
  const [iterPage, setIterPage] = useState(0);

  const reversedIterations = useMemo(
    () => (session.iterations ? [...session.iterations].reverse() : []),
    [session.iterations],
  );

  const totalIterPages = Math.ceil(reversedIterations.length / ITER_PER_PAGE);
  const pagedIterations = useMemo(
    () =>
      reversedIterations.slice(
        iterPage * ITER_PER_PAGE,
        (iterPage + 1) * ITER_PER_PAGE,
      ),
    [reversedIterations, iterPage],
  );

  useEffect(() => {
    setIterPage(0);
  }, [reversedIterations.length]);

  const sid = session.sessionId!;

  if (session.state === "spawning") {
    return (
      <div className="text-center py-6">
        <div className="text-2xl mb-2 animate-pulse">🔄</div>
        <p className="text-xs font-semibold">Iniciando loop…</p>
        <p className="text-[11px] mt-1 opacity-60">
          Abriendo chat en modo Brain y conectando al agente
        </p>
        {session.goal && (
          <p className="text-[11px] mt-1 opacity-50" title={session.goal}>
            Objetivo:{" "}
            {(session.goal || "").length > 250
              ? session.goal!.substring(0, 250) + "…"
              : session.goal}
          </p>
        )}
        {session.controlState === "paused" && (
          <div className="mt-3 p-2 bg-yellow-900/20 border border-yellow-500/30 rounded-lg">
            <p className="text-xs text-yellow-300 mb-1.5">
              ⚠️ El agente no se ha conectado aún
            </p>
            <button
              onClick={() =>
                postMessage({
                  type: "createLoopSession",
                  goal: session.goal || "",
                })
              }
              className="px-3 py-1 text-xs rounded-md bg-vsc-btn-bg text-vsc-btn-fg cursor-pointer hover:opacity-90">
              🔄 Reintentar
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Loop Header */}
      <div className="p-3 bg-vsc-header border border-vsc-border rounded-lg">
        <div className="font-semibold text-sm">
          🔁 Loop:{" "}
          {(session.goal || "—").length > 250
            ? session.goal!.substring(0, 250) + "…"
            : session.goal || "—"}
        </div>
        <div className="text-[11px] opacity-60 mt-1">
          Estado: {session.state} | Iteraciones:{" "}
          {(session.iterations || []).length}
        </div>
        {session.branchIsolation && (
          <div className="text-[11px] mt-1 text-vsc-accent">
            🌿 Branch: {session.branchIsolation.branchName}
            <span className="ml-2 opacity-60">
              ({session.branchIsolation.status})
            </span>
          </div>
        )}
        {session.protocolMonitor?.status !== "healthy" &&
          session.protocolMonitor?.lastViolation && (
            <div
              className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${
                session.protocolMonitor.status === "degraded"
                  ? "border-rose-500/40 bg-rose-900/20 text-rose-200"
                  : "border-orange-500/40 bg-orange-900/20 text-orange-200"
              }`}>
              <div className="font-semibold uppercase tracking-wide">
                Monitor de protocolo · {session.protocolMonitor.lastViolation.code}
              </div>
              <div className="mt-1 opacity-90">
                {session.protocolMonitor.lastViolation.message}
              </div>
              <div className="mt-1 opacity-70">
                Violaciones: {session.protocolMonitor.totalViolations} · Racha: {session.protocolMonitor.consecutiveViolations}
              </div>
              {session.protocolMonitor.repair && (
                <div className="mt-1 opacity-70">
                  Reparación: {session.protocolMonitor.repair.attempts}/{session.protocolMonitor.repair.maxAttempts}
                  {session.protocolMonitor.repair.checkpoint
                    ? ` · Checkpoint: ${session.protocolMonitor.repair.checkpoint}`
                    : ""}
                </div>
              )}
              {session.protocolMonitor.status === "degraded" && (
                <div className="mt-1 opacity-70">
                  Modo rescate: el loop se conserva vivo. Reabre el chat, manda un aviso urgente o márcalo como desconectado para recuperarlo sin cerrarlo.
                </div>
              )}
              {session.protocolMonitor.status === "degraded" &&
                session.state !== "completed" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {session.state === "disconnected" ? (
                      <button
                        onClick={() =>
                          postMessage({
                            type: "resumeDisconnectedLoop",
                            sessionId: sid,
                          })
                        }
                        className="px-3 py-1 rounded-md bg-rose-700/30 border border-rose-500/40 hover:bg-rose-700/50 cursor-pointer transition-colors">
                        ↺ Reabrir desde checkpoint
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() =>
                            postMessage({
                              type: "runCommand",
                              commandId: "projectBrain.launchLoopSession",
                              args: [sid, session.goal || "Interactive feedback loop session"],
                            })
                          }
                          className="px-3 py-1 rounded-md bg-rose-700/30 border border-rose-500/40 hover:bg-rose-700/50 cursor-pointer transition-colors">
                          💬 Reabrir chat del loop
                        </button>
                        <button
                          onClick={() =>
                            postMessage({
                              type: "runCommand",
                              commandId: "projectBrain.loopSendMessage",
                              args: [sid],
                            })
                          }
                          className="px-3 py-1 rounded-md border border-orange-400/40 hover:bg-orange-900/30 cursor-pointer transition-colors">
                          🚨 Enviar mensaje urgente
                        </button>
                        <button
                          onClick={() =>
                            postMessage({
                              type: "markLoopDisconnected",
                              sessionId: sid,
                            })
                          }
                          className="px-3 py-1 rounded-md border border-rose-300/40 hover:bg-rose-950/30 cursor-pointer transition-colors">
                          🧷 Marcar como desconectado
                        </button>
                      </>
                    )}
                  </div>
                )}
            </div>
          )}
      </div>

      {/* Loop controls migrated to table Acciones column */}

      {/* Mailbox Inbox */}
      <MailboxInbox
        sessionId={sid}
        messages={mailbox?.messages ?? []}
        unreadCount={mailbox?.unreadCount ?? 0}
      />

      {/* Neural Pulse — real-time activity */}
      {activityEntries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
              ⚡ Actividad en tiempo real
            </span>
            <button
              className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              onClick={() =>
                setActivityView(activityView === "3d" ? "list" : "3d")
              }
              title={activityView === "3d" ? "Vista lista" : "Vista 3D"}>
              {activityView === "3d" ? "📋 Lista" : "🌐 3D"}
            </button>
          </div>
          {activityView === "3d" ? (
            <NeuralPulse entries={activityEntries} />
          ) : (
            <ActivityList entries={activityEntries} />
          )}
        </div>
      )}

      {/* Processing indicator */}
      {session.state === "active" && !session.awaitingFeedback && (
        <ProcessingIndicator iterationCount={session.iterations?.length ?? 0} />
      )}

      {/* Iteration history table (paginated) */}
      {reversedIterations.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-2 opacity-70">
            Historial ({reversedIterations.length} iteraciones)
          </div>
          <IterationTable iterations={pagedIterations} />
          {totalIterPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-2 text-[11px]">
              <button
                disabled={iterPage <= 0}
                onClick={() => setIterPage((p) => p - 1)}
                className="px-2 py-0.5 rounded border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer disabled:opacity-30 disabled:cursor-default">
                ← Anterior
              </button>
              <span className="opacity-60">
                {iterPage + 1} / {totalIterPages}
              </span>
              <button
                disabled={iterPage >= totalIterPages - 1}
                onClick={() => setIterPage((p) => p + 1)}
                className="px-2 py-0.5 rounded border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer disabled:opacity-30 disabled:cursor-default">
                Siguiente →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Feedback Panel — the FULL one with images, bypass, etc. */}
      <FeedbackPanel session={session} globalMaxCycles={globalMaxCycles} />

      {/* Disconnected state with reconnect */}
      {session.state === "disconnected" && (
        <div className="p-4 bg-red-900/10 border border-red-500/30 rounded-lg text-xs">
          <div className="font-semibold mb-2 text-red-400">
            ⚠️ Loop desconectado
          </div>
          <p className="text-[11px] opacity-70 mb-3">
            El agente perdió conexión con este loop. El feedback no puede ser
            entregado. Usa Reconectar para continuar desde donde quedó.
          </p>
          <button
            onClick={() =>
              postMessage({
                type: "resumeDisconnectedLoop",
                sessionId: sid,
              })
            }
            className="px-3 py-1 rounded-md bg-red-700/20 border border-red-500/40 hover:bg-red-700/30 cursor-pointer transition-colors">
            ↺ Reconectar
          </button>
        </div>
      )}

      {/* Completed state with actions */}
      {session.state === "completed" && (
        <div className="p-4 bg-green-900/10 border border-green-500/30 rounded-lg text-xs">
          <div className="font-semibold mb-2">✅ Loop completado</div>
          <div className="flex flex-wrap gap-2">
            {session.branchIsolation && (
              <button
                onClick={() =>
                  postMessage({
                    type: "requestBranchChanges",
                    sessionId: sid,
                    instructions: "",
                  })
                }
                className="px-3 py-1 rounded-md bg-green-700/20 border border-green-500/40 hover:bg-green-700/30 cursor-pointer transition-colors">
                🔀 Review Branch
              </button>
            )}
            <button
              onClick={() => onDismiss()}
              className="px-3 py-1 rounded-md border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors">
              🗑 Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
