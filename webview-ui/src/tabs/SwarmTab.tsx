import { Markdown } from "../components/Markdown";
import { useAppState } from "../store/AppContext";
import type { SwarmUiWorkerState } from "../types/messages";

function WorkerCard({ worker }: { worker: SwarmUiWorkerState }) {
  const isDone = worker.success !== undefined;
  const statusLabel = isDone
    ? worker.success
      ? "✅ Done"
      : "❌ Failed"
    : "⏳ Working";
  const borderClass = isDone
    ? worker.success
      ? "border-l-vsc-success"
      : "border-l-vsc-error"
    : "border-l-vsc-accent";

  const meta: string[] = [];
  if (worker.model) meta.push(`Model: ${worker.model}`);
  if (worker.rounds) meta.push(`Rounds: ${worker.rounds}`);
  if (worker.toolCalls) meta.push(`Tools: ${worker.toolCalls}`);
  if (worker.estimatedInputTokens || worker.estimatedOutputTokens) {
    const inK = ((worker.estimatedInputTokens || 0) / 1000).toFixed(1);
    const outK = ((worker.estimatedOutputTokens || 0) / 1000).toFixed(1);
    meta.push(`Tokens: ${inK}K in / ${outK}K out`);
  }
  if (worker.durationMs) meta.push(`${(worker.durationMs / 1000).toFixed(1)}s`);

  return (
    <div
      className={`p-3 bg-vsc-header border border-vsc-border border-l-3 ${borderClass} rounded-lg`}>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-semibold">{worker.taskId}</span>
        <span className="text-[10px]">{statusLabel}</span>
      </div>
      {worker.message && (
        <div className="text-[11px] opacity-70 mb-1 line-clamp-2">
          {worker.message}
        </div>
      )}
      {worker.error && (
        <div className="text-[11px] text-vsc-error mb-1">{worker.error}</div>
      )}
      {meta.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[10px] opacity-50 mt-1">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SwarmTab() {
  const { state } = useAppState();
  const { swarm } = state;

  if (!swarm.running && swarm.workers.length === 0) {
    return (
      <div className="text-center py-16 opacity-50">
        <div className="text-4xl mb-3">⚡</div>
        <p className="text-sm">No swarm activity</p>
        <p className="text-xs mt-2 opacity-60">
          Use @brain in chat: "Launch a swarm to audit this project"
        </p>
      </div>
    );
  }

  const elapsed = swarm.startedAt
    ? ((Date.now() - swarm.startedAt) / 1000).toFixed(1)
    : "—";

  return (
    <div>
      {/* Banner */}
      <div
        className={`flex items-center gap-3 p-3 rounded-lg mb-4 border border-vsc-border ${
          swarm.running ? "bg-vsc-accent/10 border-vsc-accent" : "bg-vsc-header"
        }`}>
        {swarm.running && (
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
        )}
        <span className="text-sm font-semibold flex-1">
          {(swarm.goal || "Swarm").substring(0, 250)}
          {(swarm.goal || "").length > 250 ? "…" : ""}
        </span>
        <span className="text-xs opacity-60">{elapsed}s</span>
      </div>

      {/* Summary */}
      {swarm.summary && (
        <div className="mb-4 p-3 bg-vsc-header border border-vsc-border rounded-lg text-xs leading-relaxed">
          <Markdown content={swarm.summary} />
        </div>
      )}

      {/* Workers Grid */}
      <div className="grid grid-cols-1 gap-2">
        {swarm.workers.map((w) => (
          <WorkerCard key={w.taskId} worker={w} />
        ))}
      </div>
    </div>
  );
}
