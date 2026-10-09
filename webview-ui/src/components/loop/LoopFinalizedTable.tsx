import type { FinalizedLoopInfo } from "../../types/messages";
import { postMessage } from "../../vscode";

interface LoopFinalizedTableProps {
  finalized: FinalizedLoopInfo[];
}

function formatDate(ts: number | string): string {
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return d.toLocaleDateString("es", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `hace ${days}d`;
  return formatDate(ts);
}

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "(sin objetivo)";
  return s.length > n ? s.substring(0, n) + "\u2026" : s;
}

export function LoopFinalizedTable({ finalized }: LoopFinalizedTableProps) {
  if (finalized.length === 0) {
    return (
      <div className="text-center py-10 opacity-50">
        <div className="text-3xl mb-2">✅</div>
        <p className="text-xs">No hay loops finalizados</p>
        <p className="text-[11px] mt-1 opacity-60">
          Cuando finalices manualmente un loop aparecerá aquí
        </p>
      </div>
    );
  }

  return (
    <div className="border border-vsc-border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-vsc-header border-b border-vsc-border">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold">Objetivo</th>
            <th className="px-2 py-1.5 text-center font-semibold w-16">
              Rondas
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-20">
              Branch
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-24">
              Fecha
            </th>
            <th className="px-2 py-1.5 text-right font-semibold w-32">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {finalized.map((item) => (
            <tr
              key={item.sessionId}
              className="border-b border-vsc-border last:border-0 hover:bg-vsc-hover transition-colors">
              <td className="px-2 py-2">
                <div className="font-medium">{truncate(item.goal, 60)}</div>
                {item.summary && (
                  <div className="text-[10px] opacity-60 mt-0.5">
                    {truncate(item.summary, 80)}
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-center">{item.totalRounds}</td>
              <td className="px-2 py-2 text-center">
                {item.branchName ? (
                  <span className="text-[10px] bg-vsc-badge px-1 py-0.5 rounded">
                    {item.branchName.replace(/^brain-loop\//, "")}
                  </span>
                ) : (
                  <span className="opacity-30">—</span>
                )}
              </td>
              <td className="px-2 py-2 text-center text-[10px]" title={formatDate(item.finalizedAt)}>
                {timeAgo(typeof item.finalizedAt === "string" ? new Date(item.finalizedAt).getTime() : item.finalizedAt)}
              </td>
              <td className="px-2 py-2 text-right">
                <div className="flex gap-1 justify-end">
                  <button
                    onClick={() =>
                      postMessage({
                        type: "createLoopSession",
                        goal: item.goal || "(sin objetivo)",
                      } as never)
                    }
                    className="px-2 py-0.5 text-[10px] rounded bg-vsc-btn-bg text-vsc-btn-fg hover:opacity-90 cursor-pointer"
                    title="Reconectar — lanzar un nuevo loop con el mismo objetivo">
                    🔄 Reconectar
                  </button>
                  <button
                    onClick={() =>
                      postMessage({
                        type: "deleteFinalizedLoop",
                        sessionId: item.sessionId,
                      })
                    }
                    className="px-2 py-0.5 text-[10px] rounded bg-transparent border border-vsc-border text-vsc-fg hover:bg-vsc-hover cursor-pointer"
                    title="Eliminar del historial">
                    🗑️
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
