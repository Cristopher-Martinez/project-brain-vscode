// ============================================================
// SOURCE MAP — swarm-mailbox.ts
// Inter-agent messaging system for Swarm workers
// ============================================================
// L1-10:       Source map
// L12-65:      Interfaces (MailboxMessage, MailboxStats, etc.)
// L67-200:     SwarmMailbox class — in-memory message bus
// L200-280:    MailboxDB — SQLite persistence for orchestration sessions
// ============================================================

import * as fs from "fs";
import * as path from "path";
import type { Database } from "sql.js";
import { createDatabase, saveDatabase } from "./sql-provider";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Message types workers can exchange via the mailbox. */
export type MailboxMessageType =
  | "finding" // Worker found something relevant
  | "question" // Worker needs input from another
  | "challenge" // Worker disagrees with a finding
  | "update" // Status update / progress note
  | "blocker" // Worker is blocked and needs help
  | "consensus"; // Worker confirms agreement with a finding

/** A single message in the mailbox. */
export interface MailboxMessage {
  /** Auto-generated unique ID */
  id: string;
  /** Worker taskId that sent the message */
  from: string;
  /** Specific recipient taskId (null = broadcast to all) */
  to: string | null;
  /** Message classification */
  type: MailboxMessageType;
  /** The actual content */
  content: string;
  /** Unix timestamp */
  timestamp: number;
  /** Whether this message has been read by its intended recipient */
  read: boolean;
  /** Optional reference to another message (for threads) */
  replyTo?: string;
}

/** Stats for monitoring mailbox activity. */
export interface MailboxStats {
  totalMessages: number;
  byType: Record<MailboxMessageType, number>;
  byWorker: Record<string, number>;
  unreadCount: number;
}

/** Filter options for reading messages. */
export interface MailboxReadOptions {
  /** Only messages after this timestamp */
  since?: number;
  /** Only messages of these types */
  types?: MailboxMessageType[];
  /** Only messages from this worker */
  from?: string;
  /** Include broadcast messages (default: true) */
  includeBroadcasts?: boolean;
  /** Mark retrieved messages as read (default: true) */
  markAsRead?: boolean;
}

// ─── SwarmMailbox ───────────────────────────────────────────────────────────

/**
 * In-memory message bus for inter-worker communication.
 *
 * Think of it as a pirate tavern bulletin board — workers post notes,
 * others swing by between rum rounds to check what's new.
 *
 * Design decisions:
 * - In-memory first (fast, no I/O during execution)
 * - Rate-limited per worker to prevent feedback loops
 * - Messages are typed for structured analysis
 * - Optional SQLite persistence for orchestration sessions
 *
 * Usage:
 * ```typescript
 * const mailbox = new SwarmMailbox();
 * mailbox.post({ from: 'worker-1', content: 'Found a bug in auth', type: 'finding' });
 * const msgs = mailbox.getFor('worker-2'); // gets broadcasts + direct messages
 * ```
 */
export class SwarmMailbox {
  private messages: MailboxMessage[] = [];
  private postCounts: Map<string, number> = new Map();
  private readonly maxPostsPerWorker: number;
  private readonly log: (msg: string) => void;
  /** Called immediately after a message is posted — for real-time UI sync */
  onPost?: (message: MailboxMessage) => void;

  constructor(opts?: {
    maxPostsPerWorker?: number;
    log?: (msg: string) => void;
    /** Callback fired immediately after each successful post */
    onPost?: (message: MailboxMessage) => void;
  }) {
    this.maxPostsPerWorker = opts?.maxPostsPerWorker ?? 10;
    this.log = opts?.log ?? (() => {});
    this.onPost = opts?.onPost;
    this.log(
      `[Mailbox] Initialized (maxPostsPerWorker=${this.maxPostsPerWorker}, realTimeSync=${!!this.onPost})`,
    );
  }

  // ─── Write ──────────────────────────────────────────────────────────

  /**
   * Post a message to the mailbox.
   * Returns the message ID, or null if rate-limited.
   */
  post(msg: {
    from: string;
    to?: string | null;
    type: MailboxMessageType;
    content: string;
    replyTo?: string;
  }): string | null {
    // Rate limit check
    const currentCount = this.postCounts.get(msg.from) ?? 0;
    if (currentCount >= this.maxPostsPerWorker) {
      this.log(
        `[Mailbox] Rate limit: ${msg.from} has posted ${currentCount}/${this.maxPostsPerWorker} — message dropped`,
      );
      return null;
    }

    const message: MailboxMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      from: msg.from,
      to: msg.to ?? null,
      type: msg.type,
      content: msg.content,
      timestamp: Date.now(),
      read: false,
      replyTo: msg.replyTo,
    };

    this.messages.push(message);
    this.postCounts.set(msg.from, currentCount + 1);

    this.log(
      `[Mailbox] ${msg.from} → ${msg.to || "ALL"}: [${msg.type}] ${msg.content.substring(0, 80)}`,
    );

    // Fire real-time callback for immediate UI sync
    try {
      this.onPost?.(message);
    } catch (err) {
      this.log(`[Mailbox] onPost callback error: ${err}`);
    }

    return message.id;
  }

  /**
   * Broadcast a message to all workers (convenience).
   */
  broadcast(
    from: string,
    content: string,
    type: MailboxMessageType = "update",
  ): string | null {
    return this.post({ from, to: null, type, content });
  }

  // ─── Read ───────────────────────────────────────────────────────────

  /**
   * Get messages relevant to a specific worker.
   * Returns: direct messages to this worker + broadcasts (excluding own messages).
   */
  getFor(workerId: string, opts?: MailboxReadOptions): MailboxMessage[] {
    const since = opts?.since ?? 0;
    const includeBroadcasts = opts?.includeBroadcasts ?? true;
    const markAsRead = opts?.markAsRead ?? true;

    this.log(
      `[Mailbox] getFor(${workerId}): scanning ${this.messages.length} total messages (since=${since}, markAsRead=${markAsRead})`,
    );

    const relevant = this.messages.filter((m) => {
      // Skip own messages
      if (m.from === workerId) return false;
      // Time filter
      if (m.timestamp <= since) return false;
      // Type filter
      if (opts?.types && !opts.types.includes(m.type)) return false;
      // From filter
      if (opts?.from && m.from !== opts.from) return false;
      // Direct message to this worker
      if (m.to === workerId) return true;
      // Broadcast
      if (m.to === null && includeBroadcasts) return true;
      return false;
    });

    if (markAsRead) {
      for (const m of relevant) {
        m.read = true;
      }
    }

    this.log(
      `[Mailbox] getFor(${workerId}): found ${relevant.length} relevant messages (${relevant.filter((m) => m.to === workerId).length} direct, ${relevant.filter((m) => m.to === null).length} broadcast)`,
    );
    return relevant;
  }

  /**
   * Get all messages (for monitoring / Brain HQ display).
   */
  getAll(): MailboxMessage[] {
    return [...this.messages];
  }

  /**
   * Get unread count for a specific worker.
   */
  getUnreadCount(workerId: string): number {
    return this.messages.filter(
      (m) =>
        !m.read && m.from !== workerId && (m.to === workerId || m.to === null),
    ).length;
  }

  // ─── Context Injection ──────────────────────────────────────────────

  /**
   * Format mailbox messages as a context block to inject into a worker's
   * message array between agentic loop rounds.
   *
   * Returns empty string if no new messages.
   */
  formatContextForWorker(workerId: string, since?: number): string {
    this.log(
      `[Mailbox] formatContextForWorker(${workerId}, since=${since ?? "undefined"})`,
    );
    const messages = this.getFor(workerId, { since, markAsRead: true });

    if (messages.length === 0) {
      this.log(`[Mailbox] No new messages for ${workerId} — empty context`);
      return "";
    }

    const lines = ["", "## 📬 Mailbox Messages from Other Workers", ""];

    for (const m of messages) {
      const typeIcon = {
        finding: "🔍",
        question: "❓",
        challenge: "⚔️",
        update: "📝",
        blocker: "🚫",
        consensus: "✅",
      }[m.type];

      lines.push(
        `- **${typeIcon} ${m.type.toUpperCase()}** from \`${m.from}\`${m.replyTo ? ` (re: ${m.replyTo})` : ""}:`,
      );
      lines.push(`  > ${m.content}`);
      lines.push("");
    }

    lines.push(
      "If relevant, you can respond via the `swarm_mailbox_post` tool.",
    );

    const ctx = lines.join("\n");
    this.log(
      `[Mailbox] Context for ${workerId}: ${messages.length} messages, ${ctx.length} chars`,
    );
    return ctx;
  }

  // ─── Stats ──────────────────────────────────────────────────────────

  /**
   * Get mailbox statistics (for Brain HQ dashboard).
   */
  getStats(): MailboxStats {
    const byType: Record<MailboxMessageType, number> = {
      finding: 0,
      question: 0,
      challenge: 0,
      update: 0,
      blocker: 0,
      consensus: 0,
    };
    const byWorker: Record<string, number> = {};
    let unreadCount = 0;

    for (const m of this.messages) {
      byType[m.type]++;
      byWorker[m.from] = (byWorker[m.from] ?? 0) + 1;
      if (!m.read) unreadCount++;
    }

    return {
      totalMessages: this.messages.length,
      byType,
      byWorker,
      unreadCount,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Clear all messages (end of swarm execution).
   */
  clear(): void {
    this.log(
      `[Mailbox] Clearing: ${this.messages.length} messages, ${this.postCounts.size} worker counters`,
    );
    this.messages = [];
    this.postCounts.clear();
  }

  /**
   * Get the current rate limit count for a worker.
   */
  getPostCount(workerId: string): number {
    return this.postCounts.get(workerId) ?? 0;
  }

  /**
   * Reset rate limit for a specific worker (e.g., new round).
   */
  resetRateLimit(workerId: string): void {
    const prev = this.postCounts.get(workerId) ?? 0;
    this.postCounts.delete(workerId);
    this.log(
      `[Mailbox] Rate limit reset for ${workerId} (was ${prev}/${this.maxPostsPerWorker})`,
    );
  }

  /**
   * Reset all rate limits (e.g., between orchestration rounds).
   */
  resetAllRateLimits(): void {
    const workerCount = this.postCounts.size;
    this.postCounts.clear();
    this.log(`[Mailbox] All rate limits reset (${workerCount} workers)`);
  }
}

// ─── MailboxDB — SQLite Persistence ─────────────────────────────────────────

const MAILBOX_DB_FILENAME = "mailbox.sqlite";

const MAILBOX_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mailbox_messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    from_worker TEXT NOT NULL,
    to_worker   TEXT,
    type        TEXT NOT NULL,
    content     TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    read        INTEGER NOT NULL DEFAULT 0,
    reply_to    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mailbox_session ON mailbox_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_mailbox_from ON mailbox_messages(from_worker);
  CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox_messages(to_worker);
  CREATE INDEX IF NOT EXISTS idx_mailbox_timestamp ON mailbox_messages(timestamp);
`;

/**
 * SQLite-backed persistence for mailbox messages.
 *
 * Used by OrchestrationSession to persist inter-agent communication
 * across rounds and even VS Code restarts.
 *
 * Follows the same pattern as SessionDB (sql-provider singleton).
 */
export class MailboxDB {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly log: (msg: string) => void;

  constructor(sessionsDir: string, log: (msg: string) => void) {
    this.dbPath = path.join(sessionsDir, MAILBOX_DB_FILENAME);
    this.log = log;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = await createDatabase(this.dbPath);
      this.db.run(MAILBOX_CREATE_TABLE_SQL);
      this._save();
      this.log(`[MailboxDB] Initialized at ${this.dbPath}`);
    } catch (err) {
      this.log(`[MailboxDB] Init failed: ${err}`);
    }
  }

  /**
   * Persist a batch of mailbox messages for a session.
   */
  saveMessages(sessionId: string, messages: MailboxMessage[]): void {
    if (!this.db) {
      this.log(`[MailboxDB] saveMessages skipped — DB not initialized`);
      return;
    }

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO mailbox_messages
       (id, session_id, from_worker, to_worker, type, content, timestamp, read, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const m of messages) {
      stmt.run([
        m.id,
        sessionId,
        m.from,
        m.to,
        m.type,
        m.content,
        m.timestamp,
        m.read ? 1 : 0,
        m.replyTo ?? null,
      ]);
    }
    stmt.free();
    this._save();

    this.log(
      `[MailboxDB] Saved ${messages.length} messages for session ${sessionId}`,
    );
  }

  /**
   * Load all messages for a session (for resuming orchestration).
   */
  loadMessages(sessionId: string): MailboxMessage[] {
    if (!this.db) {
      this.log(`[MailboxDB] loadMessages skipped — DB not initialized`);
      return [];
    }
    this.log(`[MailboxDB] Loading messages for session ${sessionId}...`);

    const rows = this.db.exec(
      `SELECT id, from_worker, to_worker, type, content, timestamp, read, reply_to
       FROM mailbox_messages
       WHERE session_id = ?
       ORDER BY timestamp ASC`,
      [sessionId],
    );

    if (!rows.length || !rows[0].values.length) {
      this.log(`[MailboxDB] No messages found for session ${sessionId}`);
      return [];
    }

    const messages = rows[0].values.map((row) => ({
      id: row[0] as string,
      from: row[1] as string,
      to: (row[2] as string) || null,
      type: row[3] as MailboxMessageType,
      content: row[4] as string,
      timestamp: row[5] as number,
      read: (row[6] as number) === 1,
      replyTo: (row[7] as string) || undefined,
    }));
    this.log(
      `[MailboxDB] Loaded ${messages.length} messages for session ${sessionId}`,
    );
    return messages;
  }

  /**
   * Get message counts grouped by session (for admin).
   */
  getSessionStats(): {
    sessionId: string;
    messageCount: number;
    lastActivity: number;
  }[] {
    if (!this.db) return [];

    const rows = this.db.exec(
      `SELECT session_id, COUNT(*) as cnt, MAX(timestamp) as last_ts
       FROM mailbox_messages
       GROUP BY session_id
       ORDER BY last_ts DESC`,
    );

    if (!rows.length || !rows[0].values.length) return [];

    return rows[0].values.map((row) => ({
      sessionId: row[0] as string,
      messageCount: row[1] as number,
      lastActivity: row[2] as number,
    }));
  }

  /**
   * Delete messages for a specific session.
   */
  deleteSession(sessionId: string): void {
    if (!this.db) {
      this.log(`[MailboxDB] deleteSession skipped — DB not initialized`);
      return;
    }
    this.db.run(`DELETE FROM mailbox_messages WHERE session_id = ?`, [
      sessionId,
    ]);
    this._save();
    this.log(`[MailboxDB] Deleted messages for session ${sessionId}`);
  }

  dispose(): void {
    if (this.db) {
      this.log(`[MailboxDB] Disposing — saving and closing`);
      this._save();
      this.db.close();
      this.db = null;
    } else {
      this.log(`[MailboxDB] Dispose called but DB was not initialized`);
    }
  }

  private _save(): void {
    if (this.db) {
      saveDatabase(this.db, this.dbPath);
    }
  }
}
