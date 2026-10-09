/**
 * Loop Mailbox — STRAT-7
 *
 * File-based message bus for inter-loop communication.
 * Unlike SwarmMailbox (in-memory, single orchestration), this persists
 * messages to `.project-brain/loops/mailbox.json` so independent loop sessions
 * can exchange warnings, findings, and coordination signals.
 *
 * Use cases:
 *   - Loop A warns Loop B: "I'm refactoring auth.ts, don't touch it"
 *   - Loop A broadcasts: "I found a bug in scanner.ts"
 *   - Loop A asks Loop B: "Are you done with shared-utils.ts?"
 *
 * Design: file-based persistence, ephemeral TTL, no external deps.
 */

import * as fs from "fs";
import * as path from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";
import { archiveMessages } from "./loop-mailbox-archive";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LoopMessageType =
  | "warning" // "Don't touch this file"
  | "finding" // "I discovered X"
  | "question" // "Are you done with Y?"
  | "answer" // Response to a question
  | "broadcast" // General announcement
  | "conflict"; // Automated conflict detection

export interface LoopMessage {
  /** Unique message ID (timestamp + random). */
  id: string;
  /** Session ID of the sender. */
  from: string;
  /** Session ID of the recipient (null = broadcast to ALL loops). */
  to: string | null;
  /** Message type. */
  type: LoopMessageType;
  /** Human-readable content. */
  content: string;
  /** Unix timestamp when sent. */
  timestamp: number;
  /** Whether the recipient has read this message. */
  read: boolean;
  /** Reply to another message ID (threading). */
  replyTo?: string;
  /** Auto-generated from file lock or conflict detection. */
  automated?: boolean;
  /** Message lifecycle: active (default), resolved (handled), acknowledged. */
  status?: "active" | "resolved" | "acknowledged";
  /** Channel isolation: loop (default) or orchestration. */
  channel?: "loop" | "orchestration";
}

interface MailboxStore {
  messages: LoopMessage[];
  lastUpdated: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Mailbox dir resolved via brain-paths (supports legacy fallback).
const MAILBOX_FILE = "mailbox.json";
const LOCK_FILE = "mailbox.lock";
/** Messages older than 6 hours are auto-pruned. */
const MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
/** Max messages kept in the store. */
const MAX_MESSAGES = 200;
/** Locks older than 5s are considered stale (crashed process). */
const LOCK_STALE_MS = 5_000;

// ─── Persistence (atomic writes + best-effort locking) ──────────────────────

function mailboxPath(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), MAILBOX_FILE);
}

function lockPath(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), LOCK_FILE);
}

function ensureDir(repoRoot: string): void {
  const dir = getLoopsDir(repoRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Read mailbox with structure validation + corruption recovery. */
export function readMailbox(repoRoot: string): MailboxStore {
  const fp = mailboxPath(repoRoot);
  try {
    if (!fs.existsSync(fp)) {
      return { messages: [], lastUpdated: Date.now() };
    }
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw) as MailboxStore;
    if (!Array.isArray(parsed.messages)) {
      throw new Error("Invalid mailbox: messages is not an array");
    }
    return parsed;
  } catch (err) {
    logWarn(`[LoopMailbox] Read failed (recovering): ${err}`);
    // Preserve corrupt file for debugging
    try {
      if (fs.existsSync(fp)) {
        fs.renameSync(fp, `${fp}.corrupt.${Date.now()}`);
      }
    } catch {
      /* ignore — file may have been removed */
    }
    return { messages: [], lastUpdated: Date.now() };
  }
}

/** Write mailbox atomically via temp file + rename. */
function writeMailbox(repoRoot: string, store: MailboxStore): void {
  const fp = mailboxPath(repoRoot);
  const tmp = `${fp}.tmp.${process.pid}`;
  try {
    ensureDir(repoRoot);
    store.lastUpdated = Date.now();
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, fp);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup best-effort */
    }
    logError(`[LoopMailbox] Atomic write failed: ${err}`);
  }
}

/** Try to acquire a filesystem lock. Non-blocking, best-effort. */
function acquireLock(repoRoot: string): boolean {
  const lp = lockPath(repoRoot);
  try {
    ensureDir(repoRoot);
    fs.writeFileSync(lp, `${process.pid}:${Date.now()}`, { flag: "wx" });
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") return false;
    // Check if existing lock is stale
    try {
      const content = fs.readFileSync(lp, "utf-8");
      const ts = parseInt(content.split(":")[1] || content, 10);
      if (!isNaN(ts) && Date.now() - ts > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lp);
        } catch {
          /* ignore */
        }
        try {
          fs.writeFileSync(lp, `${process.pid}:${Date.now()}`, { flag: "wx" });
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      /* lock disappeared or unreadable */
    }
    return false;
  }
}

function releaseLock(repoRoot: string): void {
  try {
    fs.unlinkSync(lockPath(repoRoot));
  } catch {
    /* ignore */
  }
}

/**
 * Execute a mutating mailbox operation with best-effort locking.
 * Lock → read → fn(store) → atomic write → unlock.
 * If lock can't be acquired, proceeds anyway (safe in single-process).
 */
function withMailbox<T>(repoRoot: string, fn: (store: MailboxStore) => T): T {
  const locked = acquireLock(repoRoot);
  try {
    const store = readMailbox(repoRoot);
    const result = fn(store);
    writeMailbox(repoRoot, store);
    return result;
  } finally {
    if (locked) releaseLock(repoRoot);
  }
}

function pruneOldMessages(store: MailboxStore): number {
  const now = Date.now();
  const before = store.messages.length;
  store.messages = store.messages
    .filter((m) => now - m.timestamp < MESSAGE_TTL_MS)
    .slice(-MAX_MESSAGES);
  const pruned = before - store.messages.length;
  if (pruned > 0) {
    log(`[LoopMailbox] Pruned ${pruned} old/excess message(s)`);
  }
  return pruned;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a message to another loop session (or broadcast to all).
 */
export function sendMessage(
  repoRoot: string,
  from: string,
  to: string | null,
  type: LoopMessageType,
  content: string,
  opts?: { replyTo?: string; channel?: "loop" | "orchestration" },
): LoopMessage {
  const msg: LoopMessage = {
    id: generateId(),
    from,
    to,
    type,
    content,
    timestamp: Date.now(),
    read: false,
    replyTo: opts?.replyTo,
    status: "active",
    channel: opts?.channel ?? "loop",
  };

  withMailbox(repoRoot, (store) => {
    pruneOldMessages(store);
    store.messages.push(msg);
  });

  const target = to ? to.substring(0, 8) : "ALL";
  log(
    `[LoopMailbox] ${from.substring(0, 8)} → ${target}: [${type}] ${content.substring(0, 60)}`,
  );
  return msg;
}

/**
 * Read unread messages for a session (includes broadcasts and direct messages).
 * Marks messages as read after retrieval.
 */
export function readMessages(
  repoRoot: string,
  sessionId: string,
): LoopMessage[] {
  let unread: LoopMessage[] = [];

  withMailbox(repoRoot, (store) => {
    pruneOldMessages(store);
    unread = store.messages.filter(
      (m) =>
        !m.read &&
        (!m.status || m.status === "active") &&
        m.from !== sessionId &&
        (m.to === null || m.to === sessionId),
    );
    for (const msg of unread) {
      msg.read = true;
    }
  });

  if (unread.length > 0) {
    log(
      `[LoopMailbox] ${sessionId.substring(0, 8)} read ${unread.length} message(s)`,
    );
  }
  return unread;
}

/**
 * Peek at unread count without marking as read.
 */
export function getUnreadCount(repoRoot: string, sessionId: string): number {
  const store = readMailbox(repoRoot);
  return store.messages.filter(
    (m) =>
      !m.read &&
      (!m.status || m.status === "active") &&
      m.from !== sessionId &&
      (m.to === null || m.to === sessionId),
  ).length;
}

/**
 * Archive and remove all messages from/to a session (cleanup on session end).
 * Messages are moved to `mailbox-archive.json` before removal.
 */
export function clearSessionMessages(
  repoRoot: string,
  sessionId: string,
): number {
  let cleared = 0;

  withMailbox(repoRoot, (store) => {
    const toArchive = store.messages.filter(
      (m) => m.from === sessionId || m.to === sessionId,
    );
    archiveMessages(repoRoot, toArchive);
    store.messages = store.messages.filter(
      (m) => m.from !== sessionId && m.to !== sessionId,
    );
    cleared = toArchive.length;
  });

  if (cleared > 0) {
    log(
      `[LoopMailbox] Cleared ${cleared} message(s) from session ${sessionId.substring(0, 8)}`,
    );
  }
  return cleared;
}

/**
 * Resolve a specific message by ID (mark as handled).
 */
export function resolveMessage(repoRoot: string, messageId: string): boolean {
  let found = false;
  withMailbox(repoRoot, (store) => {
    const msg = store.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.status = "resolved";
      msg.read = true;
      found = true;
    }
  });
  if (found) {
    log(`[LoopMailbox] Resolved message ${messageId}`);
  }
  return found;
}

/**
 * Resolve ALL unread messages targeted to a session.
 * Call this when the agent has acknowledged/processed messages.
 */
export function resolveSessionMessages(
  repoRoot: string,
  sessionId: string,
): number {
  let resolved = 0;
  withMailbox(repoRoot, (store) => {
    for (const m of store.messages) {
      if (
        (!m.status || m.status === "active") &&
        (m.to === sessionId || m.to === null) &&
        m.from !== sessionId
      ) {
        m.status = "resolved";
        m.read = true;
        resolved++;
      }
    }
  });
  if (resolved > 0) {
    log(
      `[LoopMailbox] Resolved ${resolved} message(s) for session ${sessionId.substring(0, 8)}`,
    );
  }
  return resolved;
}

/**
 * Format unread messages as a compact string for injection into feedback.
 */

// Re-export query functions (extracted to loop-mailbox-queries.ts)
export {
  formatUnreadMessages,
  getSessionMessages,
  getThread,
} from "./loop-mailbox-queries";
