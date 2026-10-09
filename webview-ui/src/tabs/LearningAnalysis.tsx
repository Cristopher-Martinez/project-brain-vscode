// Multi-agent analysis panel for Self-Learning tab

import { useEffect, useState } from "react";
import { useAppState } from "../store/AppContext";
import type { SLAnalysisSession } from "../types/messages";
import { SL_AGENTS } from "../types/messages-learning";
import { postMessage } from "../vscode";
import { StatusBadge } from "./LearningHelpers";

// ─── Analysis Form ──────────────────────────────────────────────────────────

function AnalysisForm({
  onStart,
}: {
  onStart: (llm: string, desc: string) => void;
}) {
  const [llmModel, setLlmModel] = useState("copilot/gpt-4o");
  const [targetDesc, setTargetDesc] = useState("");

  return (
    <div className="space-y-3 mb-3">
      <div>
        <label className="text-[11px] opacity-60 block mb-1">LLM Model</label>
        <input
          type="text"
          title="LLM model for analysis"
          value={llmModel}
          onChange={(e) => setLlmModel(e.target.value)}
          placeholder="copilot/gpt-4o"
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded"
        />
      </div>
      <div>
        <label className="text-[11px] opacity-60 block mb-1">
          Describe your target project (what are you building?)
        </label>
        <textarea
          title="Target project description"
          value={targetDesc}
          onChange={(e) => setTargetDesc(e.target.value)}
          rows={3}
          placeholder="Ej: Una app de e-commerce con Next.js, Prisma y Stripe..."
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded resize-none"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onStart(llmModel, targetDesc)}
          disabled={!targetDesc.trim()}
          className="px-4 py-1.5 text-xs rounded bg-purple-600 text-white hover:opacity-80 cursor-pointer disabled:opacity-40">
          Start
        </button>
        <button
          onClick={() => postMessage({ type: "sl:openTemplate" } as never)}
          className="px-3 py-1.5 text-xs rounded border border-vsc-border text-vsc-fg hover:opacity-80 cursor-pointer">
          View Template
        </button>
      </div>
    </div>
  );
}

// ─── Agent Row ──────────────────────────────────────────────────────────────

function AgentRow({
  meta,
  analysis,
  repoId,
  onRunAgent,
  isRunning,
}: {
  meta: (typeof SL_AGENTS)[number];
  analysis: SLAnalysisSession;
  repoId: number;
  onRunAgent: (agentId: string) => void;
  isRunning: boolean;
}) {
  const result = analysis.agents.find((a) => a.agentId === meta.id);
  const status = result?.status ?? "pending";

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-vsc-hover transition-colors">
      <StatusBadge status={status} />
      <span className="text-xs flex-1">{meta.name}</span>
      <span className="text-[10px] opacity-40 hidden sm:inline">{meta.description}</span>
      {status === "pending" && !isRunning && (
        <button
          onClick={() => onRunAgent(meta.id)}
          className="px-2 py-0.5 text-[10px] rounded bg-green-600 text-white hover:opacity-80 cursor-pointer"
          title="Run this agent">
          Run
        </button>
      )}
      {status === "error" && !isRunning && (
        <>
          <span
            className="text-[10px] text-red-400 max-w-25 truncate"
            title={result?.error ?? ""}>
            {result?.error}
          </span>
          <button
            onClick={() => onRunAgent(meta.id)}
            className="px-2 py-0.5 text-[10px] rounded bg-amber-600 text-white hover:opacity-80 cursor-pointer"
            title="Re-run this agent">
            Re-run
          </button>
        </>
      )}
      {status === "running" && (
        <span className="text-[10px] text-yellow-400 animate-pulse">running...</span>
      )}
      {status === "completed" && result?.outputPath && (
        <button
          onClick={() =>
            postMessage({
              type: "sl:openAnalysis",
              repoId,
              agentId: meta.id,
            } as never)
          }
          className="text-[10px] text-blue-400 hover:underline cursor-pointer">
          Open
        </button>
      )}
      {result && result.durationMs > 0 && (
        <span className="text-[10px] opacity-30">
          {(result.durationMs / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  );
}

// ─── Analysis Results ───────────────────────────────────────────────────────

function AnalysisResults({
  analysis,
  repoId,
  onRunAgent,
  onRunAllPending,
}: {
  analysis: SLAnalysisSession;
  repoId: number;
  onRunAgent: (agentId: string) => void;
  onRunAllPending: () => void;
}) {
  const completed = analysis.agents.filter(
    (a) => a.status === "completed",
  ).length;
  const pendingCount = analysis.agents.filter(
    (a) => a.status === "pending" || a.status === "error",
  ).length;
  const isRunning = analysis.status === "running";

  // ETA: average duration of completed agents × pending count
  const completedWithTime = analysis.agents.filter(
    (a) => a.status === "completed" && a.durationMs > 0,
  );
  const avgMs =
    completedWithTime.length > 0
      ? completedWithTime.reduce((s, a) => s + a.durationMs, 0) /
        completedWithTime.length
      : 0;
  const etaMs = avgMs * pendingCount;
  const etaLabel =
    etaMs > 0
      ? etaMs >= 60000
        ? `~${Math.ceil(etaMs / 60000)}m`
        : `~${Math.ceil(etaMs / 1000)}s`
      : null;

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center text-[11px] opacity-60 mb-2">
        <span>
          Model: {analysis.llmModel} | Status: {analysis.status}
        </span>
        <div className="flex items-center gap-2">
          <span>{completed}/10 completed</span>
          {pendingCount > 0 && !isRunning && (
            <>
              {etaLabel && (
                <span className="text-[10px] opacity-40" title="Estimated time for pending agents">
                  ETA {etaLabel}
                </span>
              )}
              <button
                onClick={onRunAllPending}
                className="px-2 py-0.5 text-[10px] rounded bg-green-600 text-white hover:opacity-80 cursor-pointer opacity-100">
                Run {pendingCount} pending
              </button>
            </>
          )}
        </div>
      </div>
      {SL_AGENTS.map((meta) => (
        <AgentRow
          key={meta.id}
          meta={meta}
          analysis={analysis}
          repoId={repoId}
          onRunAgent={onRunAgent}
          isRunning={isRunning}
        />
      ))}
      {isRunning && (
        <p className="text-[11px] text-yellow-400 animate-pulse mt-2">
          Analysis in progress...
        </p>
      )}
    </div>
  );
}

// ─── Analysis Panel ─────────────────────────────────────────────────────────

export function AnalysisPanel({
  repoId,
  onClose,
}: {
  repoId: number;
  onClose: () => void;
}) {
  const { state } = useAppState();
  const analysis = state.slAnalysis;
  const hasResults =
    analysis?.repoId === repoId &&
    (analysis.status === "completed" || analysis.status === "running");

  // Config for running pending agents (model + description)
  const [llmModel, setLlmModel] = useState("copilot/gpt-4o");
  const [targetDesc, setTargetDesc] = useState("");
  const [showRunConfig, setShowRunConfig] = useState(false);

  // Request persisted analysis from disk on mount (if no live session)
  useEffect(() => {
    if (!hasResults) {
      postMessage({ type: "sl:getAnalysisStatus", repoId } as never);
    }
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore model from existing analysis
  useEffect(() => {
    if (analysis?.llmModel && analysis.llmModel !== "(restored from disk)") {
      setLlmModel(analysis.llmModel);
    }
    if (analysis?.targetProjectDescription) {
      setTargetDesc(analysis.targetProjectDescription);
    }
  }, [analysis?.llmModel, analysis?.targetProjectDescription]);

  const handleStart = (llm: string, desc: string) => {
    postMessage({
      type: "sl:analyzeRepo",
      repoId,
      llmModel: llm,
      targetDescription: desc,
    } as never);
  };

  const handleRunAgent = (agentId: string) => {
    if (!targetDesc.trim()) {
      setShowRunConfig(true);
      return;
    }
    postMessage({
      type: "sl:analyzeSingleAgent",
      repoId,
      llmModel,
      targetDescription: targetDesc,
      agentIds: [agentId],
    } as never);
  };

  const handleRunAllPending = () => {
    if (!targetDesc.trim()) {
      setShowRunConfig(true);
      return;
    }
    const pendingIds = (analysis?.agents ?? [])
      .filter((a) => a.status === "pending" || a.status === "error")
      .map((a) => a.agentId);
    if (pendingIds.length === 0) return;
    postMessage({
      type: "sl:analyzeSingleAgent",
      repoId,
      llmModel,
      targetDescription: targetDesc,
      agentIds: pendingIds,
    } as never);
  };

  return (
    <div className="p-4 bg-vsc-header border border-purple-500/30 rounded-lg mb-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold">Multi-Agent Analysis</h3>
        <button
          onClick={onClose}
          className="text-xs opacity-60 hover:opacity-100 cursor-pointer">
          Close
        </button>
      </div>

      {/* Run config — shown when user clicks Run but hasn't set description */}
      {showRunConfig && hasResults && (
        <div className="space-y-2 mb-3 p-3 bg-vsc-bg border border-vsc-border rounded">
          <p className="text-[11px] opacity-60">
            Configure model and description before running agents:
          </p>
          <input
            type="text"
            title="LLM model"
            value={llmModel}
            onChange={(e) => setLlmModel(e.target.value)}
            placeholder="copilot/gpt-4o"
            className="w-full px-2 py-1 text-xs bg-vsc-input-bg border border-vsc-border rounded"
          />
          <textarea
            title="Target project description"
            value={targetDesc}
            onChange={(e) => setTargetDesc(e.target.value)}
            rows={2}
            placeholder="Describe your target project..."
            className="w-full px-2 py-1 text-xs bg-vsc-input-bg border border-vsc-border rounded resize-none"
          />
          <button
            onClick={() => setShowRunConfig(false)}
            disabled={!targetDesc.trim()}
            className="px-3 py-1 text-xs rounded bg-green-600 text-white hover:opacity-80 cursor-pointer disabled:opacity-40">
            Save & Close
          </button>
        </div>
      )}

      {!hasResults && <AnalysisForm onStart={handleStart} />}
      {hasResults && analysis && (
        <AnalysisResults
          analysis={analysis}
          repoId={repoId}
          onRunAgent={handleRunAgent}
          onRunAllPending={handleRunAllPending}
        />
      )}
    </div>
  );
}
