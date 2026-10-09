/**
 * Fork Isolation — Fork-based isolation for Loops and Orchestrations.
 *
 * Creates a local git clone ("fork") so tools operate on the isolated repo,
 * not the user's workspace. The user stays on their branch undisturbed.
 *
 * Architecture:
 * - fork-types.ts → types & constants
 * - fork-core.ts → low-level git operations (simple-git, rimraf)
 * - fork-helpers.ts → persistence, cleanup, round context
 * - fork-isolation.ts → this file: orchestration layer
 *
 * @module fork-isolation
 */

import * as path from "path";
import { log, logError, logWarn } from "./logger";
import {
  autoCommitFork,
  cloneFork,
  createGitInstance,
  generateForkId,
  getForkPath,
  selectCloneStrategy,
} from "./fork-core";
import {
  provisionForkNodeModules,
  writeForkAgentsFile,
} from "./fork-deps";
import {
  cleanupOrphanForks,
  persistForkState,
  restoreForkState,
  validateForkPathLength,
} from "./fork-helpers";
import { assessIsolationLevel, formatAdvice } from "./isolation-advisor";
import { releaseAllLocks } from "./file-lock-registry";
import { clearSessionMessages } from "./loop-mailbox";
import { cleanupLoopControl } from "./loop-control";
import {
  FORK_BASE_DIR,
  FORK_BRANCH_PREFIX,
  MAX_CONCURRENT_FORKS,
  type ForkConfig,
  type ForkIsolationInfo,
} from "./fork-types";

// ─── State ──────────────────────────────────────────────────────────────────

const forkMap = new Map<string, ForkIsolationInfo>();

/** @internal Exposed for fork-queries (replaces getIsolationMap). */
export function getForkMap(): Map<string, ForkIsolationInfo> {
  return forkMap;
}

// ─── Persistence API ────────────────────────────────────────────────────────

/** Persist current fork state to disk. Call after every forkMap mutation. */
function persist(repoRoot: string): void {
  persistForkState(repoRoot, forkMap);
}

/** Restore fork state from disk on activation. Returns sessions restored. */
export function restoreState(repoRoot: string): number {
  return restoreForkState(repoRoot, forkMap);
}

/** Clean up orphan forks on activation. Returns count cleaned. */
export async function cleanupOrphans(repoRoot: string): Promise<number> {
  return cleanupOrphanForks(repoRoot, forkMap);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Short session ID for logs and branch names. */
export function shortSessionId(sessionId: string): string {
  return sessionId.substring(0, 8);
}

/** Convert a goal string to a branch-safe slug (max 40 chars). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40)
    .replace(/-$/, "");
}

// ─── Fork Creation ──────────────────────────────────────────────────────────

/**
 * Create an isolated fork for a Loop/Orchestration session.
 *
 * Flow:
 * 1. Generate a short fork ID from sessionId
 * 2. Auto-detect clone strategy (shared vs local)
 * 3. Clone the source repo into `.brain-forks/<forkId>/`
 * 4. Create + checkout a new branch inside the fork
 * 5. Link node_modules from source repo
 * 6. Return ForkIsolationInfo
 *
 * The user's repo is NEVER modified during this process.
 */
export async function createFork(
  repoRoot: string,
  sessionId: string,
  baseBranch?: string,
  goal?: string,
  config?: ForkConfig,
): Promise<ForkIsolationInfo> {
  const t0 = Date.now();
  const sid = shortSessionId(sessionId);
  const forkId = generateForkId(sessionId);
  const forkPath = getForkPath(repoRoot, forkId);

  log(
    `[ForkIsolation] createFork START — session: ${sid}, forkId: ${forkId}, ` +
      `goal: ${(goal ?? "none").substring(0, 60)}`,
  );

  // 0. Guard: max concurrent forks
  const activeForks = Array.from(forkMap.values()).filter(
    (f) => f.status === "active",
  );
  if (activeForks.length >= MAX_CONCURRENT_FORKS) {
    throw new Error(
      `[ForkIsolation] Max concurrent forks reached (${MAX_CONCURRENT_FORKS}). ` +
        `Finalize or discard existing forks first.`,
    );
  }

  // 0b. Guard: path length (Windows MAX_PATH)
  if (!validateForkPathLength(repoRoot, forkId)) {
    throw new Error(
      `[ForkIsolation] Fork path would exceed OS path length limit. ` +
        `Move workspace to a shorter path.`,
    );
  }

  // 1. Determine base branch
  const srcGit = createGitInstance(repoRoot);
  const currentBranch = await srcGit.revparse(["--abbrev-ref", "HEAD"]);
  const originalBranch = baseBranch || currentBranch;
  log(
    `[ForkIsolation] Base branch: ${originalBranch} (current: ${currentBranch})`,
  );

  // 2. Select clone strategy
  const strategy = selectCloneStrategy(repoRoot, config);
  log(`[ForkIsolation] Clone strategy: ${strategy}`);

  // 3. Clone the repo into the fork directory
  const forkGit = await cloneFork(repoRoot, forkPath, strategy, originalBranch);
  log(`[ForkIsolation] Clone completed (${Date.now() - t0}ms)`);

  // 4. Create and checkout a new branch inside the fork
  const slug = goal ? slugify(goal) : "";
  const branchName = slug
    ? `${FORK_BRANCH_PREFIX}${slug}-${sid}`
    : `${FORK_BRANCH_PREFIX}${sid}`;

  await forkGit.checkoutLocalBranch(branchName);
  log(`[ForkIsolation] Branch created: ${branchName}`);

  // 5. Provision node_modules (junction + overlay) — non-fatal
  if (config?.linkNodeModules !== false) {
    await provisionForkNodeModules(repoRoot, forkPath);
  }

  // 6. STRAT-5: Assess isolation risk
  const advice = assessIsolationLevel(goal || "");
  log(
    `[ForkIsolation] Isolation advice: ${advice.level} ` +
      `(risk=${advice.riskScore})`,
  );

  // 7. Build info record
  const info: ForkIsolationInfo = {
    sessionId,
    type: "loop",
    branchName,
    originalBranch,
    forkPath,
    repoRoot,
    cloneStrategy: strategy,
    createdAt: Date.now(),
    status: "active",
    description: goal,
    isolationAdvice: formatAdvice(advice),
  };

  forkMap.set(sessionId, info);
  persist(repoRoot);

  // 8. Write AGENTS.md inside the fork so agents know the rules
  try {
    await writeForkAgentsFile({
      sessionId,
      branchName,
      originalBranch,
      forkPath,
      repoRoot,
      goal,
      isolationAdvice: info.isolationAdvice,
    });
  } catch {
    /* non-fatal */
  }

  log(
    `[ForkIsolation] createFork DONE — session: ${sid}, ` +
      `fork: ${forkPath}, total: ${Date.now() - t0}ms`,
  );

  return info;
}

// ─── Fork Finalization ──────────────────────────────────────────────────────

/**
 * Finalize a fork after session ends.
 *
 * Unlike worktree finalization, the fork directory is PRESERVED
 * until the user explicitly merges or discards it. This allows
 * inspection of the fork's state before deciding.
 *
 * Steps:
 * 1. Auto-commit any pending changes
 * 2. Mark as "completed"
 * 3. Release file locks and mailbox messages
 * 4. Persist state
 */
export async function finalizeFork(
  repoRoot: string,
  sessionId: string,
): Promise<void> {
  const sid = shortSessionId(sessionId);
  const info = forkMap.get(sessionId);

  if (!info) {
    logWarn(`[ForkIsolation] finalizeFork — no fork for session ${sid}`);
    return;
  }

  const t0 = Date.now();
  log(
    `[ForkIsolation] finalizeFork START — session: ${sid}, ` +
      `branch: ${info.branchName}`,
  );

  // 1. Auto-commit pending changes in the fork
  await autoCommitFork(
    info.forkPath,
    `[Project Brain] Auto-commit on session finalize (${sid})`,
  );

  // 2. Mark as completed (fork stays on disk for merge/discard)
  info.status = "completed";

  // 3. Release file locks for this session
  try {
    const released = releaseAllLocks(repoRoot, sessionId);
    if (released > 0) {
      log(`[ForkIsolation] Released ${released} file lock(s) on finalize`);
    }
  } catch {
    /* non-fatal */
  }

  // 4. Clear mailbox messages
  try {
    const cleared = clearSessionMessages(repoRoot, sessionId);
    if (cleared > 0) {
      log(`[ForkIsolation] Cleared ${cleared} mailbox message(s) on finalize`);
    }
  } catch {
    /* non-fatal */
  }

  // 5. Release pause gate
  try {
    cleanupLoopControl(sessionId);
  } catch {
    /* non-fatal */
  }

  forkMap.set(sessionId, info);
  persist(repoRoot);

  log(
    `[ForkIsolation] finalizeFork DONE — session: ${sid}, ` +
      `branch: ${info.branchName}, ${Date.now() - t0}ms`,
  );
}

// ─── Git Command Wrapper ────────────────────────────────────────────────────

/**
 * Execute a git command via simple-git. Drop-in replacement for the old
 * `gitCmd(repoRoot, args)` pattern, but with timeout and proper typing.
 *
 * Used by fork-queries and fork-merge for operations that need raw git.
 */
export async function forkGitCmd(cwd: string, args: string[]): Promise<string> {
  const git = createGitInstance(cwd);
  return git.raw(args);
}

// ─── Provision Facade ───────────────────────────────────────────────────────

/**
 * Provision node_modules for a fork by sessionId.
 * Facade used by lm-tools-fork.ts.
 *
 * Looks up the fork info, calls provisionForkNodeModules, returns
 * a simplified result with `ok` and `message`.
 */
export async function provisionForkDeps(
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  const info = forkMap.get(sessionId);
  if (!info) {
    return { ok: false, message: `No fork found for session ${shortSessionId(sessionId)}` };
  }
  try {
    const result = await provisionForkNodeModules(info.repoRoot, info.forkPath);
    const msg = result.ok
      ? `node_modules provisioned. Overlay: ${result.overlayDir}. ` +
        `NODE_PATH=${result.nodePath}`
      : "Junction already present — no action needed.";
    return { ok: result.ok || result.junctionCreated, message: msg };
  } catch (err) {
    return { ok: false, message: `Provision failed: ${err}` };
  }
}
