import { useState } from "react";
import type { EnrichResultPayload } from "../../types/messages";
import { Markdown } from "../Markdown";

/**
 * Displays the Context Enricher preview panel.
 * Shows formatted markdown of the enrichment result with accept/reject actions.
 */
export function EnrichPreview({
  result,
  source,
  onAccept,
  onReject,
  loading,
}: {
  result: EnrichResultPayload | null;
  source: "goal" | "feedback";
  onAccept: (rewrittenPrompt: string) => void;
  onReject: () => void;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (loading) {
    return (
      <div className="mt-2 p-3 bg-vsc-header border border-vsc-accent/50 rounded-md animate-pulse">
        <div className="flex items-center gap-2 text-xs text-vsc-fg/70">
          <span className="inline-block w-4 h-4 border-2 border-vsc-accent border-t-transparent rounded-full animate-spin" />
          🧠 Enriqueciendo con contexto de memoria...
        </div>
      </div>
    );
  }

  if (!result) return null;

  const { pack, formattedMarkdown, durationMs } = result;

  return (
    <div className="mt-2 p-3 bg-vsc-header border border-vsc-accent/40 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-vsc-accent flex items-center gap-1.5">
          🧠 Contexto enriquecido
          <span className="text-[10px] opacity-60 font-normal">
            ({durationMs}ms · {pack.fileMap.length} archivos · {pack.contextBlocks.length} bloques)
          </span>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] px-2 py-0.5 rounded border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer">
          {expanded ? "▲ Colapsar" : "▼ Expandir"}
        </button>
      </div>

      {expanded && (
        <div className="text-xs leading-relaxed p-3 bg-vsc-bg border border-vsc-border rounded-md mb-2 overflow-y-auto max-h-[50vh]">
          <div className="prose prose-sm prose-invert max-w-none [&>p]:mb-2 [&>ul]:ml-4 [&>ul]:list-disc [&>h3]:text-xs [&>h3]:font-semibold [&>h3]:mb-1 [&>pre]:bg-black/30 [&>pre]:p-2 [&>pre]:rounded [&>pre]:text-[11px]">
            <Markdown content={formattedMarkdown} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => onAccept(pack.rewrittenPrompt)}
          className="px-3 py-1.5 text-xs font-semibold rounded-md bg-vsc-accent text-white hover:opacity-90 cursor-pointer">
          ✓ {source === "goal" ? "Lanzar con contexto" : "Enviar enriquecido"}
        </button>
        <button
          onClick={onReject}
          className="px-3 py-1.5 text-xs rounded-md border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer">
          ✗ Usar original
        </button>
        <span className="text-[10px] opacity-40 ml-auto">
          Confianza: {(pack.confidence * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
