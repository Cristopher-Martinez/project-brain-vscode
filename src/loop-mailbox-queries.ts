/**
 * Loop Mailbox Queries — read-only query functions for mailbox data.
 *
 * Extracted from `loop-mailbox.ts` to keep the core file under 400 lines.
 * These are pure query/format functions that don't mutate the mailbox.
 */

import type { LoopMessage, LoopMessageType } from "./loop-mailbox";
import { readMailbox } from "./loop-mailbox";

/**
 * Get all messages related to a session (sent, received, broadcasts).
 * Returns newest-first, capped at `limit`.
 */
export function getSessionMessages(
  repoRoot: string,
  sessionId: string,
  limit = 50,
): LoopMessage[] {
  const store = readMailbox(repoRoot);
  return store.messages
    .filter(
      (m) =>
        m.from === sessionId ||
        m.to === sessionId ||
        m.to === null, // broadcasts
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

/**
 * Get all messages in a thread (by replyTo chain).
 */
export function getThread(repoRoot: string, messageId: string): LoopMessage[] {
  const store = readMailbox(repoRoot);
  const thread: LoopMessage[] = [];

  // Find root message
  const root = store.messages.find((m) => m.id === messageId);
  if (root) thread.push(root);

  // Find replies
  const replies = store.messages.filter((m) => m.replyTo === messageId);
  thread.push(...replies);

  return thread.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Format unread messages for injection into agent context.
 */
export function formatUnreadMessages(messages: LoopMessage[]): string {
  if (messages.length === 0) return "";

  const lines = messages.slice(0, 5).map((m) => {
    const from = m.from.substring(0, 8);
    const icon = typeIcon(m.type);
    return `  ${icon} [${from}] ${m.content.substring(0, 100)}`;
  });

  if (messages.length > 5) {
    lines.push(`  ... y ${messages.length - 5} mensaje(s) más`);
  }

  return [
    "",
    `📬 **MAILBOX — ${messages.length} mensaje(s) nuevo(s):**`,
    ...lines,
    "Usa `loopMail read` para ver detalles o `loopMail reply` para responder.",
    "",
  ].join("\n");
}

// ——— Internal ———————————————————————————————————————————
function typeIcon(type: LoopMessageType): string {
  const icons: Record<LoopMessageType, string> = {
    warning: "⚠️", finding: "🔍", question: "❓",
    answer: "💬", broadcast: "📢", conflict: "🔒",
  };
  return icons[type];
}
