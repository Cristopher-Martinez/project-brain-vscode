/**
 * Fork Types — Type definitions and constants for fork-based branch isolation.
 *
 * Replaces worktree-based isolation with full local clones ("forks").
 * Each isolated session gets its own git repository cloned from the user's repo,
 * so agents can switch branches, commit, and work freely without touching the user's workspace.
 *
 * @module fork-types
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Base directory for fork repos, relative to workspace root. */
export const FORK_BASE_DIR = ".brain-forks";

/** Branch name prefix for loop/orch branches inside forks. */
export const FORK_BRANCH_PREFIX = "brain/loop-";

/** Max concurrent forks per workspace (prevents disk exhaustion). */
export const MAX_CONCURRENT_FORKS = 3;

/** Persistence file inside FORK_BASE_DIR. */
export const FORK_STATE_FILE = "state.json";

/** Length of fork directory IDs (short for MAX_PATH safety on Windows). */
export const FORK_ID_LENGTH = 8;

/** Directories inside FORK_BASE_DIR that are NOT forks — never delete. */
export const FORK_RESERVED_DIRS = new Set(["hibernated", ".shadow"]);

/** Git timeout in milliseconds for fork operations. */
export const FORK_GIT_TIMEOUT_MS = 30_000;

/** TTL for completed/merged/discarded forks (7 days). Auto-cleaned on startup. */
export const FORK_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max concurrent git processes per simple-git instance. */
export const FORK_MAX_CONCURRENT_PROCESSES = 4;

// ─── Status & Type Enums ────────────────────────────────────────────────────

/** Status of a fork-isolated branch. */
export type ForkStatus = "active" | "completed" | "merged" | "discarded";

/** Type of isolation session. */
export type ForkIsolationType = "loop" | "orch";

/**
 * Clone strategy used when creating the fork.
 * - `shared`: Uses git alternates (fast, tiny disk footprint, NOT safe on network drives).
 * - `local`: Uses hardlinks (fast, full disk footprint, safe everywhere).
 * - `copy`: Full byte-copy (slow, safe on any filesystem — ultimate fallback).
 */
export type ForkCloneStrategy = "shared" | "local" | "copy";

// ─── Core Interfaces ────────────────────────────────────────────────────────

/**
 * Info about a fork-isolated session.
 *
 * Superset of the legacy BranchIsolationInfo — all consumers that used
 * `worktreePath` should now use `forkPath` (the cloned repo root).
 */
export interface ForkIsolationInfo {
  /** Unique session identifier. */
  sessionId: string;
  /** Type of isolation session (loop or orchestration). */
  type: ForkIsolationType;
  /** Branch name inside the fork (e.g., "brain/loop-abc123"). */
  branchName: string;
  /** Branch the user was on when isolation started. */
  originalBranch: string;
  /** Absolute path to the cloned fork repository. */
  forkPath: string;
  /** Absolute path to the original (source) repository. */
  repoRoot: string;
  /** Clone strategy used. */
  cloneStrategy: ForkCloneStrategy;
  /** Unix timestamp (ms) when the fork was created. */
  createdAt: number;
  /** Current status of the fork. */
  status: ForkStatus;
  /** User-provided description of the session's goal. */
  description?: string;
  /** AI-generated summary of what happened in the session. */
  summary?: string;
  /** Path to the session's loop report. */
  reportPath?: string;
  /** STRAT-5: Formatted isolation advice string. */
  isolationAdvice?: string;
}

/**
 * Result of merging a fork branch back into the main repo.
 *
 * The "absorb" pattern: `git fetch <forkPath> <branch>` + `git merge FETCH_HEAD`
 * — we NEVER checkout inside the user's repo during merge.
 */
export interface ForkMergeResult {
  /** Whether the merge succeeded without conflicts. */
  success: boolean;
  /** List of conflicting file paths (if any). */
  conflicts?: string[];
  /** Human-readable merge message. */
  message: string;
  /** Diff stat output after successful merge. */
  diffStat?: string;
  /** List of files changed by the merge. */
  filesChanged?: string[];
}

/**
 * Configuration for fork creation.
 * Passed to `createFork()` to customize clone behavior.
 */
export interface ForkConfig {
  /** Force a specific clone strategy instead of auto-detecting. */
  strategy?: ForkCloneStrategy;
  /** Branch to checkout in the fork after cloning. */
  branch?: string;
  /** Whether to link node_modules from source (default: true). */
  linkNodeModules?: boolean;
  /** Extra git config to apply to the fork. */
  gitConfig?: Record<string, string>;
}

/**
 * Options for disposing (deleting) a fork.
 */
export interface ForkDisposeOptions {
  /** Force removal even if there are uncommitted changes. */
  force?: boolean;
  /** Max retries for file deletion (Windows file locking). */
  maxRetries?: number;
}

// ─── Backward Compatibility ─────────────────────────────────────────────────

/**
 * Legacy alias — consumers importing BranchIsolationInfo get the new type.
 *
 * Fields mapped:
 * - `worktreePath` → use `forkPath` instead
 * - `stashRef` → removed (forks don't stash)
 *
 * @deprecated Use ForkIsolationInfo directly.
 */
export type BranchIsolationInfo = ForkIsolationInfo;

/** @deprecated Use ForkStatus directly. */
export type BranchIsolationStatus = ForkStatus;

/** @deprecated Use ForkIsolationType directly. */
export type BranchIsolationType = ForkIsolationType;

/** @deprecated Use ForkMergeResult directly. */
export type MergeResult = ForkMergeResult;
