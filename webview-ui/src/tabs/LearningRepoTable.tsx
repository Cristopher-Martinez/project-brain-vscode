// Repo table for Self-Learning tab

import type { SLProgressInfo, SLRepoEntry } from "../types/messages";
import { postMessage } from "../vscode";
import {
  ProgressIndicator,
  StatusBadge,
  isActiveStatus,
} from "./LearningHelpers";

// ─── Action Buttons ─────────────────────────────────────────────────────────

function RepoActions({
  repo,
  onAnalyze,
  hasActiveProgress,
}: {
  repo: SLRepoEntry;
  onAnalyze: (id: number) => void;
  hasActiveProgress: boolean;
}) {
  const active = isActiveStatus(repo.status) || hasActiveProgress;
  const canStart =
    !active &&
    (repo.status === "pending" ||
      repo.status === "cloned" ||
      repo.status === "error");
  return (
    <div className="flex gap-1">
      {canStart && (
        <button
          onClick={() =>
            postMessage({ type: "sl:startPipeline", repoId: repo.id })
          }
          className="px-2 py-0.5 text-[10px] rounded bg-green-600 text-white hover:opacity-80 cursor-pointer font-medium">
          Start
        </button>
      )}
      {repo.status === "error" && (
        <button
          onClick={() =>
            postMessage({ type: "sl:startPipeline", repoId: repo.id })
          }
          className="px-2 py-0.5 text-[10px] rounded bg-amber-600 text-white hover:opacity-80 cursor-pointer">
          Retry
        </button>
      )}
      {(repo.status === "indexed" || repo.status === "analyzed") && (
        <button
          onClick={() => onAnalyze(repo.id)}
          className="px-2 py-0.5 text-[10px] rounded bg-purple-600 text-white hover:opacity-80 cursor-pointer">
          Analyze
        </button>
      )}
      {active && (
        <button
          onClick={() =>
            postMessage({
              type: "sl:cancelOperation",
              repoId: repo.id,
            } as never)
          }
          className="px-2 py-0.5 text-[10px] rounded bg-red-600 text-white hover:opacity-80 cursor-pointer">
          Cancel
        </button>
      )}
      {!active && (
        <button
          onClick={() =>
            postMessage({ type: "sl:removeRepo", repoId: repo.id } as never)
          }
          className="px-2 py-0.5 text-[10px] rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer">
          Remove
        </button>
      )}
    </div>
  );
}

// ─── Repo Row ───────────────────────────────────────────────────────────────

function RepoRow({
  repo,
  onAnalyze,
  progress,
}: {
  repo: SLRepoEntry;
  onAnalyze: (id: number) => void;
  progress?: SLProgressInfo;
}) {
  return (
    <>
      <tr className="border-b border-vsc-border hover:bg-vsc-hover transition-colors">
        <td className="px-3 py-2 text-xs font-medium">{repo.name}</td>
        <td className="px-3 py-2 text-[11px] opacity-60 max-w-50 truncate">
          {repo.source}
        </td>
        <td className="px-3 py-2">
          <StatusBadge status={repo.status} />
        </td>
        <td className="px-3 py-2 text-[11px] text-center opacity-60">
          {repo.chunkCount > 0 ? repo.chunkCount : "-"}
        </td>
        <td className="px-3 py-2 text-[11px] text-center opacity-60">
          {repo.fileCount > 0 ? repo.fileCount : "-"}
        </td>
        <td className="px-3 py-2">
          <RepoActions
            repo={repo}
            onAnalyze={onAnalyze}
            hasActiveProgress={
              !!progress &&
              progress.phase !== "done" &&
              progress.phase !== "error"
            }
          />
        </td>
      </tr>
      {progress && (
        <tr className="border-b border-vsc-border">
          <td colSpan={6} className="px-3 py-1">
            <ProgressIndicator progress={progress} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Repo Table ─────────────────────────────────────────────────────────────

export function RepoTable({
  repos,
  onAnalyze,
  progress,
}: {
  repos: SLRepoEntry[];
  onAnalyze: (id: number) => void;
  progress: Record<number, SLProgressInfo>;
}) {
  if (repos.length === 0) {
    return (
      <div className="text-center py-10 opacity-50">
        <div className="text-3xl mb-2">🔬</div>
        <p className="text-xs">
          No repos yet. Add a GitHub URL or local path above.
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-[50vh] overflow-y-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-vsc-border text-[11px] opacity-50">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium text-center">Chunks</th>
            <th className="px-3 py-2 font-medium text-center">Files</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              onAnalyze={onAnalyze}
              progress={progress[repo.id]}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
