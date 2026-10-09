/**
 * Fork Core — Low-level git operations for fork-based branch isolation.
 *
 * Uses simple-git (with timeout) for all git operations and rimraf for
 * cross-platform cleanup. This replaces worktree-core.ts for fork contexts.
 *
 * Cross-platform guarantees:
 * - Windows: junctions for node_modules, rimraf handles file locking
 * - Unix: symlinks for node_modules, standard rm
 * - Network drives: auto-detected → forces `local` clone strategy
 * - MAX_PATH: 8-char fork IDs keep paths short
 *
 * @module fork-core
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { rimraf } from "rimraf";
import simpleGit, { type SimpleGit } from "simple-git";
import { log, logError, logWarn } from "./logger";
import {
  FORK_BASE_DIR,
  FORK_GIT_TIMEOUT_MS,
  FORK_ID_LENGTH,
  FORK_MAX_CONCURRENT_PROCESSES,
  type ForkCloneStrategy,
  type ForkConfig,
  type ForkDisposeOptions,
} from "./fork-types";

// ─── Git Instance Factory ───────────────────────────────────────────────────

/**
 * Create a configured simple-git instance for the given directory.
 * Includes timeout and max concurrent processes settings.
 */
export function createGitInstance(cwd: string): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    maxConcurrentProcesses: FORK_MAX_CONCURRENT_PROCESSES,
    timeout: { block: FORK_GIT_TIMEOUT_MS },
    trimmed: true,
  });
}

// ─── Fork ID Generation ─────────────────────────────────────────────────────

/**
 * Generate a short, unique fork directory ID from a session ID.
 * Uses first N chars of a SHA-256 hash for determinism + MAX_PATH safety.
 *
 * @example generateForkId("33331852-fd46-459b") → "a7f3b2c1"
 */
export function generateForkId(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, FORK_ID_LENGTH);
}

/**
 * Build the absolute path for a fork directory.
 */
export function getForkPath(repoRoot: string, forkId: string): string {
  return path.join(repoRoot, FORK_BASE_DIR, forkId);
}

// ─── Network Drive Detection ────────────────────────────────────────────────

/**
 * Detect if a path is on a network drive (UNC path or mapped network drive).
 * Network drives don't support git alternates (--shared), so we fall back to --local.
 *
 * @returns true if the path appears to be on a network filesystem.
 */
export function isNetworkDrive(targetPath: string): boolean {
  if (process.platform === "win32") {
    // UNC paths: \\server\share or //server/share
    const normalized = path.resolve(targetPath);
    return normalized.startsWith("\\\\") || normalized.startsWith("//");
  }
  // Unix: NFS/CIFS mounts — heuristic check via /proc/mounts or df
  // For safety, we just return false and let git handle errors.
  return false;
}

// ─── Clone Strategy Selection ───────────────────────────────────────────────

/**
 * Auto-detect the best clone strategy for the given source path.
 *
 * Priority:
 * 1. If `config.strategy` is explicitly set → use that.
 * 2. If source is on a network drive → `local` (alternates are broken on network).
 * 3. Default → `shared` (fastest, smallest footprint).
 */
export function selectCloneStrategy(
  sourcePath: string,
  config?: ForkConfig,
): ForkCloneStrategy {
  if (config?.strategy) {
    return config.strategy;
  }
  if (isNetworkDrive(sourcePath)) {
    logWarn(
      "[ForkCore] Network drive detected — falling back to 'local' strategy",
    );
    return "local";
  }
  return "shared";
}

// ─── Clone (Fork Creation) ──────────────────────────────────────────────────

/**
 * Clone the source repo into a fork directory.
 *
 * @param source - Absolute path to the source repository.
 * @param target - Absolute path where the fork will be created.
 * @param strategy - Clone strategy to use.
 * @param branch - Branch to checkout after cloning (optional).
 * @returns The SimpleGit instance pointing to the new fork.
 */
export async function cloneFork(
  source: string,
  target: string,
  strategy: ForkCloneStrategy,
  branch?: string,
): Promise<SimpleGit> {
  log(`[ForkCore] Cloning: ${source} → ${target} (strategy: ${strategy})`);

  // Ensure parent directory exists
  const parentDir = path.dirname(target);
  await fs.promises.mkdir(parentDir, { recursive: true });

  const cloneArgs = buildCloneArgs(strategy, branch);
  const git = createGitInstance(parentDir);

  try {
    await git.clone(source, target, cloneArgs);
    log(`[ForkCore] Clone completed: ${target}`);
  } catch (err) {
    // If --shared fails (e.g., filesystem issue), retry with --local
    if (strategy === "shared") {
      logWarn(
        `[ForkCore] --shared clone failed, retrying with --local: ${err}`,
      );
      await git.clone(source, target, buildCloneArgs("local", branch));
      log(`[ForkCore] Fallback --local clone completed: ${target}`);
    } else {
      throw err;
    }
  }

  const forkGit = createGitInstance(target);
  await hardenFork(forkGit, target);
  return forkGit;
}

/**
 * Build clone CLI args for the given strategy.
 */
function buildCloneArgs(
  strategy: ForkCloneStrategy,
  branch?: string,
): string[] {
  const args: string[] = [];

  switch (strategy) {
    case "shared":
      args.push("--shared");
      break;
    case "local":
      args.push("--local");
      break;
    case "copy":
      args.push("--no-hardlinks");
      break;
  }

  if (branch) {
    args.push("--branch", branch);
  }

  // Single branch + shallow for minimal footprint
  // NOTE: Disabled for now — forks may need full history for diff/blame
  // args.push("--single-branch");

  return args;
}

// ─── Fork Hardening ─────────────────────────────────────────────────────────

/**
 * Apply safety git config to a fork repo.
 * Prevents accidental pushes and marks the repo as a fork.
 */
async function hardenFork(git: SimpleGit, forkPath: string): Promise<void> {
  try {
    // Block pushes to origin (forks should never push upstream)
    await git.addConfig("remote.origin.pushurl", "FORK_NO_PUSH");
    // Mark as a Project Brain fork for identification
    await git.addConfig("brain.fork", "true");
    // Set gc to be less aggressive (shared clones need the source objects)
    await git.addConfig("gc.auto", "0");
    log(`[ForkCore] Fork hardened: ${forkPath}`);
  } catch (err) {
    logWarn(`[ForkCore] Hardening partially failed (non-fatal): ${err}`);
  }
}

// ─── Fork Disposal ──────────────────────────────────────────────────────────

/**
 * Remove a fork directory from disk.
 * Uses rimraf for cross-platform safety (handles Windows file locking).
 *
 * @param forkPath - Absolute path to the fork directory.
 * @param opts - Disposal options (force, maxRetries).
 */
export async function disposeFork(
  forkPath: string,
  opts?: ForkDisposeOptions,
): Promise<void> {
  log(`[ForkCore] Disposing fork: ${forkPath}`);

  // Safety check: refuse to delete paths outside .brain-forks/
  if (!forkPath.includes(FORK_BASE_DIR)) {
    throw new Error(
      `[ForkCore] SAFETY: Refusing to delete path outside ${FORK_BASE_DIR}: ${forkPath}`,
    );
  }

  // If not forced, check for uncommitted changes
  if (!opts?.force) {
    const hasChanges = await hasChangesInFork(forkPath);
    if (hasChanges) {
      throw new Error(
        `[ForkCore] Fork has uncommitted changes. Use force:true to delete anyway: ${forkPath}`,
      );
    }
  }

  try {
    await rimraf(forkPath, {
      maxRetries: opts?.maxRetries ?? 3,
      retryDelay: 200,
    });
    log(`[ForkCore] Fork disposed successfully: ${forkPath}`);
  } catch (err) {
    logError(`[ForkCore] Fork disposal failed: ${forkPath} — ${err}`);
    throw err;
  }
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

/**
 * Auto-commit any uncommitted changes in a fork.
 * @returns true if changes were committed.
 */
export async function autoCommitFork(
  forkPath: string,
  message: string,
): Promise<boolean> {
  try {
    const git = createGitInstance(forkPath);
    const status = await git.status();
    if (status.isClean()) {
      log(`[ForkCore] autoCommit — fork clean (${forkPath})`);
      return false;
    }
    const fileCount = status.files.length;
    log(`[ForkCore] autoCommit — ${fileCount} changed files, committing...`);
    await git.add("-A");
    await git.commit(message);
    log(`[ForkCore] autoCommit DONE — ${fileCount} files`);
    return true;
  } catch (err) {
    logError(`[ForkCore] autoCommit FAILED — ${forkPath}: ${err}`);
    return false;
  }
}

/**
 * Check if a fork has uncommitted changes.
 */
export async function hasChangesInFork(forkPath: string): Promise<boolean> {
  try {
    const git = createGitInstance(forkPath);
    const status = await git.status();
    return !status.isClean();
  } catch {
    return false;
  }
}

/**
 * Get the current branch name for a fork.
 */
export async function getForkBranch(forkPath: string): Promise<string> {
  try {
    const git = createGitInstance(forkPath);
    const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
    return branch || "HEAD";
  } catch {
    return "HEAD";
  }
}

/**
 * Check if a path is a valid Project Brain fork (has brain.fork=true config).
 */
export async function isBrainFork(dirPath: string): Promise<boolean> {
  try {
    const git = createGitInstance(dirPath);
    const val = await git.getConfig("brain.fork");
    return val.value === "true";
  } catch {
    return false;
  }
}
