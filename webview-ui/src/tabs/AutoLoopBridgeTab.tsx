import { useEffect, useRef, useState } from "react";
import type {
  AutoLoopBridgeSessionView,
  PmChatMessageView,
} from "../types/autoloop";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";
import { BridgeSettingsToggle, BridgeSettingsPanel } from "../components/autoloop/BridgeSettingsPanel";
import { ChatBubble, TypingIndicator, WorkerFeedbackBar } from "../components/autoloop/PmChatComponents";

export function AutoLoopBridgeTab() {
  const { state } = useAppState();
  const sessions = state.bridgeSessions ?? {};
  const activeId = state.activeBridgeSessionId;
  const activeSession = activeId ? sessions[activeId] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">🌉 Auto Loop Bridge</h2>
        <div className="flex items-center gap-2">
          <CreateSessionButton />
          <BridgeSettingsToggle />
        </div>
      </div>

      <BridgeSettingsPanel />

      {Object.keys(sessions).length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-[240px_1fr] gap-4">
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onSelect={(id) =>
              postMessage({
                type: "selectAutoLoopBridgeSession",
                sessionId: id,
              } as never)
            }
          />
          {activeSession ? (
            <SessionDetail session={activeSession} />
          ) : (
            <p className="text-[var(--vscode-descriptionForeground)] p-4">
              Select a bridge session to begin.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="text-center py-12 text-[var(--vscode-descriptionForeground)]">
      <p className="text-lg mb-2">No bridge sessions yet.</p>
      <p>Create one to start coordinating with a PM advisor.</p>
    </div>
  );
}

function CreateSessionButton() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [workerLoopId, setWorkerLoopId] = useState("");
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState<"existing" | "new">("new");
  const { state } = useAppState();

  const loopIds = Object.keys(state.loopSessions ?? {});

  const canCreate = mode === "new"
    ? title.trim() && goal.trim()
    : title.trim() && workerLoopId;

  const handleCreate = () => {
    if (!canCreate) return;
    if (mode === "new") {
      postMessage({
        type: "createAutoLoopBridgeSession",
        title,
        workerLoopSessionId: "",
        goal,
        objective: title,
      } as never);
    } else {
      postMessage({
        type: "createAutoLoopBridgeSession",
        title,
        workerLoopSessionId: workerLoopId,
        objective: title,
      } as never);
    }
    setTitle("");
    setWorkerLoopId("");
    setGoal("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1 rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:opacity-90"
      >
        + New Bridge
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode("new")}
          className={`px-2 py-0.5 rounded text-xs ${mode === "new" ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]" : "opacity-60 hover:opacity-100"}`}
        >
          🆕 New Loop
        </button>
        <button
          onClick={() => setMode("existing")}
          className={`px-2 py-0.5 rounded text-xs ${mode === "existing" ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]" : "opacity-60 hover:opacity-100"}`}
        >
          🔗 Existing Loop
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Session title..."
          className="px-2 py-1 rounded bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] flex-1"
        />
        {mode === "new" ? (
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Loop goal / objective..."
            className="px-2 py-1 rounded bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] flex-1"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        ) : (
          <select
            value={workerLoopId}
            onChange={(e) => setWorkerLoopId(e.target.value)}
            title="Select existing loop"
            aria-label="Select existing loop"
            className="px-2 py-1 rounded bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)]"
          >
            <option value="">Loop...</option>
            {loopIds.map((id) => (
              <option key={id} value={id}>
                {id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className="px-3 py-1 rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] disabled:opacity-40"
        >
          Create
        </button>
        <button onClick={() => setOpen(false)} className="px-2 py-1 opacity-60 hover:opacity-100">
          ✕
        </button>
      </div>
    </div>
  );
}

function SessionList({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: Record<string, AutoLoopBridgeSessionView>;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {Object.values(sessions).map((s) => (
        <button
          key={s.sessionId}
          onClick={() => onSelect(s.sessionId)}
          className={`w-full text-left px-3 py-2 rounded text-sm ${
            s.sessionId === activeId
              ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
              : "hover:bg-[var(--vscode-list-hoverBackground)]"
          }`}
        >
          <div className="font-medium truncate">{s.title}</div>
          <div className="text-xs opacity-60">
            {s.status} · {s.pmModelLabel} · {s.workerLoopState === "awaiting" ? "🟢 loop ready" : s.workerLoopState === "active" ? "🔵 working" : s.workerLoopState === "disconnected" ? "🔴 disconnected" : s.workerLoopState}
          </div>
        </button>
      ))}
    </div>
  );
}

function SessionDetail({ session }: { session: AutoLoopBridgeSessionView }) {
  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Header bar — compact status */}
      <div className="flex items-center gap-3 text-xs px-3 py-2 rounded-t border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
        <StatusBadge status={session.status} />
        <span className="opacity-70">
          {session.participants?.pm?.label ?? "PM"} · {session.pmModelLabel}
        </span>
        <span className="opacity-70">
          ⚙️ {session.participants?.worker?.label ?? "Worker"}
        </span>
        <span className="ml-auto opacity-50">
          {session.tokenBudget?.consumedTurns ?? 0}/{session.tokenBudget?.maxSuggestionTurns ?? "∞"} turns
        </span>
      </div>

      {/* Synthesis selector — horizontal compact pills */}
      <SynthesisBar
        syntheses={session.syntheses ?? []}
        activeId={session.activeSynthesisId}
        sessionId={session.sessionId}
      />

      {/* Chat area — takes all available space */}
      <ChatArea
        messages={session.pmChatMessages ?? []}
        sessionId={session.sessionId}
        synthesisId={session.activeSynthesisId}
        status={session.status}
        pmModelLabel={session.pmModelLabel}
        pmProviderLabel={session.pmProviderLabel}
        availableModels={session.availableModels ?? []}
      />

      {/* Worker feedback — collapsible footer */}
      <WorkerFeedbackBar
        draft={session.workerFeedbackDraft ?? ""}
        sessionId={session.sessionId}
        status={session.status}
        workerLoopState={session.workerLoopState}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: "bg-gray-500",
    waiting_pm: "bg-yellow-500 animate-pulse",
    waiting_user: "bg-green-500",
    waiting_worker: "bg-blue-500 animate-pulse",
    closed: "bg-red-500",
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-gray-500"}`}
      title={status} />
  );
}

function SynthesisBar({
  syntheses,
  activeId,
  sessionId,
}: {
  syntheses: AutoLoopBridgeSessionView["syntheses"];
  activeId: string | null;
  sessionId: string;
}) {
  if (syntheses.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--vscode-descriptionForeground)] border-b border-[var(--vscode-panel-border)]">
        ⏳ Waiting for worker synthesis...
      </div>
    );
  }

  return (
    <div className="flex gap-1 px-3 py-1.5 overflow-x-auto border-b border-[var(--vscode-panel-border)]">
      {syntheses.map((s) => (
        <button
          key={s.synthesisId}
          onClick={() =>
            postMessage({
              type: "selectAutoLoopSynthesis",
              sessionId,
              synthesisId: s.synthesisId,
            } as never)
          }
          className={`shrink-0 px-2.5 py-0.5 rounded-full text-xs transition-colors ${
            s.synthesisId === activeId
              ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
              : "bg-[var(--vscode-editor-background)] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)]"
          }`}
          title={s.contentPreview}
        >
          R{s.round}
        </button>
      ))}
    </div>
  );
}

function ChatArea({
  messages,
  sessionId,
  synthesisId,
  status,
  pmModelLabel,
  pmProviderLabel,
  availableModels,
}: {
  messages: PmChatMessageView[];
  sessionId: string;
  synthesisId: string | null;
  status: string;
  pmModelLabel?: string;
  pmProviderLabel?: string;
  availableModels: Array<{ id: string; label: string }>;
}) {
  const [text, setText] = useState("");
  const [localModel, setLocalModel] = useState(pmModelLabel ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pmModelLabel) { setLocalModel(pmModelLabel); }
  }, [pmModelLabel]);

  useEffect(() => {
    if (availableModels.length === 0) { return; }
    const currentIsValid = availableModels.some((model) => model.id === localModel);
    if (currentIsValid) { return; }
    const fallbackModelId = availableModels[0].id;
    setLocalModel(fallbackModelId);
    postMessage({ type: "setAutoLoopPmModel", sessionId, synthesisId: synthesisId ?? undefined, modelId: fallbackModelId } as never);
  }, [availableModels, localModel, sessionId, synthesisId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = () => {
    if (!text.trim() || !synthesisId) return;
    const resolvedModelId = availableModels.some((model) => model.id === localModel)
      ? localModel
      : availableModels[0]?.id ?? localModel;
    postMessage({
      type: "sendAutoLoopPmChat",
      sessionId,
      synthesisId,
      text,
      modelId: resolvedModelId,
    } as never);
    setText("");
  };

  const isWaiting = status === "waiting_pm";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-xs text-[var(--vscode-descriptionForeground)] py-8">
            {synthesisId
              ? "Ask the PM advisor about this synthesis."
              : "Select a synthesis round to start discussing."}
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} sessionId={sessionId} />
        ))}
        {isWaiting && <TypingIndicator />}
      </div>

      {/* Input bar — Copilot style */}
      <div className="border-t border-[var(--vscode-panel-border)] px-3 py-2">
        {/* Model selector */}
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[10px] opacity-50">Model:</span>
          <select
            value={localModel}
            onChange={(e) => {
              setLocalModel(e.target.value);
              postMessage({ type: "setAutoLoopPmModel", sessionId, synthesisId: synthesisId ?? undefined, modelId: e.target.value } as never);
            }}
            title="Select PM model"
            aria-label="Select PM model"
            className="text-[10px] bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded px-1 py-0.5 outline-none"
          >
            {availableModels.length > 0 ? (
              availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))
            ) : (
              <option value={localModel}>{localModel}</option>
            )}
          </select>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] px-2 py-1 focus-within:border-[var(--vscode-focusBorder)]">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={synthesisId ? "Ask the PM advisor..." : "Select a synthesis first"}
            disabled={!synthesisId || isWaiting}
            className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--vscode-input-foreground)] placeholder:text-[var(--vscode-input-placeholderForeground)] disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!text.trim() || !synthesisId || isWaiting}
            className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-30 transition-colors"
            title="Send (Enter)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}


