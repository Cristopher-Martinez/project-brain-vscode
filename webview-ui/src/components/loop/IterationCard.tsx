import { useState } from "react";
import type { LoopIteration } from "../../types/messages";
import { Markdown } from "../Markdown";

export function IterationCard({ iteration }: { iteration: LoopIteration }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const limit = expanded ? Infinity : 120;
  const truncate = (s: string) =>
    s.length > limit ? s.substring(0, limit) + "…" : s;

  const copySynthesis = () => {
    if (!iteration.synthesis) return;
    navigator.clipboard.writeText(iteration.synthesis).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="p-3 bg-vsc-header border border-vsc-border rounded-md text-xs mb-2 cursor-pointer hover:border-vsc-accent/40 transition-colors">
      <div
        className="flex justify-between items-center mb-1"
        onClick={() => setExpanded(!expanded)}>
        <span className="font-semibold">Iteración {iteration.index}</span>
        <div className="flex items-center gap-1.5">
          {iteration.synthesis && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                copySynthesis();
              }}
              className="text-[10px] px-1.5 py-0.5 rounded border border-vsc-border/50 hover:bg-vsc-header cursor-pointer"
              title="Copiar síntesis">
              {copied ? "✓" : "📋"}
            </button>
          )}
          <span className="text-[10px] opacity-40">{expanded ? "▼" : "▶"}</span>
        </div>
      </div>
      {iteration.prompt && (
        <div className="opacity-70 mt-0.5">
          📝{" "}
          {expanded ? (
            <Markdown content={iteration.prompt} />
          ) : (
            truncate(iteration.prompt)
          )}
        </div>
      )}
      {iteration.synthesis && (
        <div className="opacity-70 mt-0.5">
          🧠{" "}
          {expanded ? (
            <Markdown content={iteration.synthesis} />
          ) : (
            truncate(iteration.synthesis)
          )}
        </div>
      )}
      {iteration.feedback && (
        <div className="opacity-70 mt-0.5">
          📨{" "}
          {expanded ? (
            <Markdown content={iteration.feedback} />
          ) : (
            truncate(iteration.feedback)
          )}
          {iteration.imageCount && iteration.imageCount > 0 && (
            <span className="ml-1 text-[10px] bg-vsc-accent/20 text-vsc-accent px-1.5 py-0.5 rounded-full">
              📷 {iteration.imageCount} img{iteration.imageCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
