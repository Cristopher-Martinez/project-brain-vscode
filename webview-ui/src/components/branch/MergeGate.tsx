import { useState } from "react";
import type {
  AuditHistoryEntry,
  AuditTrend,
  BranchAuditResult,
  BranchIsolationInfo,
} from "../../types/messages";
import { postMessage } from "../../vscode";

const TREND_DISPLAY: Record<
  AuditTrend,
  { icon: string; color: string; label: string }
> = {
  improving: { icon: "↑", color: "text-green-400", label: "Improving" },
  stable: { icon: "→", color: "text-blue-400", label: "Stable" },
  degrading: { icon: "↓", color: "text-red-400", label: "Degrading" },
  unknown: { icon: "?", color: "text-gray-400", label: "No trend" },
};

function formatAge(createdAt: number): string {
  const diff = Date.now() - createdAt;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isStale(createdAt: number): boolean {
  return Date.now() - createdAt > 24 * 60 * 60_000; // >24h
}

function isQuickMergeable(audit?: BranchAuditResult): boolean {
  if (!audit) return false;
  return (
    audit.compatible &&
    audit.aheadBehind.ahead <= 5 &&
    audit.aheadBehind.behind === 0
  );
}

interface MergeGateProps {
  branch: BranchIsolationInfo;
  audit?: BranchAuditResult;
  trend?: AuditTrend;
  history?: AuditHistoryEntry[];
  checkedOut?: boolean;
  onRequestAudit?: (sessionId: string) => void;
}

export function MergeGate({
  branch,
  audit,
  trend,
  history,
  checkedOut,
  onRequestAudit,
}: MergeGateProps) {
  const [changeInstructions, setChangeInstructions] = useState("");
  const [showChangeInput, setShowChangeInput] = useState(false);
  const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);

  const showDiff = () => {
    postMessage({ type: "getDiffPreview", sessionId: branch.sessionId });
  };

  const merge = () => {
    postMessage({ type: "mergeBranch", sessionId: branch.sessionId });
  };

  const discard = () => {
    setShowConfirmDiscard(true);
  };

  const confirmDiscard = () => {
    postMessage({ type: "discardBranch", sessionId: branch.sessionId });
    setShowConfirmDiscard(false);
  };

  const keep = () => {
    postMessage({ type: "keepBranch", sessionId: branch.sessionId });
  };

  const checkout = () => {
    postMessage({ type: "checkoutBranch", sessionId: branch.sessionId });
  };

  const returnFromInspection = () => {
    postMessage({ type: "returnFromBranch", sessionId: branch.sessionId });
  };

  const auditBranch = () => {
    onRequestAudit?.(branch.sessionId);
    postMessage({ type: "auditBranch", sessionId: branch.sessionId });
  };

  const openInEditor = () => {
    postMessage({ type: "openBranch", sessionId: branch.sessionId });
  };

  const requestChanges = () => {
    if (!changeInstructions.trim()) return;
    postMessage({
      type: "requestBranchChanges",
      sessionId: branch.sessionId,
      instructions: changeInstructions.trim(),
    });
    setChangeInstructions("");
    setShowChangeInput(false);
  };

  if (branch.status === "merged" || branch.status === "discarded") {
    return (
      <div className="p-3 bg-vsc-header border border-vsc-border rounded-md text-xs mb-2">
        <span className="opacity-60">
          {branch.status === "merged" ? "✅" : "🗑️"} {branch.branchName} —{" "}
          {branch.status}
        </span>
      </div>
    );
  }

  return (
    <div className="p-3 bg-vsc-header border-2 border-vsc-accent rounded-lg mb-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-sm">🌿 {branch.branchName}</div>
        {checkedOut && (
          <span className="text-[10px] px-2 py-0.5 bg-vsc-accent text-white rounded-full">
            👁 Inspecting
          </span>
        )}
      </div>
      <div className="text-[11px] opacity-60 mb-3">
        Base: {branch.originalBranch} | {formatAge(branch.createdAt)}
        {isStale(branch.createdAt) && (
          <span
            className="ml-1 text-yellow-400"
            title="Branch older than 24h — may have diverged">
            ⚠️ stale
          </span>
        )}
      </div>

      {/* Quick Merge Banner */}
      {isQuickMergeable(audit) && (
        <div className="mb-3 p-2 rounded-md border border-green-500/40 bg-green-500/10 flex items-center justify-between">
          <span className="text-[11px] text-green-400">
            ⚡ Clean branch — ready to quick merge
          </span>
          <button
            onClick={merge}
            className="px-3 py-1 text-[11px] font-medium rounded bg-green-600 text-white hover:opacity-90 cursor-pointer">
            ⚡ Quick Merge
          </button>
        </div>
      )}

      {/* Audit Results */}
      {audit && (
        <div
          className={`mb-3 p-2 rounded-md border text-[11px] ${
            audit.compatible
              ? "border-green-500/30 bg-green-500/5"
              : "border-red-500/30 bg-red-500/5"
          }`}>
          <div className="font-semibold mb-1">
            {audit.compatible
              ? "✅ Compatible with "
              : "⚠️ Conflicts with "}
            {branch.originalBranch}
          </div>
          <div className="opacity-70">
            +{audit.aheadBehind.ahead} commits ahead, -
            {audit.aheadBehind.behind} behind
          </div>
          {audit.conflictFiles.length > 0 && (
            <div className="mt-1 text-red-400">
              Conflicts: {audit.conflictFiles.join(", ")}
            </div>
          )}
          {audit.diffSummary && audit.diffSummary !== "(no changes)" && (
            <pre className="mt-1 opacity-60 whitespace-pre-wrap text-[10px] max-h-24 overflow-y-auto">
              {audit.diffSummary}
            </pre>
          )}
          {/* Trend Indicator */}
          {trend && trend !== "unknown" && (
            <div
              className={`mt-2 flex items-center gap-1 font-semibold ${TREND_DISPLAY[trend].color}`}>
              <span className="text-base">{TREND_DISPLAY[trend].icon}</span>
              <span>{TREND_DISPLAY[trend].label}</span>
              <span className="opacity-50 font-normal ml-1">
                ({history?.length ?? 0} audits)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Audit History Mini-Panel */}
      {history && history.length > 1 && (
        <div className="mb-3 p-2 rounded-md border border-vsc-border bg-vsc-bg text-[10px]">
          <div className="font-semibold mb-1 text-[11px]">📊 Audit History</div>
          <div className="space-y-0.5 max-h-20 overflow-y-auto">
            {history
              .slice(-5)
              .reverse()
              .map((entry, i) => (
                <div key={i} className="flex items-center gap-2 opacity-80">
                  <span
                    className={
                      entry.compatible ? "text-green-400" : "text-red-400"
                    }>
                    {entry.compatible ? "✓" : "✗"}
                  </span>
                  <span>{entry.conflicts} conflicts</span>
                  <span>·</span>
                  <span>{entry.behind} behind</span>
                  <span className="opacity-50 ml-auto">
                    {formatAge(entry.timestamp)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap mb-2">
        {!checkedOut ? (
          <button
            onClick={checkout}
            className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
            👁 Inspect
          </button>
        ) : (
          <button
            onClick={returnFromInspection}
            className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
            ↩️ Return
          </button>
        )}
        <button
          onClick={openInEditor}
          className="px-3 py-1 text-[11px] font-medium rounded bg-blue-600 text-white hover:opacity-90 cursor-pointer">
          📂 Open
        </button>
        <button
          onClick={auditBranch}
          className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
          🔍 Audit
        </button>
        <button
          onClick={showDiff}
          className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
          📋 Diff
        </button>
        <button
          onClick={merge}
          className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-accent text-white hover:opacity-90 cursor-pointer">
          ✅ Merge
        </button>
        <button
          onClick={() => setShowChangeInput(!showChangeInput)}
          className="px-3 py-1 text-[11px] font-medium rounded bg-yellow-600 text-white hover:opacity-90 cursor-pointer">
          📝 Request Changes
        </button>
        <button
          onClick={discard}
          className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-error text-white hover:opacity-90 cursor-pointer">
          🗑️ Discard
        </button>
        <button
          onClick={keep}
          className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
          📌 Keep
        </button>
      </div>

      {/* Request Changes Panel */}
      {showChangeInput && (
        <div className="mt-2 p-3 border border-vsc-border rounded-md bg-vsc-bg">
          <div className="text-[11px] font-semibold mb-1">
            📝 Describe the changes needed:
          </div>
          <textarea
            value={changeInstructions}
            onChange={(e) => setChangeInstructions(e.target.value)}
            rows={3}
            placeholder="e.g., Fix the error handling in the auth module, add input validation..."
            className="w-full p-2 text-xs rounded-md border border-vsc-border bg-vsc-bg text-vsc-fg resize-y mb-2"
          />
          <div className="flex gap-2">
            <button
              onClick={requestChanges}
              className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-accent text-white hover:opacity-90 cursor-pointer">
              🚀 Launch Loop
            </button>
            <button
              onClick={() => setShowChangeInput(false)}
              className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Confirm Discard Dialog (inline — window.confirm doesn't work in webviews) */}
      {showConfirmDiscard && (
        <div className="mt-2 p-3 border-2 border-red-500/50 rounded-md bg-red-500/10">
          <div className="text-[11px] font-semibold mb-2 text-red-400">
            ⚠️ Are you sure? This will delete the branch and ALL
            its changes permanently.
          </div>
          <div className="flex gap-2">
            <button
              onClick={confirmDiscard}
              className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-error text-white hover:opacity-90 cursor-pointer">
              🗑️ Yes, Discard
            </button>
            <button
              onClick={() => setShowConfirmDiscard(false)}
              className="px-3 py-1 text-[11px] font-medium rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
