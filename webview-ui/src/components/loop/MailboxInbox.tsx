import { useCallback, useEffect, useRef, useState } from "react";
import type { LoopMailboxMessage } from "../../types/messages";
import { postMessage } from "../../vscode";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const typeConfig: Record<string, { icon: string; label: string; color: string }> = {
  warning: { icon: "🚨", label: "Urgente", color: "text-orange-300" },
  finding: { icon: "🔍", label: "Hallazgo", color: "text-blue-300" },
  question: { icon: "❓", label: "Pregunta", color: "text-purple-300" },
  answer: { icon: "💬", label: "Respuesta", color: "text-green-300" },
  broadcast: { icon: "📢", label: "Broadcast", color: "text-yellow-300" },
  conflict: { icon: "⚠️", label: "Conflicto", color: "text-red-300" },
};

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function senderLabel(from: string): string {
  if (from === "__user__") return "Tú";
  return from.substring(0, 8);
}

// ——— Threading helpers ————————————————————————————————
interface ThreadNode {
  msg: LoopMailboxMessage;
  replies: ThreadNode[];
  depth: number;
}

/** Build a flat list with depth info for indented rendering. */
function buildThreadedList(
  messages: LoopMailboxMessage[],
): { msg: LoopMailboxMessage; depth: number }[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const roots: ThreadNode[] = [];
  const childMap = new Map<string, ThreadNode[]>();

  // Classify each message as root or reply
  for (const msg of messages) {
    const node: ThreadNode = { msg, replies: [], depth: 0 };
    if (msg.replyTo && byId.has(msg.replyTo)) {
      const siblings = childMap.get(msg.replyTo) ?? [];
      siblings.push(node);
      childMap.set(msg.replyTo, siblings);
    } else {
      roots.push(node);
    }
  }

  // Attach replies to their parent nodes
  function attachReplies(node: ThreadNode, depth: number): void {
    node.depth = depth;
    const kids = childMap.get(node.msg.id) ?? [];
    kids.sort((a, b) => a.msg.timestamp - b.msg.timestamp);
    node.replies = kids;
    for (const child of kids) attachReplies(child, depth + 1);
  }
  for (const root of roots) attachReplies(root, 0);

  // Flatten tree to ordered list
  const result: { msg: LoopMailboxMessage; depth: number }[] = [];
  function flatten(node: ThreadNode): void {
    result.push({ msg: node.msg, depth: node.depth });
    for (const child of node.replies) flatten(child);
  }
  for (const root of roots) flatten(root);
  return result;
}

// ─── Message Card ─────────────────────────────────────────────────────────────

function MessageCard({
  msg,
  sessionId,
  onResolve,
  depth = 0,
}: {
  msg: LoopMailboxMessage;
  sessionId: string;
  onResolve: (id: string) => void;
  depth?: number;
}) {
  const config = typeConfig[msg.type] || typeConfig.warning;
  const isFromUser = msg.from === "__user__";
  const isFromSelf = msg.from === sessionId;
  const isResolved = msg.status === "resolved";
  const indent = Math.min(depth, 3);

  return (
    <div
      className={`
        flex flex-col gap-1 p-2.5 rounded-md border transition-all duration-200
        ${isResolved
          ? "bg-vsc-bg/30 border-vsc-border/30 opacity-50"
          : isFromUser
            ? "bg-orange-900/15 border-orange-500/25"
            : isFromSelf
              ? "bg-blue-900/15 border-blue-500/25"
              : "bg-vsc-header/40 border-vsc-border/60"
        }
      `}
      style={indent > 0 ? { marginLeft: `${indent * 16}px` } : undefined}
    >
      {/* Thread connector */}
      {indent > 0 && (
        <div className="flex items-center gap-1 -mt-1 mb-0.5">
          <span className="text-[9px] opacity-25">{"\u21B3"}</span>
          <span className="text-[9px] opacity-25">respuesta</span>
        </div>
      )}
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs flex-shrink-0">{config.icon}</span>
          <span className={`text-[10px] font-semibold ${config.color} flex-shrink-0`}>
            {config.label}
          </span>
          <span className="text-[10px] opacity-40 flex-shrink-0">•</span>
          <span className="text-[10px] opacity-50 truncate">
            {isFromUser ? "Tú" : isFromSelf ? "Este loop" : senderLabel(msg.from)}
            {msg.to === null && !isFromUser && (
              <span className="ml-1 opacity-40">(broadcast)</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Delivery status */}
          {msg.delivered && !isFromSelf && (
            <span
              className="text-[9px] text-green-400/70"
              title="Leído por el agente"
            >
              ✓ Entregado
            </span>
          )}
          {/* Resolve button */}
          {!isResolved && !isFromSelf && (
            <button
              onClick={() => onResolve(msg.id)}
              className="text-[9px] px-1.5 py-0.5 rounded border border-vsc-border/40 
                hover:bg-vsc-hover/60 cursor-pointer transition-colors opacity-50 hover:opacity-100"
              title="Marcar como resuelto"
            >
              ✓
            </button>
          )}
          <span className="text-[9px] opacity-30">{relativeTime(msg.timestamp)}</span>
        </div>
      </div>

      {/* Content */}
      <p className="text-[11px] leading-relaxed opacity-80 break-words m-0">
        {msg.content}
      </p>

      {/* Resolved badge */}
      {isResolved && (
        <span className="text-[9px] opacity-40 italic">✔ Resuelto</span>
      )}
    </div>
  );
}

// ─── Inline Composer ──────────────────────────────────────────────────────────

function InlineComposer({
  sessionId,
  onSend,
}: {
  sessionId: string;
  onSend: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(() => {
    const value = inputRef.current?.value.trim();
    if (!value || sending) return;
    setSending(true);
    postMessage({
      type: "sendLoopMailboxMessage",
      sessionId,
      content: value,
    });
    if (inputRef.current) inputRef.current.value = "";
    setSending(false);
    onSend();
  }, [sessionId, sending, onSend]);

  return (
    <div className="flex gap-1.5 mt-1">
      <input
        ref={inputRef}
        type="text"
        placeholder="Enviar mensaje al agente..."
        className="flex-1 px-2.5 py-1.5 text-[11px] rounded-md border border-vsc-border/50 
          bg-vsc-bg text-vsc-fg placeholder-vsc-fg/30
          focus:border-orange-500/50 focus:outline-none transition-colors"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button
        onClick={handleSend}
        disabled={sending}
        className="px-2.5 py-1.5 text-[11px] font-medium rounded-md 
          bg-orange-700/30 border border-orange-500/40 text-orange-300
          hover:bg-orange-700/50 cursor-pointer transition-colors
          disabled:opacity-30 disabled:cursor-not-allowed"
      >
        📨
      </button>
    </div>
  );
}

// ─── Main Inbox ───────────────────────────────────────────────────────────────

export function MailboxInbox({
  sessionId,
  messages,
  unreadCount,
}: {
  sessionId: string;
  messages: LoopMailboxMessage[];
  unreadCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  // Auto-expand if there are unread messages
  useEffect(() => {
    if (unreadCount > 0 && !expanded) setExpanded(true);
  }, [unreadCount]);

  // Request mailbox on mount and periodically
  useEffect(() => {
    postMessage({ type: "requestMailbox", sessionId });
    const interval = setInterval(() => {
      postMessage({ type: "requestMailbox", sessionId });
    }, 10_000); // refresh every 10s
    return () => clearInterval(interval);
  }, [sessionId]);

  const handleResolve = useCallback(
    (messageId: string) => {
      postMessage({
        type: "resolveMailboxMessage",
        sessionId,
        messageId,
      });
    },
    [sessionId],
  );

  const handleSend = useCallback(() => {
    // Refresh mailbox after sending
    setTimeout(() => {
      postMessage({ type: "requestMailbox", sessionId });
    }, 200);
  }, [sessionId]);

  const filteredMessages = showResolved
    ? messages
    : messages.filter((m) => m.status !== "resolved");

  const threadedMessages = buildThreadedList(filteredMessages);

  const resolvedCount = messages.filter((m) => m.status === "resolved").length;

  if (messages.length === 0 && !expanded) return null;

  return (
    <div className="mb-3 rounded-md border border-vsc-border/40 overflow-hidden transition-all duration-300">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2
          bg-vsc-header/30 hover:bg-vsc-header/50 cursor-pointer transition-colors
          border-0 text-vsc-fg"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs">📬</span>
          <span className="text-[11px] font-semibold">Mailbox</span>
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full 
              bg-orange-600/80 text-white min-w-[18px] text-center animate-pulse">
              {unreadCount}
            </span>
          )}
          {messages.length > 0 && unreadCount === 0 && (
            <span className="text-[10px] opacity-30">
              {messages.length} mensaje{messages.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <span className="text-[10px] opacity-40 transition-transform duration-200"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>
          ▾
        </span>
      </button>

      {/* Expandable body */}
      {expanded && (
        <div className="px-3 pb-3 pt-1">
          {/* Filter toggle */}
          {resolvedCount > 0 && (
            <div className="flex justify-end mb-1.5">
              <button
                onClick={() => setShowResolved(!showResolved)}
                className="text-[9px] px-2 py-0.5 rounded border border-vsc-border/30
                  hover:bg-vsc-hover/40 cursor-pointer transition-colors opacity-50 hover:opacity-80"
              >
                {showResolved ? "Ocultar resueltos" : `Mostrar resueltos (${resolvedCount})`}
              </button>
            </div>
          )}

          {/* Message list */}
          <div className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto pr-1">
            {filteredMessages.length === 0 ? (
              <p className="text-[10px] opacity-30 text-center py-3 m-0">
                Sin mensajes activos
              </p>
            ) : (
              threadedMessages.map(({ msg, depth }) => (
                <MessageCard
                  key={msg.id}
                  msg={msg}
                  sessionId={sessionId}
                  onResolve={handleResolve}
                  depth={depth}
                />
              ))
            )}
          </div>

          {/* Inline composer */}
          <InlineComposer sessionId={sessionId} onSend={handleSend} />
        </div>
      )}
    </div>
  );
}
