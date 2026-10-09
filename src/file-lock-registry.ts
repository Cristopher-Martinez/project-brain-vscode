/**
 * File Lock Registry — STRAT-4
 *
 * Advisory (non-blocking) file-level locking across concurrent sessions.
 * When a session edits a file, it registers a lock. Other sessions get
 * warnings when they try to edit the same file, preventing merge conflicts.
 *
 * Storage: `.project-brain/loops/file-locks.json` (shared across all sessions).
 * Design: testeable pure functions + a thin persistence layer.
 */

import * as fs from "fs";
import * as path from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileLockEntry {
  /** Session ID that holds the lock. */
  sessionId: string;
  /** Relative path from repo root (e.g., "src/foo.ts"). */
  file: string;
  /** Timestamp when the lock was acquired. */
  acquiredAt: number;
  /** Optional description of what the session is doing with this file. */
  reason?: string;
}

export interface FileLockConflict {
  /** The file being contested. */
  file: string;
  /** Session IDs that already hold locks on this file (excluding the querying session). */
  holders: string[];
  /** When the earliest lock was acquired. */
  earliestLock: number;
}

interface LockStore {
  locks: FileLockEntry[];
  lastUpdated: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Lock dir resolved via brain-paths.
const LOCK_FILE = "file-locks.json";
/** Locks older than 4 hours are automatically expired. */
const LOCK_TTL_MS = 4 * 60 * 60 * 1000;

// ─── Persistence ────────────────────────────────────────────────────────────

function lockFilePath(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), LOCK_FILE);
}

function readStore(repoRoot: string): LockStore {
  const fp = lockFilePath(repoRoot);
  try {
    if (!fs.existsSync(fp)) {
      return { locks: [], lastUpdated: Date.now() };
    }
    const raw = fs.readFileSync(fp, "utf-8");
    return JSON.parse(raw) as LockStore;
  } catch (err) {
    logWarn(`[FileLock] Failed to read lock store (non-fatal): ${err}`);
    return { locks: [], lastUpdated: Date.now() };
  }
}

function writeStore(repoRoot: string, store: LockStore): void {
  const fp = lockFilePath(repoRoot);
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    store.lastUpdated = Date.now();
    fs.writeFileSync(fp, JSON.stringify(store, null, 2), "utf-8");
    log(`[FileLock] Store written — ${store.locks.length} active locks`);
  } catch (err) {
    logError(`[FileLock] Failed to write lock store: ${err}`);
  }
}

/** Remove expired locks (older than LOCK_TTL_MS). */
function pruneExpired(store: LockStore): number {
  const now = Date.now();
  const before = store.locks.length;
  store.locks = store.locks.filter((l) => now - l.acquiredAt < LOCK_TTL_MS);
  const pruned = before - store.locks.length;
  if (pruned > 0) {
    log(`[FileLock] Pruned ${pruned} expired lock(s)`);
  }
  return pruned;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Acquire a soft lock on a file for a session.
 * If the session already holds a lock on the file, it's a no-op.
 * Returns any existing conflicts (other sessions editing the same file).
 */
export function acquireLock(
  repoRoot: string,
  sessionId: string,
  file: string,
  reason?: string,
): FileLockConflict | null {
  const store = readStore(repoRoot);
  pruneExpired(store);

  const normalizedFile = file.replace(/\\/g, "/");

  // Check if this session already has this lock
  const existing = store.locks.find(
    (l) => l.sessionId === sessionId && l.file === normalizedFile,
  );
  if (existing) {
    log(
      `[FileLock] Lock already held: ${normalizedFile} by ${sessionId.substring(0, 8)}`,
    );
  } else {
    store.locks.push({
      sessionId,
      file: normalizedFile,
      acquiredAt: Date.now(),
      reason,
    });
    log(
      `[FileLock] Lock acquired: ${normalizedFile} by ${sessionId.substring(0, 8)}` +
        (reason ? ` — ${reason}` : ""),
    );
  }

  // Check for conflicts
  const conflict = findConflict(store, sessionId, normalizedFile);
  writeStore(repoRoot, store);
  return conflict;
}

/**
 * Release a specific lock.
 */
export function releaseLock(
  repoRoot: string,
  sessionId: string,
  file: string,
): void {
  const store = readStore(repoRoot);
  const normalizedFile = file.replace(/\\/g, "/");
  const before = store.locks.length;
  store.locks = store.locks.filter(
    (l) => !(l.sessionId === sessionId && l.file === normalizedFile),
  );
  const removed = before - store.locks.length;
  if (removed > 0) {
    log(
      `[FileLock] Lock released: ${normalizedFile} by ${sessionId.substring(0, 8)}`,
    );
  }
  writeStore(repoRoot, store);
}

/**
 * Release ALL locks for a session (call on session end/cleanup).
 */
export function releaseAllLocks(repoRoot: string, sessionId: string): number {
  const store = readStore(repoRoot);
  const before = store.locks.length;
  store.locks = store.locks.filter((l) => l.sessionId !== sessionId);
  const released = before - store.locks.length;
  if (released > 0) {
    log(
      `[FileLock] All locks released for ${sessionId.substring(0, 8)}: ${released} lock(s)`,
    );
    writeStore(repoRoot, store);
  }
  return released;
}

/**
 * Check if editing a file would conflict with another session.
 * Does NOT acquire a lock — pure read.
 */
export function checkConflicts(
  repoRoot: string,
  sessionId: string,
  file: string,
): FileLockConflict | null {
  const store = readStore(repoRoot);
  pruneExpired(store);
  return findConflict(store, sessionId, file.replace(/\\/g, "/"));
}

/**
 * Get all files locked by a specific session.
 */
export function getLockedFiles(
  repoRoot: string,
  sessionId: string,
): FileLockEntry[] {
  const store = readStore(repoRoot);
  pruneExpired(store);
  return store.locks.filter((l) => l.sessionId === sessionId);
}

/**
 * Get ALL active locks (all sessions). Used for admin/debugging.
 */
export function getAllLocks(repoRoot: string): FileLockEntry[] {
  const store = readStore(repoRoot);
  pruneExpired(store);
  writeStore(repoRoot, store); // persist pruned state
  return store.locks;
}

/**
 * Build a summary of all file conflicts across all sessions.
 * Returns only files locked by ≥2 sessions.
 */
export function getAllConflicts(repoRoot: string): FileLockConflict[] {
  const store = readStore(repoRoot);
  pruneExpired(store);

  // Group by file
  const byFile = new Map<string, FileLockEntry[]>();
  for (const lock of store.locks) {
    const entries = byFile.get(lock.file) || [];
    entries.push(lock);
    byFile.set(lock.file, entries);
  }

  // Filter files with ≥2 DIFFERENT sessions
  const conflicts: FileLockConflict[] = [];
  for (const [file, entries] of byFile) {
    const uniqueSessions = [...new Set(entries.map((e) => e.sessionId))];
    if (uniqueSessions.length >= 2) {
      conflicts.push({
        file,
        holders: uniqueSessions,
        earliestLock: Math.min(...entries.map((e) => e.acquiredAt)),
      });
    }
  }

  if (conflicts.length > 0) {
    log(`[FileLock] ${conflicts.length} file conflict(s) across sessions`);
  }

  return conflicts;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function findConflict(
  store: LockStore,
  sessionId: string,
  file: string,
): FileLockConflict | null {
  const others = store.locks.filter(
    (l) => l.file === file && l.sessionId !== sessionId,
  );
  if (others.length === 0) return null;

  return {
    file,
    holders: [...new Set(others.map((l) => l.sessionId))],
    earliestLock: Math.min(...others.map((l) => l.acquiredAt)),
  };
}
