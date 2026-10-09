/**
 * git-shared.ts — Shared low-level git execution primitives.
 *
 * Provides a generic `gitExec` wrapper used across multiple isolation
 * systems (checkpoints, shadow-worktree, worktree-core, etc.).
 * Extracted from worktree-core.ts to decouple path-agnostic operations
 * from worktree-specific logic.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Git operations timeout (shared constant). */
export const GIT_TIMEOUT_MS = 15_000;

/**
 * Execute a git command with timeout.
 * Returns stdout trimmed. Throws on non-zero exit.
 */
export async function gitExec(
  cwd: string,
  args: string[],
  timeout: number = GIT_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout });
  return stdout.trim();
}
