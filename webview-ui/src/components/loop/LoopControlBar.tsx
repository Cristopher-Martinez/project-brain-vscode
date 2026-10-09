import { postMessage } from "../../vscode";

function runCommand(commandId: string, args?: unknown[]) {
  postMessage({ type: "runCommand", commandId, args });
}

export function LoopControlBar({
  sessionId,
  state,
  controlState,
  commitBypass,
  unreadCount,
  onEndClick,
}: {
  sessionId: string;
  state: string;
  controlState?: "running" | "paused";
  commitBypass?: boolean;
  unreadCount?: number;
  onEndClick: () => void;
}) {
  const isRunning = state === "active" || state === "awaiting";
  if (!isRunning) return null;

  const isPaused = controlState === "paused";

  return (
    <div className="flex flex-wrap items-center gap-2 p-2.5 bg-vsc-header/50 border border-vsc-border rounded-md mb-3">
      {/* Pause/Resume with distinct visual states */}
      <button
        onClick={() => runCommand("projectBrain.loopPauseToggle", [sessionId])}
        aria-label={isPaused ? "Resume loop" : "Pause loop"}
        className={`
          px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer
          transition-all duration-300 ease-in-out
          ${isPaused
            ? "bg-green-700/40 border border-green-500/50 text-green-300 hover:bg-green-700/60 shadow-[0_0_8px_rgba(34,197,94,0.15)]"
            : "bg-yellow-700/30 border border-yellow-500/40 text-yellow-300 hover:bg-yellow-700/50"
          }
        `}>
        {isPaused ? "▶ Resume" : "⏸ Pause"}
      </button>
      <button
        onClick={onEndClick}
        aria-label="End loop"
        className="px-3 py-1 text-xs font-semibold rounded-md bg-vsc-error/80 text-white hover:bg-vsc-error cursor-pointer transition-colors">
        🛑 End Loop
      </button>
      <button
        onClick={() => runCommand("projectBrain.loopHibernate", [sessionId])}
        aria-label="Hibernate loop"
        className="px-3 py-1 text-xs rounded-md border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors">
        💤 Hibernate
      </button>
      {/* Separator */}
      <span className="w-px h-5 bg-vsc-border mx-0.5 self-center" />
      {/* Urgent message */}
      <button
        onClick={() => runCommand("projectBrain.loopSendMessage", [sessionId])}
        aria-label="Send urgent message"
        className="px-3 py-1 text-xs rounded-md bg-orange-700/30 border border-orange-500/40 hover:bg-orange-700/50 cursor-pointer transition-colors">
        <span className="relative">
          🚨 Urgente
          {!!unreadCount && unreadCount > 0 && (
            <span className="absolute -top-2 -right-3 px-1 min-w-[14px] h-[14px] text-[8px] font-bold rounded-full bg-orange-500 text-white flex items-center justify-center animate-pulse">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </span>
      </button>      {/* Commit bypass status badge */}
      {commitBypass && (
        <>
          <span className="w-px h-5 bg-vsc-border mx-0.5 self-center" />
          <span
            className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-yellow-600/30 border border-yellow-500/40 text-yellow-300 animate-pulse"
            title="Commit gate bypass activo — los commits no serán bloqueados"
          >
            ⚡ BYPASS
          </span>
        </>
      )}    </div>
  );
}

export function ProcessingIndicator({ iterationCount }: { iterationCount: number }) {
  return (
    <div className="flex items-center gap-2 p-3 mb-3 bg-vsc-accent/5 border border-vsc-accent/20 rounded-md">
      <span className="w-2 h-2 rounded-full bg-vsc-accent animate-pulse" />
      <span className="text-xs opacity-70">
        Agente procesando iteración {iterationCount + 1}…
      </span>
    </div>
  );
}
