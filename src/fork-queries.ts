/**
 * Fork Queries — Query & utility functions for fork isolation.
 *
 * Replaces branch-isolation-queries.ts. Operates on the shared forkMap
 * from fork-isolation.ts.
 *
 * @module fork-queries
 */

import { log } from "./logger";
import { createGitInstance } from "./fork-core";
import { getForkMap, forkGitCmd, shortSessionId } from "./fork-isolation";
import { persistForkState } from "./fork-helpers";
import { type ForkIsolationInfo } from "./fork-types";

// ─── Re-export types for backward compatibility ─────────────────────────────

export type { ForkIsolationInfo as BranchIsolationInfo } from "./fork-types";

// ─── Queries ────────────────────────────────────────────────────────────────

/** List forks with status 'completed' (ready for merge/discard decision). */
export function listPendingBranches(): ForkIsolationInfo[] {
  return Array.from(getForkMap().values()).filter(
    (i) => i.status === "completed",
  );
}

/** Get all fork infos (any status). */
export function listAllBranches(): ForkIsolationInfo[] {
  return Array.from(getForkMap().values());
}

/** Get fork info for a specific session. */
export function getIsolationInfo(
  sessionId: string,
): ForkIsolationInfo | undefined {
  return getForkMap().get(sessionId);
}

/** Check if there's an active loop fork. */
export function hasActiveLoopIsolation(): boolean {
  for (const [, info] of getForkMap()) {
    if (info.type === "loop" && info.status === "active") return true;
  }
  return false;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/**
 * Rename a branch inside a fork (git branch -m).
 */
export async function renameBranch(
  repoRoot: string,
  sessionId: string,
  newName: string,
): Promise<{ success: boolean; message: string }> {
  const map = getForkMap();
  const info = map.get(sessionId);
  if (!info) {
    return {
      success: false,
      message: `No fork info for session ${sessionId}`,
    };
  }

  const sanitized = newName
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-");
  const fullName = sanitized.startsWith("brain/")
    ? sanitized
    : `brain/loop/${sanitized}`;

  try {
    // Rename inside the fork repo, not the user's repo
    const forkGit = createGitInstance(info.forkPath);
    await forkGit.branch(["-m", info.branchName, fullName]);

    const oldName = info.branchName;
    info.branchName = fullName;
    map.set(sessionId, info);
    persistForkState(repoRoot, map);
    log(`[ForkQueries] Renamed branch: ${oldName} → ${fullName}`);
    return { success: true, message: `Renamed to ${fullName}` };
  } catch (err) {
    return { success: false, message: `Rename failed: ${err}` };
  }
}

/**
 * Update the summary and report path for a fork.
 */
export function updateBranchMeta(
  sessionId: string,
  meta: { summary?: string; reportPath?: string; description?: string },
): void {
  const map = getForkMap();
  const info = map.get(sessionId);
  if (!info) return;
  if (meta.summary !== undefined) info.summary = meta.summary;
  if (meta.reportPath !== undefined) info.reportPath = meta.reportPath;
  if (meta.description !== undefined) info.description = meta.description;
  map.set(sessionId, info);
}
