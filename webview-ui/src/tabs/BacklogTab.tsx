import { useEffect, useState } from "react";
import { PendingBranches } from "../components/branch/PendingBranches";
import { useAppState } from "../store/AppContext";
import type {
  BranchIsolationInfo,
  HibernatedLoopInfo,
} from "../types/messages";
import { postMessage } from "../vscode";

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: string }
> = {
  active: {
    label: "In Progress",
    color: "text-blue-400",
    bg: "bg-blue-500/15 border-blue-500/30",
    icon: "🔵",
  },
  completed: {
    label: "Review",
    color: "text-yellow-400",
    bg: "bg-yellow-500/15 border-yellow-500/30",
    icon: "🟡",
  },
  merged: {
    label: "Done",
    color: "text-green-400",
    bg: "bg-green-500/15 border-green-500/30",
    icon: "✅",
  },
  discarded: {
    label: "Discarded",
    color: "text-gray-400",
    bg: "bg-gray-500/15 border-gray-500/30",
    icon: "🗑️",
  },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Backlog Card (Jira-style) ──────────────────────────────────────────────

function BacklogCard({ branch }: { branch: BranchIsolationInfo }) {
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cfg = STATUS_CONFIG[branch.status] || STATUS_CONFIG.active;
  const shortId = branch.sessionId.substring(0, 8);

  const handleRename = () => {
    if (!newName.trim()) return;
    postMessage({
      type: "renameBranch",
      sessionId: branch.sessionId,
      newName: newName.trim(),
    });
    setRenaming(false);
    setNewName("");
  };

  return (
    <div className={`border rounded-lg mb-3 overflow-hidden ${cfg.bg}`}>
      {/* Card Header */}
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Status badge + branch type */}
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${cfg.bg} ${cfg.color}`}>
              {cfg.icon} {cfg.label}
            </span>
            <span className="text-[10px] opacity-40 uppercase tracking-wider">
              {branch.type}
            </span>
            <span className="text-[10px] opacity-30 font-mono">#{shortId}</span>
          </div>

          {/* Branch name (title) */}
          <div
            className="font-semibold text-sm mb-1 truncate"
            title={branch.branchName}>
            🌿 {branch.branchName}
          </div>

          {/* Description / Goal */}
          {branch.description && (
            <p className="text-[11px] opacity-70 mb-1.5 line-clamp-2">
              {branch.description}
            </p>
          )}

          {/* Summary (executive) */}
          {branch.summary && (
            <div className="text-[11px] p-2 bg-black/20 rounded-md mb-1.5 leading-relaxed">
              <span className="font-semibold opacity-80">📄 Summary: </span>
              {branch.summary}
            </div>
          )}

          {/* Report link */}
          {branch.reportPath && (
            <button
              onClick={() =>
                postMessage({ type: "openFile", filePath: branch.reportPath! })
              }
              className="text-[11px] text-vsc-accent hover:underline cursor-pointer mb-1">
              📝 View implementation report →
            </button>
          )}
        </div>

        {/* Right side: meta info */}
        <div className="text-right text-[10px] opacity-50 whitespace-nowrap flex-shrink-0">
          <div className="mb-0.5">⏱ {timeAgo(branch.createdAt)}</div>
          <div>🔀 {branch.originalBranch}</div>
        </div>
      </div>

      {/* Card Actions */}
      <div className="px-4 py-2 border-t border-white/5 flex items-center gap-2 flex-wrap">
        {/* Rename */}
        {!renaming ? (
          <button
            onClick={() => {
              setRenaming(true);
              setNewName(branch.branchName);
            }}
            className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer transition-colors"
            title="Rename branch">
            ✏️ Rename
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
              className="text-[11px] px-2 py-0.5 rounded border border-vsc-border bg-vsc-bg text-vsc-fg w-48"
              autoFocus
            />
            <button
              onClick={handleRename}
              className="text-[10px] px-2 py-1 rounded bg-vsc-accent text-white cursor-pointer">
              ✓
            </button>
            <button
              onClick={() => setRenaming(false)}
              className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer">
              ✕
            </button>
          </div>
        )}

        {/* Diff preview */}
        <button
          onClick={() =>
            postMessage({ type: "getDiffPreview", sessionId: branch.sessionId })
          }
          className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer transition-colors">
          📊 Diff
        </button>

        {/* Audit */}
        {(branch.status === "active" || branch.status === "completed") && (
          <button
            onClick={() =>
              postMessage({ type: "auditBranch", sessionId: branch.sessionId })
            }
            className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer transition-colors">
            🔍 Audit
          </button>
        )}

        {/* Open fork in VS Code */}
        <button
          onClick={() =>
            postMessage({
              type: "openForkInVSCode",
              sessionId: branch.sessionId,
            })
          }
          className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer transition-colors"
          title="Open isolated repo in a new VS Code window">
          📂 Open
        </button>

        {/* Delete fork */}
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-[10px] px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 cursor-pointer transition-colors ml-auto"
            title="Delete this fork permanently">
            🗑️ Delete
          </button>
        ) : (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[10px] text-red-400">Delete fork?</span>
            <button
              onClick={() => {
                postMessage({
                  type: "discardBranch",
                  sessionId: branch.sessionId,
                });
                setConfirmDelete(false);
              }}
              className="text-[10px] px-2 py-1 rounded bg-red-600 text-white cursor-pointer">
              Yes
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 cursor-pointer">
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Hibernated Loop Card ───────────────────────────────────────────────────

function HibernatedCard({ loop }: { loop: HibernatedLoopInfo }) {
  return (
    <div className="mb-2 p-3 rounded-lg border border-vsc-border bg-vsc-header/50 hover:bg-vsc-hover transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-yellow-600 flex-shrink-0" />
            <span className="text-xs font-semibold truncate">
              {(loop.goal || "Loop").substring(0, 60)}
            </span>
          </div>
          <div className="text-[10px] opacity-50 ml-4">
            {loop.currentRound} iteraciones
            {loop.branchName && (
              <>
                {" "}
                · Branch: <code>{loop.branchName}</code>
              </>
            )}
            {" · "}Hibernado {timeAgo(loop.hibernatedAt)}
          </div>
          {loop.summary && (
            <p className="text-[10px] opacity-40 ml-4 mt-1 line-clamp-2">
              {loop.summary}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() =>
              postMessage({
                type: "runCommand",
                commandId: "projectBrain.loopResume",
                args: [loop.sessionId],
              })
            }
            className="px-2 py-1 text-[10px] rounded bg-vsc-accent/20 hover:bg-vsc-accent/40 cursor-pointer transition-colors"
            title="Resume this loop">
            ☀️ Resume
          </button>
          <button
            onClick={() =>
              postMessage({
                type: "runCommand",
                commandId: "projectBrain.loopDeleteHibernated",
                args: [loop.sessionId],
              })
            }
            className="px-2 py-1 text-[10px] rounded bg-red-500/10 hover:bg-red-500/30 cursor-pointer transition-colors opacity-60 hover:opacity-100"
            title="Delete this hibernated loop">
            🗑️
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Column Header ──────────────────────────────────────────────────────────

function ColumnHeader({
  icon,
  label,
  count,
  color,
}: {
  icon: string;
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-sm">{icon}</span>
      <span className="text-xs font-bold uppercase tracking-wider opacity-70">
        {label}
      </span>
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${color}`}>
        {count}
      </span>
    </div>
  );
}

// ─── Main BacklogTab ────────────────────────────────────────────────────────

export function BacklogTab() {
  const { state, dispatch } = useAppState();

  useEffect(() => {
    postMessage({ type: "requestPendingBranches" });
    postMessage({ type: "requestAllBranches" });
    postMessage({ type: "requestHibernatedLoops" });
    postMessage({ type: "requestAllLoopStates" });
  }, []);

  const activeBranches = state.allBranches.filter((b) => b.status === "active");
  const pendingBranches = state.pendingBranches;
  const mergedBranches = state.allBranches.filter((b) => b.status === "merged");
  const discardedBranches = state.allBranches.filter(
    (b) => b.status === "discarded",
  );

  const totalCount = state.allBranches.length;
  const hibernatedLoops = state.hibernatedLoops;
  const interruptedLoops = state.interruptedLoops;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold">📋 Branch Backlog</h3>
          <p className="text-[11px] opacity-40 mt-0.5">
            Track all isolation branches — from creation to merge
          </p>
        </div>
        <div className="text-[11px] opacity-50">
          {totalCount} {totalCount === 1 ? "branch" : "branches"} total
        </div>
      </div>

      {/* Empty state */}
      {totalCount === 0 &&
        hibernatedLoops.length === 0 &&
        interruptedLoops.length === 0 && (
          <div className="text-center py-16 opacity-40">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-sm font-semibold">No branches yet</p>
            <p className="text-[11px] mt-1.5">
              Enable <strong>Branch Isolation</strong> when launching a Loop to
              see branches here
            </p>
          </div>
        )}

      {/* Active — In Progress */}
      {activeBranches.length > 0 && (
        <div className="mb-6">
          <ColumnHeader
            icon="🔵"
            label="In Progress"
            count={activeBranches.length}
            color="bg-blue-500/20 text-blue-400"
          />
          {activeBranches.map((b) => (
            <BacklogCard key={b.sessionId} branch={b} />
          ))}
        </div>
      )}

      {/* Pending — Ready for Review (using MergeGate) */}
      {pendingBranches.length > 0 && (
        <div className="mb-6">
          <ColumnHeader
            icon="🟡"
            label="Ready for Review"
            count={pendingBranches.length}
            color="bg-yellow-500/20 text-yellow-400"
          />
          <PendingBranches
            branches={pendingBranches}
            audits={state.branchAudits}
            checkedOutId={state.checkedOutBranchId ?? undefined}
            onRequestAudit={(sid) =>
              postMessage({ type: "auditBranch", sessionId: sid })
            }
          />
        </div>
      )}

      {/* Done — Merged */}
      {mergedBranches.length > 0 && (
        <div className="mb-6">
          <ColumnHeader
            icon="✅"
            label="Done"
            count={mergedBranches.length}
            color="bg-green-500/20 text-green-400"
          />
          {mergedBranches.map((b) => (
            <BacklogCard key={b.sessionId} branch={b} />
          ))}
        </div>
      )}

      {/* Hibernated Loops */}
      {hibernatedLoops.length > 0 && (
        <div className="mb-6">
          <ColumnHeader
            icon="💤"
            label="Hibernated"
            count={hibernatedLoops.length}
            color="bg-yellow-600/20 text-yellow-500"
          />
          {hibernatedLoops.map((h) => (
            <HibernatedCard key={h.sessionId} loop={h} />
          ))}
        </div>
      )}

      {/* Interrupted Loops */}
      {interruptedLoops.length > 0 && (
        <div className="mb-6">
          <ColumnHeader
            icon="⚡"
            label="Interrupted"
            count={interruptedLoops.length}
            color="bg-orange-600/20 text-orange-400"
          />
          {interruptedLoops.map((il) => (
            <div
              key={il.sessionId}
              className="mb-2 p-3 rounded-lg border border-orange-600/30 bg-vsc-header">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium truncate">
                    {(il.goal || il.sessionId || "—").substring(0, 250)}
                    {(il.goal || "").length > 250 ? "…" : ""}
                  </p>
                  <p className="text-[10px] opacity-50 mt-0.5">
                    {il.iterationCount} iter · {il.state} ·{" "}
                    {new Date(il.persistedAt).toLocaleString()}
                  </p>
                  {il.lastSynthesis && (
                    <p className="text-[10px] opacity-40 mt-0.5 line-clamp-2">
                      {il.lastSynthesis}
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5 ml-2">
                  <button
                    onClick={() =>
                      postMessage({
                        type: "resumeLoopSession",
                        sessionId: il.sessionId,
                      })
                    }
                    className="px-2 py-1 text-[10px] rounded bg-orange-600/20 hover:bg-orange-600/40 cursor-pointer transition-colors"
                    title="Reanudar">
                    🔁 Resume
                  </button>
                  <button
                    onClick={() => {
                      postMessage({
                        type: "discardInterruptedLoop",
                        sessionId: il.sessionId,
                      });
                      dispatch({
                        type: "REMOVE_INTERRUPTED_LOOP",
                        sessionId: il.sessionId,
                      });
                    }}
                    className="px-2 py-1 text-[10px] rounded bg-red-600/20 hover:bg-red-600/40 cursor-pointer transition-colors"
                    title="Descartar">
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Discarded */}
      {discardedBranches.length > 0 && (
        <div className="mb-6 opacity-60">
          <ColumnHeader
            icon="🗑️"
            label="Discarded"
            count={discardedBranches.length}
            color="bg-gray-500/20 text-gray-400"
          />
          {discardedBranches.map((b) => (
            <BacklogCard key={b.sessionId} branch={b} />
          ))}
        </div>
      )}
    </div>
  );
}
