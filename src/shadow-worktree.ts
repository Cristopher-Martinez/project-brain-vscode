/**
 * Shadow Worktree — STRAT-6
 *
 * Lets agents "debug as HEAD" without leaving their isolated worktree.
 * Creates a temporary merge environment that combines HEAD + agent changes,
 * runs a command (tsc, tests, etc.), captures output, and auto-cleans up.
 *
 * Flow:
 *   1. Pre-check: `git merge-tree` detects conflicts without touching filesystem
 *   2. If clean → create temp worktree from originalBranch
 *   3. Merge agent's branch into temp (--no-commit)
 *   4. Run user command (tsc --noEmit, npm test, etc.)
 *   5. Capture stdout/stderr
 *   6. Auto-cleanup: remove temp worktree + branch
 *
 * The agent's actual worktree is NEVER modified.
 * Design: pure async functions, fully testeable, heavily logged.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { getShadowDir } from "./brain-paths";
import { GIT_TIMEOUT_MS, gitExec } from "./git-shared";
import { log, logError, logWarn } from "./logger";
import { linkNodeModules, removeWorktreeCore } from "./worktree-core";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShadowTestResult {
  /** Whether the command succeeded (exit code 0). */
  success: boolean;
  /** Command stdout. */
  stdout: string;
  /** Command stderr. */
  stderr: string;
  /** Whether merge conflicts were detected (before running command). */
  hasConflicts: boolean;
  /** Conflict file list (if any). */
  conflictFiles: string[];
  /** Total execution time in ms. */
  durationMs: number;
  /** The temp branch name used (for debugging). */
  tempBranch: string;
}

export interface ShadowTestOptions {
  /** The command to run in the merged environment. */
  command: string;
  /** Command args (default: none). */
  args?: string[];
  /** Timeout in ms (default: 60_000). */
  timeout?: number;
  /** Whether to link node_modules from main repo (default: true). */
  linkDeps?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Shadow dir resolved via brain-paths.
const SHADOW_PREFIX = "brain/shadow/";
const COMMAND_TIMEOUT = 60_000;

/** Track active shadow tests per session to prevent concurrent runs. */
const activeShadowSessions = new Set<string>();

/**
 * Guard: acquire a shadow test slot for a session.
 * Returns false if the session already has one running.
 */
export function acquireShadowSlot(sessionId: string): boolean {
  if (activeShadowSessions.has(sessionId)) {
    logWarn(
      `[Shadow] Session ${sessionId.substring(0, 8)} already has an active shadow test`,
    );
    return false;
  }
  activeShadowSessions.add(sessionId);
  log(`[Shadow] Slot acquired for session ${sessionId.substring(0, 8)}`);
  return true;
}

/** Release the shadow test slot for a session. */
export function releaseShadowSlot(sessionId: string): void {
  activeShadowSessions.delete(sessionId);
  log(`[Shadow] Slot released for session ${sessionId.substring(0, 8)}`);
}

// ─── Pre-check: Conflict Detection ──────────────────────────────────────────

/**
 * Check if merging the agent's branch into originalBranch would produce conflicts.
 * Uses `git merge-tree` (Git 2.38+) — no filesystem changes.
 *
 * @returns Object with hasConflicts flag and conflictFiles list
 */
export async function checkMergeConflicts(
  repoRoot: string,
  agentBranch: string,
  targetBranch: string,
): Promise<{ hasConflicts: boolean; conflictFiles: string[] }> {
  try {
    const mergeBase = await gitExec(repoRoot, [
      "merge-base",
      targetBranch,
      agentBranch,
    ]);
    log(`[Shadow] merge-base: ${mergeBase.substring(0, 8)}`);

    // git merge-tree (old form) — always available
    const result = await gitExec(
      repoRoot,
      ["merge-tree", mergeBase, targetBranch, agentBranch],
      GIT_TIMEOUT_MS,
    );

    // merge-tree outputs conflict markers if conflicts exist
    const conflictPattern = /<{7}/m;
    const hasConflicts = conflictPattern.test(result);

    const conflictFiles: string[] = [];
    if (hasConflicts) {
      // Extract filenames from "changed in both" sections
      const filePattern = /^ {2}our\s+\d+\s+\w+\s+(.+)$/gm;
      let match: RegExpExecArray | null;
      while ((match = filePattern.exec(result)) !== null) {
        conflictFiles.push(match[1]);
      }
      logWarn(`[Shadow] Merge conflicts detected: ${conflictFiles.join(", ")}`);
    } else {
      log("[Shadow] No merge conflicts — clean merge possible");
    }

    return { hasConflicts, conflictFiles };
  } catch (err) {
    logWarn(`[Shadow] merge-tree check failed (non-fatal): ${err}`);
    return { hasConflicts: false, conflictFiles: [] };
  }
}

// ─── Shadow Test Execution ──────────────────────────────────────────────────

/**
 * Run a command in a "shadow" merged environment.
 * Creates a temp worktree with HEAD + agent changes, runs the command, cleans up.
 *
 * @param repoRoot — Main workspace root
 * @param agentBranch — Agent's isolated branch name
 * @param originalBranch — The HEAD/target branch to merge onto
 * @param options — Command and config
 * @returns ShadowTestResult with success, output, conflicts, timing
 */
export async function runShadowTest(
  repoRoot: string,
  agentBranch: string,
  originalBranch: string,
  options: ShadowTestOptions,
): Promise<ShadowTestResult> {
  const t0 = Date.now();
  const rnd = Math.random().toString(36).substring(2, 6);
  const tempId = `${Date.now().toString(36)}-${rnd}`;
  const tempBranch = `${SHADOW_PREFIX}${tempId}`;
  const shadowPath = path.join(getShadowDir(repoRoot), tempId);

  log(
    `[Shadow] START — agent: ${agentBranch}, target: ${originalBranch}, cmd: "${options.command}"`,
  );

  // Step 1: Pre-check conflicts
  const { hasConflicts, conflictFiles } = await checkMergeConflicts(
    repoRoot,
    agentBranch,
    originalBranch,
  );

  if (hasConflicts) {
    log(
      `[Shadow] Aborted — merge conflicts in ${conflictFiles.length} file(s)`,
    );
    return {
      success: false,
      stdout: "",
      stderr: `Merge conflicts detected in: ${conflictFiles.join(", ")}`,
      hasConflicts: true,
      conflictFiles,
      durationMs: Date.now() - t0,
      tempBranch,
    };
  }

  try {
    // Step 2: Create temp branch from originalBranch
    await gitExec(repoRoot, ["branch", tempBranch, originalBranch]);
    log(`[Shadow] Temp branch created: ${tempBranch}`);

    // Step 3: Create temp worktree
    await fs.promises.mkdir(path.dirname(shadowPath), { recursive: true });
    await gitExec(repoRoot, ["worktree", "add", shadowPath, tempBranch]);
    log(`[Shadow] Temp worktree created: ${shadowPath}`);

    // Step 4: Link node_modules (if requested)
    if (options.linkDeps !== false) {
      await linkNodeModules(repoRoot, shadowPath);
    }

    // Step 5: Merge agent's branch (--no-commit so we can test without committing)
    await gitExec(
      shadowPath,
      ["merge", "--no-commit", "--no-ff", agentBranch],
      GIT_TIMEOUT_MS,
    );
    log("[Shadow] Agent branch merged into shadow (no-commit)");

    // Step 6: Run command
    const result = await runCommand(
      shadowPath,
      options.command,
      options.args || [],
      options.timeout || COMMAND_TIMEOUT,
    );

    log(
      `[Shadow] Command ${result.success ? "PASSED" : "FAILED"} in ${Date.now() - t0}ms`,
    );

    return {
      ...result,
      hasConflicts: false,
      conflictFiles: [],
      durationMs: Date.now() - t0,
      tempBranch,
    };
  } catch (err) {
    logError(`[Shadow] Execution failed: ${err}`);
    return {
      success: false,
      stdout: "",
      stderr: String(err),
      hasConflicts: false,
      conflictFiles: [],
      durationMs: Date.now() - t0,
      tempBranch,
    };
  } finally {
    // Step 7: Cleanup — ALWAYS runs
    await cleanupShadow(repoRoot, shadowPath, tempBranch);
  }
}

// ─── Internal ───────────────────────────────────────────────────────────────

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  timeout: number,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    log(`[Shadow] Running: ${command} ${args.join(" ")}`);
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      shell: true,
    });
    return {
      success: true,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      success: false,
      stdout: truncateOutput(execErr.stdout || ""),
      stderr: truncateOutput(execErr.stderr || String(err)),
    };
  }
}

async function cleanupShadow(
  repoRoot: string,
  shadowPath: string,
  tempBranch: string,
): Promise<void> {
  try {
    // Remove worktree first
    await removeWorktreeCore(repoRoot, shadowPath);
    // Remove temp branch
    await gitExec(repoRoot, ["branch", "-D", tempBranch]).catch(() => {
      /* branch may not exist */
    });
    // Remove shadow directory
    await fs.promises
      .rm(shadowPath, { recursive: true, force: true })
      .catch(() => {
        /* dir may not exist */
      });
    log(`[Shadow] Cleanup done — ${tempBranch}`);
  } catch (err) {
    logWarn(`[Shadow] Cleanup incomplete (non-fatal): ${err}`);
  }
}

function truncateOutput(text: string, maxLen: number = 8_000): string {
  if (text.length <= maxLen) return text;
  return (
    text.substring(0, maxLen) +
    `\n... (truncated, ${text.length - maxLen} chars omitted)`
  );
}
