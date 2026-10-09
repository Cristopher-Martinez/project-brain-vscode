import { useState } from "react";
import { Markdown } from "../Markdown";
import type { LoopIteration } from "../../types/messages";

export function IterationTable({ iterations }: { iterations: LoopIteration[] }) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const truncate = (s: string, limit = 60) =>
    s.length > limit ? s.substring(0, limit) + "…" : s;

  const copySynthesis = (iteration: LoopIteration) => {
    if (!iteration.synthesis) return;
    navigator.clipboard.writeText(iteration.synthesis).then(() => {
      setCopied(iteration.index);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const toggleRow = (index: number) => {
    setExpandedRow(expandedRow === index ? null : index);
  };

  if (iterations.length === 0) {
    return <div className="text-xs opacity-50 text-center py-4">Sin iteraciones aún</div>;
  }

  return (
    <div className="border border-vsc-border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-vsc-header border-b border-vsc-border">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold w-12">#</th>
            <th className="px-2 py-1.5 text-left font-semibold">Prompt</th>
            <th className="px-2 py-1.5 text-left font-semibold">Synthesis</th>
            <th className="px-2 py-1.5 text-left font-semibold">Feedback</th>
            <th className="px-2 py-1.5 text-center font-semibold w-20">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {iterations.map((it) => {
            const isExpanded = expandedRow === it.index;
            return (
              <tr
                key={it.index}
                className="border-b border-vsc-border/30 hover:bg-vsc-header/30 transition-colors"
              >
                <td className="px-2 py-2 align-top font-mono text-[11px] opacity-70">
                  {it.index}
                </td>
                <td className="px-2 py-2 align-top">
                  {it.prompt ? (
                    <div className="opacity-80">
                      {isExpanded ? (
                        <Markdown content={it.prompt} />
                      ) : (
                        <span className="block cursor-pointer" onClick={() => toggleRow(it.index)}>
                          {truncate(it.prompt)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="opacity-40">—</span>
                  )}
                </td>
                <td className="px-2 py-2 align-top">
                  {it.synthesis ? (
                    <div className="opacity-80">
                      {isExpanded ? (
                        <Markdown content={it.synthesis} />
                      ) : (
                        <span className="block cursor-pointer" onClick={() => toggleRow(it.index)}>
                          {truncate(it.synthesis)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="opacity-40">—</span>
                  )}
                </td>
                <td className="px-2 py-2 align-top">
                  {it.feedback ? (
                    <div className="opacity-80">
                      {isExpanded ? (
                        <Markdown content={it.feedback} />
                      ) : (
                        <span className="block cursor-pointer" onClick={() => toggleRow(it.index)}>
                          {truncate(it.feedback)}
                        </span>
                      )}
                      {it.imageCount && it.imageCount > 0 && (
                        <span className="ml-1 text-[10px] bg-vsc-accent/20 text-vsc-accent px-1.5 py-0.5 rounded-full inline-block mt-1">
                          📷 {it.imageCount} img{it.imageCount > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="opacity-40">—</span>
                  )}
                </td>
                <td className="px-2 py-2 align-top text-center">
                  <div className="flex gap-1 justify-center">
                    <button
                      onClick={() => toggleRow(it.index)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-vsc-border/50 hover:bg-vsc-header"
                      title={isExpanded ? "Colapsar" : "Expandir"}
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>
                    {it.synthesis && (
                      <button
                        onClick={() => copySynthesis(it)}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-vsc-border/50 hover:bg-vsc-header"
                        title="Copiar síntesis"
                      >
                        {copied === it.index ? "✓" : "📋"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
