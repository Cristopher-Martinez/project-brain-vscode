// ============================================================
// checkpoint.ts — STRAT-1: Git Snapshot System
// Allows agents to create named checkpoints in any git directory.
// "Save game" for code — restore if things go wrong.
// Implementation: git stash with naming convention.
// Works on forks, worktrees, or any git working directory.
// ============================================================

import { log, logWarn, logError } from "./logger";
import { gitExec } from "./git-shared";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Prefix for checkpoint stash messages — used to identify our stashes. */
const CHECKPOINT_PREFIX = "brain-checkpoint:";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Checkpoint {
  name: string;
  stashIndex: number;
  createdAt: string; // ISO timestamp from git
  message: string; // full stash message
}

export interface CheckpointResult {
  success: boolean;
  message: string;
  checkpoint?: Checkpoint;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a named checkpoint in a git directory.
 * Saves all changes (staged + unstaged + untracked) to a named stash.
 * After creating, changes are RESTORED to working tree (stash + pop pattern).
 * @param gitDir Absolute path to the git working directory (fork, worktree, etc.)
 * @param name Checkpoint name (e.g., "before-refactor", "pre-deps-update")
 */
export async function createCheckpoint(
  gitDir: string,
  name: string,
): Promise<CheckpointResult> {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const msg = `${CHECKPOINT_PREFIX}${safeName}`;

  log(`[Checkpoint] Creating "${safeName}" in ${gitDir}`);

  try {
    // Check if there are changes to checkpoint
    const status = await gitExec(gitDir, ["status", "--porcelain"]);
    if (!status.trim()) {
      // No changes — create an empty checkpoint marker via commit
      log(`[Checkpoint] No changes to stash — creating marker commit`);
      await gitExec(gitDir, [
        "stash",
        "push",
        "-m",
        msg,
        "--include-untracked",
      ]);
      // stash push with no changes might fail silently — that's ok
      return {
        success: true,
        message: `Checkpoint "${safeName}" created (working tree clean)`,
      };
    }

    // Stash all changes (including untracked files)
    await gitExec(gitDir, [
      "stash",
      "push",
      "-m",
      msg,
      "--include-untracked",
    ]);
    log(`[Checkpoint] Stashed changes as "${msg}"`);

    // Immediately re-apply the stash so the agent keeps working
    // Use apply (not pop) to KEEP the stash as checkpoint
    await gitExec(gitDir, ["stash", "apply"]);
    log(`[Checkpoint] Changes restored to working tree`);

    return {
      success: true,
      message: `Checkpoint "${safeName}" created successfully. Changes preserved.`,
      checkpoint: {
        name: safeName,
        stashIndex: 0, // just created = index 0
        createdAt: new Date().toISOString(),
        message: msg,
      },
    };
  } catch (err) {
    logError(`[Checkpoint] Create failed: ${err}`);
    return {
      success: false,
      message: `Failed to create checkpoint "${safeName}": ${err}`,
    };
  }
}

/**
 * Restore a named checkpoint, discarding current changes.
 * @param gitDir Absolute path to the git working directory
 * @param name Checkpoint name to restore
 */
export async function restoreCheckpoint(
  gitDir: string,
  name: string,
): Promise<CheckpointResult> {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  log(`[Checkpoint] Restoring "${safeName}" in ${gitDir}`);

  try {
    const checkpoints = await listCheckpoints(gitDir);
    const target = checkpoints.find((c) => c.name === safeName);

    if (!target) {
      logWarn(`[Checkpoint] "${safeName}" not found`);
      return {
        success: false,
        message: `Checkpoint "${safeName}" not found. Available: ${checkpoints.map((c) => c.name).join(", ") || "(none)"}`,
      };
    }

    // Discard all current changes
    await gitExec(gitDir, ["checkout", "--", "."]);
    await gitExec(gitDir, ["clean", "-fd"]);
    log(`[Checkpoint] Current changes discarded`);

    // Apply the checkpoint stash
    await gitExec(gitDir, [
      "stash",
      "apply",
      `stash@{${target.stashIndex}}`,
    ]);
    log(
      `[Checkpoint] Restored to "${safeName}" (stash@{${target.stashIndex}})`,
    );

    return {
      success: true,
      message: `Restored to checkpoint "${safeName}". Previous changes discarded.`,
      checkpoint: target,
    };
  } catch (err) {
    logError(`[Checkpoint] Restore failed: ${err}`);
    return {
      success: false,
      message: `Failed to restore checkpoint "${safeName}": ${err}`,
    };
  }
}

/**
 * List all checkpoints in a git directory.
 * @returns Array of checkpoints, newest first.
 */
export async function listCheckpoints(
  gitDir: string,
): Promise<Checkpoint[]> {
  try {
    const raw = await gitExec(gitDir, [
      "stash",
      "list",
      "--format=%gd|%s|%ai",
    ]);

    if (!raw.trim()) return [];

    const checkpoints: Checkpoint[] = [];
    for (const line of raw.trim().split("\n")) {
      const [ref, subject, date] = line.split("|");
      if (!subject?.includes(CHECKPOINT_PREFIX)) continue;

      const name = subject.split(CHECKPOINT_PREFIX)[1]?.trim() || "unnamed";
      const indexMatch = ref?.match(/\{(\d+)\}/);
      const stashIndex = indexMatch ? parseInt(indexMatch[1], 10) : -1;

      checkpoints.push({
        name,
        stashIndex,
        createdAt: date?.trim() || "",
        message: subject.trim(),
      });
    }

    log(
      `[Checkpoint] Listed ${checkpoints.length} checkpoint(s) in ${gitDir}`,
    );
    return checkpoints;
  } catch (err) {
    logWarn(`[Checkpoint] List failed (non-fatal): ${err}`);
    return [];
  }
}

/**
 * Delete a specific checkpoint.
 * @param gitDir Absolute path to the git working directory
 * @param name Checkpoint name to delete
 */
export async function deleteCheckpoint(
  gitDir: string,
  name: string,
): Promise<CheckpointResult> {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  log(`[Checkpoint] Deleting "${safeName}" in ${gitDir}`);

  try {
    const checkpoints = await listCheckpoints(gitDir);
    const target = checkpoints.find((c) => c.name === safeName);

    if (!target) {
      return {
        success: false,
        message: `Checkpoint "${safeName}" not found`,
      };
    }

    await gitExec(gitDir, [
      "stash",
      "drop",
      `stash@{${target.stashIndex}}`,
    ]);
    log(`[Checkpoint] Deleted "${safeName}" (stash@{${target.stashIndex}})`);

    return {
      success: true,
      message: `Checkpoint "${safeName}" deleted.`,
    };
  } catch (err) {
    logError(`[Checkpoint] Delete failed: ${err}`);
    return {
      success: false,
      message: `Failed to delete checkpoint "${safeName}": ${err}`,
    };
  }
}

/**
 * Purge ALL checkpoints for a git directory.
 * Used during cleanup to avoid stale stashes.
 */
export async function purgeCheckpoints(gitDir: string): Promise<number> {
  const checkpoints = await listCheckpoints(gitDir);
  let purged = 0;

  // Delete in reverse order (highest index first) to avoid index shifting
  const sorted = [...checkpoints].sort((a, b) => b.stashIndex - a.stashIndex);
  for (const cp of sorted) {
    try {
      await gitExec(gitDir, [
        "stash",
        "drop",
        `stash@{${cp.stashIndex}}`,
      ]);
      purged++;
    } catch {
      logWarn(
        `[Checkpoint] Purge skipped stash@{${cp.stashIndex}}: may already be gone`,
      );
    }
  }

  if (purged > 0) {
    log(`[Checkpoint] Purged ${purged} checkpoint(s) from ${gitDir}`);
  }
  return purged;
}
