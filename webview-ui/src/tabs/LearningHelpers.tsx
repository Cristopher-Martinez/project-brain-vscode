// Status display helpers for Self-Learning tab

import { useEffect, useState } from "react";
import type { SLProgressInfo } from "../types/messages";

const STATUS_COLORS: Record<string, string> = {
  pending: "text-gray-400",
  cloning: "text-yellow-400",
  cloned: "text-blue-400",
  vectorizing: "text-yellow-400",
  indexed: "text-green-400",
  analyzing: "text-purple-400",
  analyzed: "text-emerald-400",
  error: "text-red-400",
  running: "text-yellow-400",
  completed: "text-green-400",
};

const ACTIVE_STATUSES = ["cloning", "vectorizing", "analyzing", "running"];

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "text-gray-400";
  return (
    <span className={`text-[11px] font-mono ${color}`}>
      {isActiveStatus(status) && (
        <span className="inline-block animate-pulse mr-1">&bull;</span>
      )}
      {status}
    </span>
  );
}

const PHASE_COLORS: Record<string, string> = {
  cloning: "bg-yellow-500",
  vectorizing: "bg-blue-500",
  analyzing: "bg-purple-500",
  done: "bg-green-500",
  error: "bg-red-500",
};

const PHASE_LABELS: Record<string, string> = {
  cloning: "Cloning",
  vectorizing: "Vectorizing",
  analyzing: "Analyzing",
  done: "Done",
  error: "Error",
};

export function ProgressIndicator({ progress }: { progress: SLProgressInfo }) {
  const barColor = PHASE_COLORS[progress.phase] ?? "bg-gray-500";
  const label = PHASE_LABELS[progress.phase] ?? progress.phase;
  const isActive = progress.phase !== "done" && progress.phase !== "error";
  const percentLabel =
    typeof progress.percent === "number" ? ` ${progress.percent}%` : "";

  const width =
    progress.phase === "done"
      ? "100%"
      : typeof progress.percent === "number"
        ? `${Math.min(100, Math.max(0, progress.percent))}%`
        : "60%";

  // Tick every second for elapsed time
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isActive) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [isActive]);

  const elapsed = progress.startedAt
    ? formatElapsed(now - progress.startedAt)
    : "";

  const stale = progress.updatedAt ? now - progress.updatedAt > 10_000 : false;

  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-vsc-bg overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor} ${isActive ? "animate-pulse" : ""}`}
          style={{ width }}
        />
      </div>
      <span
        className={`text-[10px] font-mono whitespace-nowrap ${
          progress.phase === "error" ? "text-red-400" : "text-vsc-fg opacity-60"
        }`}>
        {isActive && (
          <span
            className={`inline-block mr-1 ${stale ? "text-orange-400" : "text-green-400"}`}
            title={stale ? "No updates in >10s" : "Receiving data"}>
            {stale ? "⏳" : "●"}
          </span>
        )}
        {label}
        {percentLabel}: {progress.detail}
        {elapsed && <span className="ml-1 opacity-40">({elapsed})</span>}
      </span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}
