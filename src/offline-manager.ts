/**
 * Offline Manager — Operation queue for offline-first resilience.
 *
 * When the SaaS backend is unreachable, operations are queued locally
 * and flushed automatically when connectivity is restored.
 *
 * Features:
 * - Persistent queue in VS Code globalState (survives restarts)
 * - Automatic flush on reconnect with exponential backoff
 * - Idempotency keys prevent duplicate execution
 * - Configurable max queue size and retry limits
 * - Periodic connectivity checks
 */

import * as vscode from "vscode";
import type { QueuedOperation, SaaSClient } from "./saas-client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OfflineManagerOptions {
  saasClient: SaaSClient;
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  /** Max operations to keep in queue (default: 500) */
  maxQueueSize?: number;
  /** Connectivity check interval in ms (default: 60_000) */
  checkIntervalMs?: number;
  /** Max retries per operation before dropping (default: 5) */
  maxRetries?: number;
}

interface QueueEntry {
  operation: QueuedOperation;
  retries: number;
  maxRetries: number;
  firstQueuedAt: string;
  lastAttemptAt?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATE_KEY = "projectbrain.offline.queue";
const DEFAULT_MAX_QUEUE = 500;
const DEFAULT_CHECK_INTERVAL = 60_000; // 1 minute
const DEFAULT_MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000;

// ─── OfflineManager ─────────────────────────────────────────────────────────

export class OfflineManager implements vscode.Disposable {
  private saasClient: SaaSClient;
  private context: vscode.ExtensionContext;
  private log: (msg: string) => void;
  private queue: QueueEntry[] = [];
  private maxQueueSize: number;
  private maxRetries: number;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;
  private isFlushing = false;
  private wasOnline = false;
  private _disposed = false;

  constructor(options: OfflineManagerOptions) {
    this.saasClient = options.saasClient;
    this.context = options.context;
    this.log = options.log;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Restore persisted queue
    this.loadQueue();

    // Start connectivity monitoring
    this.startMonitoring();
  }

  // ─── Public API ────────────────────────────────────────────────────

  /** Queue an operation for later execution. */
  async enqueue(op: QueuedOperation): Promise<void> {
    // Assign idempotency key if missing
    if (!op.idempotencyKey) {
      op.idempotencyKey = this.generateIdempotencyKey();
    }
    if (!op.createdAt) {
      op.createdAt = new Date().toISOString();
    }

    // Check for duplicate idempotency key
    const exists = this.queue.some(
      (e) => e.operation.idempotencyKey === op.idempotencyKey,
    );
    if (exists) {
      this.log(
        `[OfflineManager] Duplicate idempotency key, skipping: ${op.idempotencyKey}`,
      );
      return;
    }

    // Enforce queue size limit — drop oldest
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      this.log(
        `[OfflineManager] Queue full, dropped oldest: ${dropped?.operation.type}`,
      );
    }

    this.queue.push({
      operation: op,
      retries: 0,
      maxRetries: this.maxRetries,
      firstQueuedAt: new Date().toISOString(),
    });

    await this.persistQueue();
    this.log(
      `[OfflineManager] Queued: ${op.type} (total: ${this.queue.length})`,
    );
  }

  /** Attempt to flush all queued operations. */
  async flush(): Promise<{
    succeeded: number;
    failed: number;
    remaining: number;
  }> {
    if (this.isFlushing) {
      return { succeeded: 0, failed: 0, remaining: this.queue.length };
    }

    this.isFlushing = true;
    let succeeded = 0;
    let failed = 0;

    try {
      const remaining: QueueEntry[] = [];

      for (const entry of this.queue) {
        if (this._disposed) break;

        try {
          await this.retryWithBackoff(
            () =>
              this.saasClient.execute(
                entry.operation,
                entry.operation.idempotencyKey,
              ),
            Math.min(3, entry.maxRetries - entry.retries), // Limited retries per flush
          );
          succeeded++;
        } catch {
          entry.retries++;
          entry.lastAttemptAt = new Date().toISOString();

          if (entry.retries >= entry.maxRetries) {
            // Exhausted retries — drop it
            this.log(
              `[OfflineManager] Dropping ${entry.operation.type} after ${entry.retries} retries`,
            );
            failed++;
          } else {
            remaining.push(entry);
          }
        }
      }

      this.queue = remaining;
      await this.persistQueue();

      if (succeeded > 0 || failed > 0) {
        this.log(
          `[OfflineManager] Flush: ${succeeded} succeeded, ${failed} dropped, ${remaining.length} remaining`,
        );
      }

      return { succeeded, failed, remaining: remaining.length };
    } finally {
      this.isFlushing = false;
    }
  }

  /** Try to execute an operation immediately, queue if offline. */
  async executeOrQueue(op: QueuedOperation): Promise<boolean> {
    if (!this.saasClient.isOnline) {
      await this.enqueue(op);
      return false;
    }

    try {
      await this.saasClient.execute(op, op.idempotencyKey);
      return true;
    } catch {
      await this.enqueue(op);
      return false;
    }
  }

  /** Get current queue size. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Get queue entries (read-only snapshot). */
  get pendingOperations(): ReadonlyArray<Readonly<QueueEntry>> {
    return [...this.queue];
  }

  /** Clear all pending operations. */
  async clearQueue(): Promise<void> {
    this.queue = [];
    await this.persistQueue();
    this.log("[OfflineManager] Queue cleared");
  }

  dispose(): void {
    this._disposed = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private startMonitoring(): void {
    // Initial check
    void this.checkConnectivity();

    // Periodic checks
    this.checkInterval = setInterval(
      () => void this.checkConnectivity(),
      this.checkIntervalMs,
    );
  }

  private async checkConnectivity(): Promise<void> {
    if (this._disposed) return;

    const online = await this.saasClient.ping();

    // Detect reconnection — auto-flush
    if (online && !this.wasOnline && this.queue.length > 0) {
      this.log(
        `[OfflineManager] Reconnected — flushing ${this.queue.length} queued operations`,
      );
      await this.flush();
    }

    this.wasOnline = online;
  }

  private async retryWithBackoff(
    fn: () => Promise<void>,
    maxRetries: number,
  ): Promise<void> {
    if (maxRetries <= 0) maxRetries = 1;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i === maxRetries - 1) throw e;
        const delay = RETRY_BASE_MS * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private loadQueue(): void {
    const stored = this.context.globalState.get<QueueEntry[]>(STATE_KEY);
    if (stored && Array.isArray(stored)) {
      this.queue = stored;
      if (this.queue.length > 0) {
        this.log(
          `[OfflineManager] Restored ${this.queue.length} queued operations`,
        );
      }
    }
  }

  private async persistQueue(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, this.queue);
  }

  private generateIdempotencyKey(): string {
    // Simple UUID v4 alternative without crypto dependency
    const hex = (n: number) =>
      Math.floor(Math.random() * Math.pow(16, n))
        .toString(16)
        .padStart(n, "0");
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
  }
}
