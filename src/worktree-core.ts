/**
 * worktree-core.ts — Git worktree operations for shadow-worktree system.
 *
 * Provides worktree-specific functions: create/remove worktrees and
 * link node_modules. Generic git execution lives in git-shared.ts.
 *
 * Only consumer: shadow-worktree.ts (STRAT-6).
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError, logWarn } from "./logger";
import { gitExec } from "./git-shared";

// ─── Worktree Operations ────────────────────────────────────────────────────

/**
 * Remove a worktree idempotently — no error if already gone.
 * Used by shadow-worktree for temporary merge environments.
 */
export async function removeWorktreeCore(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  log(`[WorktreeCore] removeWorktree — ${worktreePath}`);
  try {
    await gitExec(repoRoot, ["worktree", "remove", worktreePath, "--force"]);
    log(`[WorktreeCore] removeWorktree DONE — ${worktreePath}`);
  } catch (err) {
    const errMsg = String(err);
    if (
      errMsg.includes("is not a working tree") ||
      errMsg.includes("does not exist")
    ) {
      logWarn(`[WorktreeCore] removeWorktree — already gone: ${worktreePath}`);
    } else {
      logError(
        `[WorktreeCore] removeWorktree FAILED — ${worktreePath}: ${errMsg}`,
      );
    }
  }
}

// ─── STRAT-2: node_modules Symlink ──────────────────────────────────────────

/**
 * Create a junction/symlink from worktree's node_modules to main workspace's.
 * On Windows: uses junction (no admin required). On Unix: symlink.
 * Non-fatal — if it fails, the agent can still run `npm install`.
 * @returns true if link was created successfully.
 */
export async function linkNodeModules(
  repoRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const source = path.join(repoRoot, "node_modules");
  const target = path.join(worktreePath, "node_modules");

  try {
    // Check if source exists
    const stat = await fs.promises.stat(source).catch(() => null);
    if (!stat?.isDirectory()) {
      log("[WorktreeCore] No node_modules in main workspace — skipping link");
      return false;
    }

    // Check if target already exists
    const targetStat = await fs.promises.stat(target).catch(() => null);
    if (targetStat) {
      log(
        "[WorktreeCore] node_modules already exists in worktree — skipping link",
      );
      return false;
    }

    // Create junction (Windows) or symlink (Unix)
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.promises.symlink(source, target, linkType);
    log(
      `[WorktreeCore] node_modules linked: ${target} → ${source} (${linkType})`,
    );
    return true;
  } catch (err) {
    logWarn(`[WorktreeCore] node_modules link failed (non-fatal): ${err}`);
    return false;
  }
}
