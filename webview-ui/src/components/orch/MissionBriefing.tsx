import { useRef, useState } from "react";
import { postMessage } from "../../vscode";
import type { AvailableModel, OrchUiState } from "../../types/messages";
import type { TeamSlot } from "../../tabs/OrchestrationTab";

interface MissionBriefingProps {
  teamSlots: TeamSlot[];
  models: AvailableModel[];
  activeSession: OrchUiState | null;
  activeSessionId: string | null;
}

export function MissionBriefing({ teamSlots, models, activeSession, activeSessionId }: MissionBriefingProps) {
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const orchModelRef = useRef<HTMLSelectElement>(null);
  const [mode, setMode] = useState<"parallel" | "sequential">("parallel");
  const [useMailbox, setUseMailbox] = useState(false);
  const [planApproval, setPlanApproval] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [useBranchIsolation, setUseBranchIsolation] = useState(false);

  const isActive = !!activeSession &&
    (activeSession.state === "active" || activeSession.state === "planning");

  const launchSession = () => {
    const goal = goalRef.current?.value.trim();
    if (!goal) { goalRef.current?.focus(); return; }
    if (teamSlots.length === 0) return;

    const team = teamSlots.map(slot => {
      const sel = document.querySelector(`.ts-model-select[data-slot="${slot.slotId}"]`) as HTMLSelectElement | null;
      const modelId = sel?.value || "";
      const opt = sel?.options[sel.selectedIndex];
      const tier = opt?.dataset.tier || "standard";
      return { agentId: slot.agent.id, modelId, tier };
    });

    const orchestratorModelId = orchModelRef.current?.value || "";

    postMessage({
      type: "createOrchSession",
      goal,
      team,
      mode,
      orchestratorModelId,
      useMailbox,
      requiresPlanApproval: planApproval,
      autoApproveLowRisk: autoApprove,
      enhancePrompt,
      useBranchIsolation,
    });

    if (goalRef.current) goalRef.current.value = "";
  };

  const addTask = () => {
    if (!activeSessionId) return;
    const prompt = goalRef.current?.value.trim();
    if (!prompt) { goalRef.current?.focus(); return; }
    postMessage({ type: "addOrchTask", prompt, sessionId: activeSessionId });
    if (goalRef.current) goalRef.current.value = "";
  };

  const endSession = () => {
    if (!activeSessionId) return;
    postMessage({ type: "endOrchSession", sessionId: activeSessionId });
  };

  return (
    <div>
      {/* Mode Toggle */}
      <div className="flex items-center gap-4 mb-2">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="radio"
            name="orch-mode"
            checked={mode === "parallel"}
            onChange={() => setMode("parallel")}
          />
          ⚡ Parallel
        </label>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="radio"
            name="orch-mode"
            checked={mode === "sequential"}
            onChange={() => setMode("sequential")}
          />
          🔗 Sequential (Pipeline)
        </label>
      </div>

      {/* Orchestrator Model */}
      <div className="flex items-center gap-2 mb-2">
        <label className="text-[11px] opacity-60">🧠 Orchestrator LLM:</label>
        <select
          ref={orchModelRef}
          className="flex-1 text-[11px] p-1 rounded border border-vsc-border bg-vsc-bg text-vsc-fg"
        >
          <option value="">(auto — VS Code default)</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.vendor} / {m.family} [{m.tier}]
            </option>
          ))}
        </select>
      </div>

      {/* Feature Toggles */}
      <div className="flex flex-wrap gap-3 mb-3 text-[11px]">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={useMailbox} onChange={e => setUseMailbox(e.target.checked)} />
          📬 Mailbox <span className="opacity-40 text-[10px]">(inter-agent messaging)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={planApproval} onChange={e => {
            setPlanApproval(e.target.checked);
            if (!e.target.checked) setAutoApprove(false);
          }} />
          📋 Plan Approval <span className="opacity-40 text-[10px]">(two-phase execution)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={autoApprove} disabled={!planApproval} onChange={e => setAutoApprove(e.target.checked)} />
          ✅ Auto-approve low-risk
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={enhancePrompt} onChange={e => setEnhancePrompt(e.target.checked)} />
          🪄 Enhance Prompt <span className="opacity-40 text-[10px]">(AI-optimized prompt)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={useBranchIsolation} onChange={e => setUseBranchIsolation(e.target.checked)} />
          🌿 Branch Isolation <span className="opacity-40 text-[10px]">(fork-based isolation per worker)</span>
        </label>
      </div>

      {/* Goal Input */}
      <textarea
        ref={goalRef}
        placeholder="Describe the goal for your agent team..."
        className="w-full p-2 text-xs rounded-md border border-vsc-border bg-vsc-bg text-vsc-fg resize-y mb-2"
        rows={3}
      />

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button
          onClick={launchSession}
          className="px-4 py-1.5 text-xs font-semibold rounded-md bg-vsc-btn-bg text-vsc-btn-fg hover:opacity-90 cursor-pointer"
        >
          🚀 Launch Session
        </button>
        {isActive && (
          <>
            <button
              onClick={addTask}
              className="px-4 py-1.5 text-xs font-semibold rounded-md bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-90 cursor-pointer"
            >
              ➕ Add Task
            </button>
            <button
              onClick={endSession}
              className="px-4 py-1.5 text-xs font-semibold rounded-md bg-vsc-error text-white hover:opacity-90 cursor-pointer"
            >
              🛑 End Session
            </button>
          </>
        )}
      </div>
    </div>
  );
}
