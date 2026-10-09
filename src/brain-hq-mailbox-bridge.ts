/**
 * Brain HQ ↔ Loop Mailbox bridge.
 * Pushes mailbox state to the webview and handles mailbox-related
 * messages from the webview panel. Includes file watcher for real-time
 * delivery confirmation when the hook marks messages as read.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { getLoopsDir } from "./brain-paths";
import { log } from "./logger";
import type { LoopMessage } from "./loop-mailbox";
import { getSessionMessages, getUnreadCount } from "./loop-mailbox";

// ——— File watcher for delivery confirmation push ———————————

const activeWatchers = new Map<string, fs.FSWatcher>();
const watchDebounce = new Map<string, NodeJS.Timeout>();

/**
 * Start watching mailbox.json for external changes (hook marks read).
 * Pushes updates to the webview whenever the file changes.
 */
export function startMailboxWatcher(
  repoRoot: string,
  sessionId: string,
  instance: BrainHqInstance,
): void {
  const key = `${repoRoot}::${sessionId}`;
  if (activeWatchers.has(key)) return; // already watching

  const mailboxFile = path.join(getLoopsDir(repoRoot), "mailbox.json");
  if (!fs.existsSync(mailboxFile)) return;

  try {
    const watcher = fs.watch(mailboxFile, () => {
      // Debounce: multiple rapid writes → single push
      const existing = watchDebounce.get(key);
      if (existing) clearTimeout(existing);
      watchDebounce.set(
        key,
        setTimeout(() => {
          pushMailboxToWebview(repoRoot, sessionId, instance);
          watchDebounce.delete(key);
        }, 300),
      );
    });
    activeWatchers.set(key, watcher);
    log(
      `[MailboxBridge] Watching mailbox for session ${sessionId.substring(0, 8)}`,
    );
  } catch (err) {
    log(
      `[MailboxBridge] fs.watch failed for session ${sessionId.substring(0, 8)}: ${err}`,
    );
  }
}

/**
 * Stop watching mailbox for a session (cleanup on session end).
 */
export function stopMailboxWatcher(repoRoot: string, sessionId: string): void {
  const key = `${repoRoot}::${sessionId}`;
  const watcher = activeWatchers.get(key);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(key);
  }
  const timer = watchDebounce.get(key);
  if (timer) {
    clearTimeout(timer);
    watchDebounce.delete(key);
  }
}

/**
 * Stop all mailbox watchers (cleanup on deactivate).
 */
export function stopAllMailboxWatchers(): void {
  for (const [key, watcher] of activeWatchers) {
    watcher.close();
    const timer = watchDebounce.get(key);
    if (timer) clearTimeout(timer);
  }
  activeWatchers.clear();
  watchDebounce.clear();
}

// ——— Toast notifications for new messages ———————————————

const lastKnownCounts = new Map<string, number>();

/**
 * Check for new messages and show an OS toast notification.
 * Call this after pushing mailbox to detect new arrivals.
 */
export function checkAndNotifyNewMessages(
  repoRoot: string,
  sessionId: string,
): void {
  const key = `${repoRoot}::${sessionId}`;
  const current = getUnreadCount(repoRoot, sessionId);
  const previous = lastKnownCounts.get(key) ?? 0;

  if (current > previous && previous >= 0) {
    const diff = current - previous;
    const shortId = sessionId.substring(0, 8);
    vscode.window.showInformationMessage(
      `📬 ${diff} nuevo${diff > 1 ? "s" : ""} mensaje${diff > 1 ? "s" : ""} en el mailbox (sesión ${shortId})`,
    );
  }
  lastKnownCounts.set(key, current);
}

/**
 * Reset notification tracking for a session.
 */
export function resetNotificationTracking(sessionId: string): void {
  for (const [key] of lastKnownCounts) {
    if (key.endsWith(`::${sessionId}`)) {
      lastKnownCounts.delete(key);
    }
  }
}

// ——— Push helpers ———————————————————————————————————————

/**
 * Push current mailbox state for a session to the webview.
 * Converts LoopMessage[] to the shape expected by the webview types.
 */
export function pushMailboxToWebview(
  repoRoot: string,
  sessionId: string,
  instance: BrainHqInstance,
): void {
  const messages = getSessionMessages(repoRoot, sessionId);
  const unreadCount = getUnreadCount(repoRoot, sessionId);

  instance.panel.webview.postMessage({
    type: "mailboxUpdate",
    sessionId,
    messages: messages.map(toWebviewMessage),
    unreadCount,
  });
}

/** Map internal LoopMessage to the webview-facing shape. */
function toWebviewMessage(m: LoopMessage) {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    type: m.type,
    content: m.content,
    timestamp: m.timestamp,
    read: m.read,
    replyTo: m.replyTo,
    status: m.status,
    channel: m.channel,
    delivered: m.read, // read by hook = delivered to agent
  };
}
