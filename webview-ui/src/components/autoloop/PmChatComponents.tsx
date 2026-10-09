import { useState, useEffect } from "react";
import type { PmChatMessageView, PmSuggestionView } from "../../types/autoloop";
import { Markdown } from "../Markdown";
import { postMessage } from "../../vscode";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  CheckCircle,
  XCircle,
  HelpCircle,
  Lightbulb,
  Brain,
  Send,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

/* --- Helpers ---------------------------------------------------------- */

function relativeTime(ts: number): string {
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 60) return "ahora";
  if (delta < 3600) return `hace ${Math.floor(delta / 60)} min`;
  if (delta < 86400) return `hace ${Math.floor(delta / 3600)}h`;
  return new Date(ts).toLocaleDateString();
}

function isErrorMessage(text: string): boolean {
  return /^\[Error\]/i.test(text);
}

/* --- ChatBubble ------------------------------------------------------- */

export function ChatBubble({
  message,
  sessionId,
}: {
  message: PmChatMessageView;
  sessionId: string;
}) {
  const isUser = message.role === "user";
  const isError = !isUser && isErrorMessage(message.text);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const bubbleBase = isUser
    ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] rounded-tr-sm"
    : "bg-[var(--vscode-editorWidget-background)] text-[var(--vscode-editor-foreground)] rounded-tl-sm";
  const errorClass = isError ? "pm-error-bubble" : "";

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
        isUser
          ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
          : "bg-[var(--vscode-editorWidget-background)] text-[var(--vscode-editor-foreground)]"
      }`}>
        {isUser ? "U" : isError ? <AlertTriangle size={12} /> : "PM"}
      </div>

      {/* Content */}
      <div className={`flex-1 max-w-[85%] ${isUser ? "text-right" : ""}`}>
        <div className={`group relative inline-block text-left px-3 py-2 rounded-xl text-sm leading-relaxed ${bubbleBase} ${errorClass}`}>
          {/* Message body */}
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.text}</div>
          ) : isError ? (
            <ErrorContent text={message.text} />
          ) : (
            <div className="pm-bubble">
              <Markdown content={message.text} />
            </div>
          )}

          {/* Copy button (PM only) */}
          {!isUser && !isError && (
            <button
              onClick={handleCopy}
              className="absolute top-1 right-1 opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-editor-background)] text-[var(--vscode-descriptionForeground)]"
              title="Copiar"
            >
              {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
            </button>
          )}
        </div>

        {/* PM Suggestion card */}
        {message.suggestion && !isUser && (
          message.suggestion.intent === 'delegate'
            ? <SuggestionInline suggestion={message.suggestion} sessionId={sessionId} />
            : null
        )}

        {/* Timestamp */}
        <div className="text-[10px] opacity-40 mt-0.5 px-1">
          {relativeTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

/* --- ErrorContent ----------------------------------------------------- */

function ErrorContent({ text }: { text: string }) {
  const lines = text.split("|").map(s => s.trim());
  const mainError = lines[0] || text;
  const details = lines.slice(1);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 font-medium text-[var(--vscode-errorForeground,#f14c4c)]">
        <AlertTriangle size={14} className="inline" />
        <span>{mainError}</span>
      </div>
      {details.length > 0 && (
        <div className="text-[11px] opacity-75 space-y-0.5 pl-5">
          {details.map((d, i) => (
            <div key={i} className="font-mono">{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --- SuggestionInline ------------------------------------------------- */

export function SuggestionInline({
  suggestion,
  sessionId,
}: {
  suggestion: PmSuggestionView;
  sessionId: string;
}) {
  const riskMeta: Record<string, { color: string; border: string; icon: JSX.Element }> = {
    low: { color: "text-green-400", border: "border-green-700/30", icon: <CheckCircle size={10} /> },
    medium: { color: "text-yellow-400", border: "border-yellow-700/30", icon: <AlertTriangle size={10} /> },
    high: { color: "text-red-400", border: "border-red-700/30", icon: <XCircle size={10} /> },
  };
  const risk = riskMeta[suggestion.risk] ?? { color: "text-gray-400", border: "border-gray-600", icon: <HelpCircle size={10} /> };

  return (
    <div className={`mt-1.5 ml-1 p-2.5 rounded-lg border bg-[var(--vscode-editor-background)] text-xs space-y-1.5 ${risk.border}`}>
      {/* Header: title + risk badge */}
      <div className="flex items-center justify-between">
        <span className="font-semibold text-[var(--vscode-editor-foreground)]">
          <Lightbulb size={12} className="inline mr-1" /> Suggestion
        </span>
        <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${risk.color}`}>
          {risk.icon} {suggestion.risk}
        </span>
      </div>

      {/* Recommendation � with markdown */}
      <div className="pm-bubble text-[var(--vscode-editor-foreground)] opacity-90 leading-snug">
        <Markdown content={suggestion.recommendation} />
      </div>

      {/* Reasoning � collapsible */}
      {suggestion.reasoning && (
        <details className="text-[var(--vscode-descriptionForeground)]">
          <summary className="cursor-pointer hover:opacity-80 text-[10px] uppercase tracking-wide">
            <Brain size={10} className="inline mr-1" /> Reasoning
          </summary>
          <div className="mt-1 leading-snug pm-bubble">
            <Markdown content={suggestion.reasoning} />
          </div>
        </details>
      )}

      {/* Promote to worker feedback */}
      {suggestion.suggestedWorkerFeedback && (!suggestion.intent || suggestion.intent === "delegate") && (
        <button
          onClick={() =>
            postMessage({
              type: "promotePmSuggestionToWorkerFeedback",
              sessionId,
              suggestionId: suggestion.id,
            } as never)
          }
          className="w-full mt-1 px-2 py-1 rounded-md bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:opacity-90 transition-opacity text-xs font-medium"
        >
          ? Use as Worker Feedback
        </button>
      )}
    </div>
  );
}

/* --- TypingIndicator -------------------------------------------------- */

export function TypingIndicator() {
  return (
    <div className="flex gap-2">
      <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-[var(--vscode-editorWidget-background)] text-[var(--vscode-editor-foreground)]">
        PM
      </div>
      <div className="inline-flex items-center gap-1 px-3 py-2 rounded-xl rounded-tl-sm bg-[var(--vscode-editorWidget-background)]">
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--vscode-descriptionForeground)]" />
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--vscode-descriptionForeground)]" />
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--vscode-descriptionForeground)]" />
      </div>
    </div>
  );
}

/* --- WorkerFeedbackBar ------------------------------------------------ */

export function WorkerFeedbackBar({
  draft,
  sessionId,
  status,
  workerLoopState,
}: {
  draft: string;
  sessionId: string;
  status: string;
  workerLoopState?: string;
}) {
  const [text, setText] = useState(draft);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (draft && draft !== text) {
      setText(draft);
      setExpanded(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const dispatch = () => {
    if (!text.trim()) return;
    postMessage({
      type: "dispatchAutoLoopWorkerFeedback",
      sessionId,
      text,
    } as never);
    setText("");
    setExpanded(false);
  };

  return (
    <div className="border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-editor-foreground)] transition-colors"
      >
        <span><Send size={12} className="inline mr-1" /> Worker Feedback {text.trim() ? `(${text.trim().length} chars)` : ""}</span>
        <span>{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              postMessage({
                type: "updateAutoLoopWorkerFeedbackDraft",
                sessionId,
                text: e.target.value,
              } as never);
            }}
            placeholder="Type feedback for the worker..."
            rows={3}
            className="w-full px-2 py-1.5 rounded-md bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] resize-none text-sm focus:border-[var(--vscode-focusBorder)] outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={dispatch}
              disabled={!text.trim() || status === "waiting_worker" || (workerLoopState !== "awaiting" && workerLoopState !== undefined)}
              className="px-3 py-1 rounded-md bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] disabled:opacity-40 text-xs font-medium hover:opacity-90 transition-opacity"
              title={workerLoopState && workerLoopState !== "awaiting" ? `Loop is ${workerLoopState} — cannot send feedback` : "Send feedback to the worker loop"}
            >
              {workerLoopState === "disconnected" ? "Loop Disconnected" : workerLoopState === "active" ? "Worker Processing..." : "Dispatch to Worker"}
            </button>
            {workerLoopState === "disconnected" && (
              <button
                onClick={() => postMessage({ type: "reconnectAutoLoopWorker", sessionId } as never)}
                className="px-3 py-1 rounded-md bg-[var(--vscode-statusBarItem-warningBackground)] text-[var(--vscode-statusBarItem-warningForeground)] text-xs font-medium hover:opacity-90 transition-opacity"
                title="Reconnect the disconnected loop with a new session"
              >
                🔄 Reconnect Loop
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}