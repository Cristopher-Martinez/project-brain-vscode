import { useEffect, useMemo, useRef, useState } from "react";
import { EndConfirmDialog } from "../components/loop";
import { LoopActiveTable } from "../components/loop/LoopActiveTable";
import { LoopHibernatedTable } from "../components/loop/LoopHibernatedTable";
import { LoopFinalizedTable } from "../components/loop/LoopFinalizedTable";
import { EnrichPreview } from "../components/loop/EnrichPreview";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";
import type { EnrichResultPayload } from "../types/messages";

type SubTab = "active" | "hibernated" | "finalized";

// ─── Main Component ──────────────────────────────────────────

export function LoopTab() {
  const { state, dispatch } = useAppState();
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const [useBranchIsolation, setUseBranchIsolation] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [enableCommitGate, setEnableCommitGate] = useState(false);
  const [enrichEnabled, setEnrichEnabled] = useState(false);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichResult, setEnrichResult] = useState<EnrichResultPayload | null>(null);
  const [confirmEndSessionId, setConfirmEndSessionId] = useState<string | null>(
    null,
  );
  const [subTab, setSubTab] = useState<SubTab>("active");

  // Count badges for sub-tab labels
  const activeCount = useMemo(() => {
    return Object.values(state.loopSessions).filter((s) =>
      ["spawning", "active", "awaiting", "completed", "disconnected"].includes(
        s.state,
      ),
    ).length;
  }, [state.loopSessions]);

  const awaitingCount = useMemo(() => {
    return Object.values(state.loopSessions).filter(
      (s) => s.state === "awaiting",
    ).length;
  }, [state.loopSessions]);

  const hibernatedCount =
    state.hibernatedLoops.length + state.interruptedLoops.length;

  const finalizedCount = state.finalizedLoops.length;

  // ─── Effects ───────────────────────────────────────────────

  useEffect(() => {
    postMessage({ type: "requestPendingBranches" });
    postMessage({ type: "requestHibernatedLoops" });
    postMessage({ type: "requestFinalizedLoops" });
    postMessage({ type: "requestAllLoopStates" });
  }, [Object.keys(state.loopSessions).length]);

  // Request activity feed for active session
  useEffect(() => {
    if (state.activeLoopSessionId) {
      postMessage({
        type: "requestActivityFeed",
        sessionId: state.activeLoopSessionId,
      });
    }
  }, [state.activeLoopSessionId]);

  useEffect(() => {
    if (useBranchIsolation) {
      postMessage({ type: "requestAvailableBranches" });
    } else {
      setBaseBranch("");
    }
  }, [useBranchIsolation]);

  // ─── Handlers ──────────────────────────────────────────────

  const launchLoop = () => {
    const goal = goalRef.current?.value.trim();
    if (!goal) {
      goalRef.current?.focus();
      return;
    }

    // If enricher is enabled and no enrichment result yet, request enrichment first
    if (enrichEnabled && !enrichResult) {
      setEnrichLoading(true);
      postMessage({ type: "enrichGoal", goal });
      return;
    }

    postMessage({
      type: "createLoopSession",
      goal: enrichResult ? enrichResult.pack.rewrittenPrompt : goal,
      useBranchIsolation,
      ...(useBranchIsolation && baseBranch ? { baseBranch } : {}),
      ...(enableCommitGate ? { commitBypass: false } : {}),
    });
    if (goalRef.current) goalRef.current.value = "";
    setEnrichResult(null);
  };

  const launchWithEnriched = (rewrittenPrompt: string) => {
    postMessage({
      type: "createLoopSession",
      goal: rewrittenPrompt,
      useBranchIsolation,
      ...(useBranchIsolation && baseBranch ? { baseBranch } : {}),
      ...(enableCommitGate ? { commitBypass: false } : {}),
    });
    if (goalRef.current) goalRef.current.value = "";
    setEnrichResult(null);
  };

  // Listen for enricher messages (goal-level)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "enrichResult" && msg.source === "goal") {
        setEnrichResult(msg.result);
        setEnrichLoading(false);
      } else if (msg.type === "enrichLoading") {
        setEnrichLoading(msg.loading);
      } else if (msg.type === "enrichError") {
        setEnrichLoading(false);
        setEnrichResult(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const confirmEnd = () => {
    if (!confirmEndSessionId) return;
    postMessage({ type: "endLoopSession", sessionId: confirmEndSessionId });
    dispatch({ type: "REMOVE_LOOP", sessionId: confirmEndSessionId });
    setConfirmEndSessionId(null);
  };

  const selectSession = (sid: string) => {
    dispatch({ type: "SET_ACTIVE_LOOP", sessionId: sid });
  };

  const handleEndRequest = (sid: string) => {
    const session = state.loopSessions[sid];
    if (session?.state === "active" || session?.state === "awaiting") {
      setConfirmEndSessionId(sid);
      return;
    }
    dispatch({ type: "REMOVE_LOOP", sessionId: sid });
  };

  const handleDismiss = (sid: string) => {
    dispatch({ type: "REMOVE_LOOP", sessionId: sid });
  };

  // ─── Render ────────────────────────────────────────────────

  return (
    <div>
      {/* End Confirmation Dialog */}
      {confirmEndSessionId && (
        <EndConfirmDialog
          onConfirm={confirmEnd}
          onCancel={() => setConfirmEndSessionId(null)}
        />
      )}

      {/* ─── 1. Launch Area ─── */}
      <div className="mb-5">
        <h3 className="text-sm font-semibold mb-1">🔁 Loop Mode</h3>
        <p className="text-[11px] opacity-50 mb-2">
          Define un objetivo y el agente trabajará en un ciclo continuo de
          procesamiento → síntesis → feedback.
        </p>
        <textarea
          ref={goalRef}
          placeholder="Describe the goal for the feedback loop..."
          aria-label="Loop goal description"
          className="w-full p-2 text-xs rounded-md border border-vsc-border bg-vsc-bg text-vsc-fg resize-y mb-2"
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              launchLoop();
            }
          }}
        />
        <div className="flex flex-wrap gap-3 mb-2 text-[11px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={useBranchIsolation}
              onChange={(e) => setUseBranchIsolation(e.target.checked)}
            />
            🌿 Branch Isolation{" "}
            <span className="opacity-40 text-[10px]">
              (aísla cambios en una rama)
            </span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={enableCommitGate}
              onChange={(e) => setEnableCommitGate(e.target.checked)}
            />
            🔒 Activate Commit Gate{" "}
            <span className="opacity-40 text-[10px]">
              (bloquear sin commits)
            </span>
          </label>
          <label data-testid="enrich-checkbox" className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={enrichEnabled}
              onChange={(e) => setEnrichEnabled(e.target.checked)}
            />
            🧠 Enrich with Memory{" "}
            <span className="opacity-40 text-[10px]">
              (contexto automático)
            </span>
          </label>
        </div>
        {useBranchIsolation && (
          <div className="mb-2">
            <label className="text-[11px] opacity-70 block mb-1">
              Base branch:
            </label>
            <select
              aria-label="Base branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-full p-1.5 text-xs rounded-md border border-vsc-border bg-vsc-bg text-vsc-fg">
              <option value="">Current branch (default)</option>
              {state.availableBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Enrich preview */}
        <EnrichPreview
          result={enrichResult}
          source="goal"
          onAccept={launchWithEnriched}
          onReject={() => setEnrichResult(null)}
          loading={enrichLoading}
        />

        <div className="flex items-center gap-2">
          <button
            onClick={launchLoop}
            className="px-4 py-1.5 text-xs font-semibold rounded-md bg-vsc-btn-bg text-vsc-btn-fg hover:opacity-90 cursor-pointer">
            🚀 Launch Loop
          </button>
          <span className="text-[10px] opacity-30">Ctrl+Enter</span>
        </div>
      </div>

      {/* ─── 2. Sub-tabs ─── */}
      <div className="border-b border-vsc-border mb-4 flex gap-0">
        <SubTabButton
          active={subTab === "active"}
          onClick={() => setSubTab("active")}
          label="🔄 Activos"
          count={activeCount}
          pulse={awaitingCount > 0}
        />
        <SubTabButton
          active={subTab === "hibernated"}
          onClick={() => setSubTab("hibernated")}
          label="💤 Hibernados"
          count={hibernatedCount}
        />
        <SubTabButton
          active={subTab === "finalized"}
          onClick={() => setSubTab("finalized")}
          label="✅ Finalizados"
          count={finalizedCount}
        />
      </div>

      {/* ─── 3. Table content ─── */}
      {subTab === "active" && (
        <LoopActiveTable
          sessions={state.loopSessions}
          activeId={state.activeLoopSessionId}
          onSelect={selectSession}
          onEnd={handleEndRequest}
          onDismiss={handleDismiss}
          globalMaxCycles={state.loopMaxCyclesDefault}
          mailboxBySession={state.mailboxBySession}
          activityBySession={state.activityBySession}
        />
      )}

      {subTab === "hibernated" && (
        <LoopHibernatedTable
          hibernated={state.hibernatedLoops}
          interrupted={state.interruptedLoops}
        />
      )}

      {subTab === "finalized" && (
        <LoopFinalizedTable finalized={state.finalizedLoops} />
      )}
    </div>
  );
}

// ─── Sub-tab button ──────────────────────────────────────────

function SubTabButton({
  active,
  onClick,
  label,
  count,
  pulse,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  pulse?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium transition-colors cursor-pointer border-b-2 ${
        active
          ? "border-vsc-accent text-vsc-fg"
          : "border-transparent text-vsc-fg/50 hover:text-vsc-fg/80"
      }`}>
      {label}
      {count > 0 && (
        <span
          className={`ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full ${
            active ? "bg-vsc-accent/20 text-vsc-accent" : "bg-vsc-header"
          } ${pulse ? "animate-pulse" : ""}`}>
          {count}
        </span>
      )}
    </button>
  );
}
