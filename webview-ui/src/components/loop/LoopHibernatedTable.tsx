import { useMemo } from "react";
import type {
  HibernatedLoopInfo,
  InterruptedLoopInfo,
} from "../../types/messages";
import { postMessage } from "../../vscode";

interface LoopHibernatedTableProps {
  hibernated: HibernatedLoopInfo[];
  interrupted: InterruptedLoopInfo[];
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

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "(sin objetivo)";
  return s.length > n ? s.substring(0, n) + "…" : s;
}

export function LoopHibernatedTable({
  hibernated,
  interrupted,
}: LoopHibernatedTableProps) {
  const combined = useMemo(() => {
    const items: Array<{
      type: "hibernated" | "interrupted";
      id: string;
      goal: string;
      rounds: number;
      branch?: string;
      date: number;
      summary?: string;
      lastSynthesis?: string;
    }> = [];

    for (const h of hibernated) {
      items.push({
        type: "hibernated",
        id: h.sessionId,
        goal: h.goal,
        rounds: h.currentRound,
        branch: h.branchName,
        date:
          typeof h.hibernatedAt === "string"
            ? new Date(h.hibernatedAt).getTime()
            : h.hibernatedAt,
        summary: h.summary,
      });
    }

    for (const i of interrupted) {
      items.push({
        type: "interrupted",
        id: i.sessionId,
        goal: i.goal,
        rounds: i.iterationCount,
        date:
          typeof i.persistedAt === "string"
            ? new Date(i.persistedAt).getTime()
            : i.persistedAt,
        lastSynthesis: i.lastSynthesis,
      });
    }

    // Most recent first
    items.sort((a, b) => b.date - a.date);
    return items;
  }, [hibernated, interrupted]);

  if (combined.length === 0) {
    return (
      <div className="text-center py-10 opacity-50">
        <div className="text-3xl mb-2">💤</div>
        <p className="text-xs">No hay loops hibernados ni interrumpidos</p>
        <p className="text-[11px] mt-1 opacity-60">
          Cuando un loop se pausa o interrumpe aparecerá aquí
        </p>
      </div>
    );
  }

  return (
    <div className="border border-vsc-border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-vsc-header border-b border-vsc-border">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold w-10">Tipo</th>
            <th className="px-2 py-1.5 text-left font-semibold">Objetivo</th>
            <th className="px-2 py-1.5 text-center font-semibold w-16">
              Rondas
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-20">
              Branch
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-28">
              Fecha
            </th>
            <th className="px-2 py-1.5 text-center font-semibold w-24">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {combined.map((item) => (
            <HibernatedRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────

function HibernatedRow({
  item,
}: {
  item: {
    type: "hibernated" | "interrupted";
    id: string;
    goal: string;
    rounds: number;
    branch?: string;
    date: number;
    summary?: string;
    lastSynthesis?: string;
  };
}) {
  const isHibernated = item.type === "hibernated";

  const resume = () => {
    postMessage({
      type: isHibernated ? "resumeHibernatedLoop" : "resumeInterruptedLoop",
      sessionId: item.id,
    });
  };

  const discard = () => {
    if (isHibernated) {
      postMessage({ type: "discardHibernatedLoop", sessionId: item.id });
    } else {
      postMessage({ type: "discardInterruptedLoop", sessionId: item.id });
    }
  };

  const archive = () => {
    postMessage({ type: "archiveHibernatedLoop", sessionId: item.id });
  };

  return (
    <tr className="border-b border-vsc-border/30 hover:bg-vsc-header/30 transition-colors">
      <td className="px-2 py-2 text-center">
        <span title={isHibernated ? "Hibernado" : "Interrumpido"}>
          {isHibernated ? "💤" : "⚡"}
        </span>
      </td>
      <td className="px-2 py-2">
        <div className="font-medium">{truncate(item.goal, 60)}</div>
        {(item.summary || item.lastSynthesis) && (
          <div className="text-[10px] opacity-50 mt-0.5 line-clamp-1">
            {truncate(item.summary || item.lastSynthesis || "", 80)}
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-center font-mono opacity-70">
        {item.rounds}
      </td>
      <td className="px-2 py-2 text-center">
        {item.branch ? (
          <span className="text-[10px] text-vsc-accent font-mono">
            {truncate(item.branch, 15)}
          </span>
        ) : (
          <span className="opacity-30">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-center text-[11px] opacity-60">
        {formatDate(item.date)}
      </td>
      <td className="px-2 py-2 text-center">
        <div className="flex gap-1 justify-center">
          <button
            onClick={resume}
            className="px-1.5 py-0.5 text-[10px] rounded border border-green-500/40 text-green-400 hover:bg-green-500/10 cursor-pointer"
            title="Reanudar">
            ☀️
          </button>
          {isHibernated && (
            <button
              onClick={archive}
              className="px-1.5 py-0.5 text-[10px] rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 cursor-pointer"
              title="Archivar en Finalizados">
              ✅
            </button>
          )}
          <button
            onClick={discard}
            className="px-1.5 py-0.5 text-[10px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 cursor-pointer"
            title="Descartar">
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}
