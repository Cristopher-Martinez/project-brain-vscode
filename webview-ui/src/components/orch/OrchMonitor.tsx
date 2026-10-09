import { useRef, useState } from "react";
import type {
  MailboxMessage,
  MailboxMessageType,
  MailboxStats,
  OrchRoundState,
  OrchUiState,
  OrchWorkerState,
  PlanApprovalRequest,
} from "../../types/messages";
import { postMessage } from "../../vscode";
import { Markdown } from "../Markdown";

interface OrchMonitorProps {
  session: OrchUiState | null;
  sessionId: string | null;
}

// ─── Worker Card ────────────────────────────────────────────────────────────

function WorkerCard({
  worker,
  selected,
  onSelect,
}: {
  worker: OrchWorkerState;
  selected: boolean;
  onSelect: () => void;
}) {
  const isDone = worker.success !== undefined;
  const label = isDone
    ? worker.success
      ? "✅ Done"
      : "❌ Failed"
    : "⏳ Working";
  const borderClass = isDone
    ? worker.success
      ? "border-l-vsc-success"
      : "border-l-vsc-error"
    : "border-l-vsc-accent";

  const meta: string[] = [];
  if (worker.model) meta.push(`Model: ${worker.model}`);
  if (worker.rounds) meta.push(`Rounds: ${worker.rounds}`);
  if (worker.toolCalls) meta.push(`Tools: ${worker.toolCalls}`);
  if (worker.durationMs) meta.push(`${(worker.durationMs / 1000).toFixed(1)}s`);

  return (
    <div
      onClick={onSelect}
      className={`
        p-3 bg-vsc-header border border-vsc-border border-l-3 ${borderClass} rounded-lg cursor-pointer transition-colors
        ${selected ? "ring-1 ring-vsc-accent bg-vsc-accent/5" : "hover:bg-vsc-hover"}
      `}>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-semibold">
          {worker.agentIcon || "🤖"} {worker.agentName || worker.taskId}
        </span>
        <span className="text-[10px]">{label}</span>
      </div>
      {worker.message && (
        <div className="text-[11px] opacity-70 mb-1 line-clamp-2">
          {worker.message}
        </div>
      )}
      {worker.error && (
        <div className="text-[11px] text-vsc-error mb-1">{worker.error}</div>
      )}
      {meta.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[10px] opacity-50 mt-1">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Console ──────────────────────────────────────────────────────────

function AgentConsole({
  worker,
  log,
}: {
  worker: OrchWorkerState;
  log: string;
}) {
  return (
    <div className="mt-3 border border-vsc-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-vsc-header border-b border-vsc-border text-xs font-semibold">
        <span>{worker.agentIcon || "🤖"}</span>
        <span>{worker.agentName || worker.taskId} — Output</span>
      </div>
      <div className="p-3 text-xs leading-relaxed max-h-64 overflow-y-auto">
        <Markdown content={log || "⏳ Waiting for output..."} />
      </div>
    </div>
  );
}

// ─── Feedback Panel ─────────────────────────────────────────────────────────

function FeedbackPanel({
  synthesis,
  sessionId,
}: {
  synthesis: string;
  sessionId: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const feedback = inputRef.current?.value.trim();
    if (!feedback) {
      inputRef.current?.focus();
      return;
    }
    postMessage({ type: "orchFeedback", feedback, sessionId });
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="mt-4 p-4 bg-vsc-header border-2 border-vsc-accent rounded-lg">
      <div className="text-sm font-semibold mb-2">🧠 Síntesis del agente:</div>
      <div className="text-xs leading-relaxed p-3 bg-vsc-bg border border-vsc-border rounded-md mb-3 max-h-48 overflow-y-auto">
        <Markdown content={synthesis} />
      </div>
      <div className="text-sm font-semibold mb-1.5">
        📨 Tu feedback / instrucciones:
      </div>
      <textarea
        ref={inputRef}
        rows={3}
        placeholder="Escribe tu feedback aquí..."
        className="w-full p-2 text-xs rounded-md border border-vsc-border bg-vsc-bg text-vsc-fg resize-y"
      />
      <button
        onClick={send}
        className="mt-2 px-4 py-1.5 text-xs font-semibold rounded-md bg-vsc-accent text-white hover:opacity-90 cursor-pointer">
        📨 Enviar Feedback
      </button>
    </div>
  );
}

// ─── Plan Approval Panel ────────────────────────────────────────────────────

function PlanApprovalPanel({
  plans,
  sessionId,
}: {
  plans: PlanApprovalRequest[];
  sessionId: string;
}) {
  const pending = plans.filter((p) => p.status === "pending");
  if (pending.length === 0) return null;

  const riskColor = (level: string) =>
    level === "high"
      ? "bg-red-500"
      : level === "medium"
        ? "bg-yellow-500"
        : "bg-green-500";

  return (
    <div className="mt-4 p-4 bg-vsc-header border-2 border-yellow-500 rounded-lg">
      <div className="text-sm font-semibold mb-2">
        📋 Plan Approval — {pending.length} pending
      </div>
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => postMessage({ type: "approveAllPlans", sessionId })}
          className="px-3 py-1 text-[11px] font-semibold rounded bg-green-600 text-white cursor-pointer">
          ✅ Approve All
        </button>
        <button
          onClick={() => {
            const reason = prompt("Reason for rejecting all (optional):") || "";
            postMessage({ type: "rejectAllPlans", sessionId, reason });
          }}
          className="px-3 py-1 text-[11px] font-semibold rounded bg-red-600 text-white cursor-pointer">
          ❌ Reject All
        </button>
      </div>
      {pending.map((plan) => (
        <div
          key={plan.taskId}
          className="mb-2 p-3 bg-vsc-bg border border-vsc-border rounded-md">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-xs">{plan.taskId}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded text-white font-semibold ${riskColor(plan.plan?.riskLevel || "unknown")}`}>
              ⚠ {plan.plan?.riskLevel || "unknown"}
            </span>
          </div>
          {plan.plan?.intendedReads && plan.plan.intendedReads.length > 0 && (
            <div className="text-[10px] opacity-60">
              📖 Reads: {plan.plan.intendedReads.slice(0, 5).join(", ")}
              {plan.plan.intendedReads.length > 5
                ? ` (+${plan.plan.intendedReads.length - 5})`
                : ""}
            </div>
          )}
          {plan.plan?.intendedWrites && plan.plan.intendedWrites.length > 0 && (
            <div className="text-[10px] opacity-60">
              ✏️ Writes: {plan.plan.intendedWrites.slice(0, 5).join(", ")}
              {plan.plan.intendedWrites.length > 5
                ? ` (+${plan.plan.intendedWrites.length - 5})`
                : ""}
            </div>
          )}
          {plan.plan?.intendedTools && plan.plan.intendedTools.length > 0 && (
            <div className="text-[10px] opacity-60">
              🔧 Tools: {plan.plan.intendedTools.slice(0, 8).join(", ")}
            </div>
          )}
          <div className="flex gap-1.5 mt-2">
            <button
              onClick={() =>
                postMessage({
                  type: "approvePlan",
                  sessionId,
                  taskId: plan.taskId,
                })
              }
              className="px-2.5 py-0.5 text-[11px] rounded bg-green-600 text-white cursor-pointer">
              ✅ Approve
            </button>
            <button
              onClick={() => {
                const reason = prompt("Reason for rejection (optional):") || "";
                postMessage({
                  type: "rejectPlan",
                  sessionId,
                  taskId: plan.taskId,
                  reason,
                });
              }}
              className="px-2.5 py-0.5 text-[11px] rounded bg-red-600 text-white cursor-pointer">
              ❌ Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Mailbox Feed ───────────────────────────────────────────────────────────

const TYPE_COLORS: Record<MailboxMessageType, string> = {
  finding: "border-l-cyan-500",
  question: "border-l-yellow-500",
  challenge: "border-l-red-500",
  update: "border-l-gray-500",
  blocker: "border-l-red-600",
  consensus: "border-l-green-500",
};

const TYPE_ICONS: Record<MailboxMessageType, string> = {
  finding: "🔍",
  question: "❓",
  challenge: "⚔️",
  update: "📢",
  blocker: "🚫",
  consensus: "🤝",
};

function MailboxFeed({
  messages,
  stats,
  allMessages,
}: {
  messages: MailboxMessage[];
  stats?: MailboxStats;
  allMessages: MailboxMessage[];
}) {
  if (messages.length === 0) return null;

  // Build reply index
  const replyIndex: Record<string, MailboxMessage[]> = {};
  allMessages.forEach((m) => {
    if (m.replyTo) {
      if (!replyIndex[m.replyTo]) replyIndex[m.replyTo] = [];
      replyIndex[m.replyTo].push(m);
    }
  });

  // Top-level messages
  const topLevel = allMessages.filter(
    (m) => !m.replyTo || !allMessages.some((p) => p.id === m.replyTo),
  );
  const recent = topLevel.slice(-20);

  return (
    <div className="mt-4 p-3 bg-vsc-header border border-vsc-border rounded-lg">
      <div className="text-sm font-semibold mb-2">
        📬 Mailbox Feed ({allMessages.length} messages)
      </div>
      {stats?.byWorker && (
        <div className="text-[10px] opacity-50 mb-2">
          Per-worker:{" "}
          {Object.entries(stats.byWorker)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")}
        </div>
      )}
      <div className="max-h-72 overflow-y-auto space-y-1">
        {recent.map((msg) => (
          <div key={msg.id}>
            <MailboxCard
              msg={msg}
              indent={false}
              allMessages={allMessages}
              replyIndex={replyIndex}
            />
            {replyIndex[msg.id]?.map((reply) => (
              <MailboxCard
                key={reply.id}
                msg={reply}
                indent
                allMessages={allMessages}
                replyIndex={replyIndex}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MailboxCard({
  msg,
  indent,
  allMessages,
  replyIndex,
}: {
  msg: MailboxMessage;
  indent: boolean;
  allMessages: MailboxMessage[];
  replyIndex: Record<string, MailboxMessage[]>;
}) {
  const borderClass = TYPE_COLORS[msg.type] || "border-l-gray-500";
  const icon = TYPE_ICONS[msg.type] || "💬";
  const parent =
    indent && msg.replyTo
      ? allMessages.find((p) => p.id === msg.replyTo)
      : null;
  const replies = !indent ? replyIndex[msg.id] : undefined;

  return (
    <div
      className={`py-1 px-2 ${indent ? "ml-4 opacity-90" : ""} ${borderClass} border-l-3 bg-vsc-bg rounded-r text-[11px]`}>
      <span className="font-semibold">
        {icon} {msg.from || "unknown"}
      </span>
      {msg.to && <span className="opacity-70"> → {msg.to}</span>}
      <span className="opacity-40 ml-2 text-[10px]">[{msg.type}]</span>
      {indent && parent && (
        <span className="opacity-50 ml-1.5 text-[10px]">
          ↩️ re: {parent.from}
        </span>
      )}
      {!indent && replies && replies.length > 0 && (
        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-green-600 text-white">
          ✅ {replies.length}{" "}
          {replies.length === 1 ? "respuesta" : "respuestas"}
        </span>
      )}
      {!indent && !replies?.length && msg.type === "question" && (
        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500 text-gray-900">
          ⏳ Sin respuesta
        </span>
      )}
      <div className="mt-0.5 opacity-80">{msg.content}</div>
    </div>
  );
}

// ─── Workers Grid ───────────────────────────────────────────────────────────

function WorkersRound({
  round,
  selectedWorker,
  onSelect,
  label,
}: {
  round: OrchRoundState;
  selectedWorker: string | null;
  onSelect: (w: OrchWorkerState) => void;
  label: string;
}) {
  if (!round.workers || round.workers.length === 0) return null;

  return (
    <div>
      <h4 className="text-xs font-semibold mb-1 mt-3">{label}</h4>
      <p className="text-[11px] opacity-50 mb-2">
        Click an agent to view its full output below
      </p>
      <div className="grid grid-cols-1 gap-2">
        {round.workers.map((w) => (
          <WorkerCard
            key={w.taskId}
            worker={w}
            selected={selectedWorker === w.taskId}
            onSelect={() => onSelect(w)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Monitor ───────────────────────────────────────────────────────────

export function OrchMonitor({ session, sessionId }: OrchMonitorProps) {
  const [selectedWorker, setSelectedWorker] = useState<OrchWorkerState | null>(
    null,
  );

  if (!session || session.state === "idle") {
    return (
      <div className="text-center py-10 opacity-50">
        <div className="text-3xl mb-2">⚓</div>
        <p className="text-xs">No active orchestration</p>
        <p className="text-[11px] mt-1 opacity-60">
          Select agents, set a goal, and launch
        </p>
      </div>
    );
  }

  const isActive = session.state === "active" || session.state === "planning";
  const statusLabel =
    session.state === "completed"
      ? "✅ Completed"
      : session.state === "active"
        ? "⏳ Active"
        : session.state === "planning"
          ? "🧭 Planning"
          : session.state;
  const modeLabel =
    session.mode === "sequential" ? "🔗 Sequential" : "⚡ Parallel";

  const selectedWorkerLog = selectedWorker
    ? session.workerLogs?.[selectedWorker.taskId]
    : null;

  // Determine which round to show workers from
  const currentRound = session.currentRound;
  const lastCompleted = session.completedRounds?.length
    ? session.completedRounds[session.completedRounds.length - 1]
    : null;

  return (
    <div>
      {/* Banner */}
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border border-vsc-border mb-3 ${
          isActive ? "bg-vsc-accent/10 border-vsc-accent" : "bg-vsc-header"
        }`}>
        {isActive && (
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
        )}
        <span
          className="text-sm font-semibold flex-1"
          title={session.goal || "Orchestration"}>
          {(session.goal || "Orchestration").substring(0, 250)}
          {(session.goal || "").length > 250 ? "…" : ""}
        </span>
        <span className="text-[11px] opacity-70">{modeLabel}</span>
        <span className="text-[10px]">{statusLabel}</span>
      </div>

      {/* Completed rounds count */}
      {session.completedRounds && session.completedRounds.length > 0 && (
        <div className="text-xs opacity-60 mb-2">
          Completed rounds: {session.completedRounds.length}
        </div>
      )}

      {/* Prompt enhancement */}
      {session.originalPrompt && session.enhancedPrompt && (
        <div className="mb-3 p-3 bg-vsc-header border border-vsc-border rounded-lg text-xs">
          <div className="font-semibold text-vsc-accent mb-2">
            🪄 Prompt Enhancement
          </div>
          <div className="mb-1.5">
            <span className="text-[11px] opacity-60">Original:</span>
            <div className="mt-0.5 p-2 bg-vsc-bg rounded opacity-70">
              {session.originalPrompt}
            </div>
          </div>
          <div>
            <span className="text-[11px] opacity-60">Mejorado:</span>
            <div className="mt-0.5 p-2 bg-vsc-bg rounded border-l-2 border-l-vsc-accent">
              {session.enhancedPrompt}
            </div>
          </div>
        </div>
      )}

      {/* Current round workers */}
      {currentRound && (
        <WorkersRound
          round={currentRound}
          selectedWorker={selectedWorker?.taskId || null}
          onSelect={setSelectedWorker}
          label={`Round ${currentRound.roundNumber}`}
        />
      )}

      {/* Last completed round (if no current) */}
      {!currentRound && lastCompleted && (
        <WorkersRound
          round={lastCompleted}
          selectedWorker={selectedWorker?.taskId || null}
          onSelect={setSelectedWorker}
          label={`Last Round (${lastCompleted.roundNumber})`}
        />
      )}

      {/* Agent Console */}
      {selectedWorker && (
        <AgentConsole worker={selectedWorker} log={selectedWorkerLog || ""} />
      )}

      {/* Token summary */}
      {(session.totalTokensIn || session.totalTokensOut) && (
        <div className="mt-3 text-[11px] opacity-60">
          Tokens: {((session.totalTokensIn || 0) / 1000).toFixed(1)}K in /{" "}
          {((session.totalTokensOut || 0) / 1000).toFixed(1)}K out
        </div>
      )}

      {/* Summary */}
      {session.summary && (
        <div className="mt-4 p-3 bg-vsc-header border border-vsc-border rounded-lg text-xs leading-relaxed">
          <Markdown content={session.summary} />
        </div>
      )}

      {/* Feedback Panel */}
      {session.awaitingFeedback && session.pendingSynthesis && sessionId && (
        <FeedbackPanel
          synthesis={session.pendingSynthesis}
          sessionId={sessionId}
        />
      )}

      {/* Plan Approval */}
      {session.pendingPlanApprovals &&
        session.pendingPlanApprovals.length > 0 &&
        sessionId && (
          <PlanApprovalPanel
            plans={session.pendingPlanApprovals}
            sessionId={sessionId}
          />
        )}

      {/* Mailbox Feed */}
      {session.mailboxMessages && session.mailboxMessages.length > 0 && (
        <MailboxFeed
          messages={session.mailboxMessages}
          stats={session.mailboxStats}
          allMessages={session.mailboxMessages}
        />
      )}
    </div>
  );
}
