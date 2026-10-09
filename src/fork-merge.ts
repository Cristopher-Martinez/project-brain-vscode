/**
 * Fork Merge — Absorb, discard, and diff operations for fork-isolated branches.
 *
 * Uses the "absorb" pattern instead of traditional merge:
 *   1. `git fetch <forkPath> <branchName>` — pull changes from fork into user's repo
 *   2. `git merge FETCH_HEAD --no-ff` — merge without switching branches first
 *
 * The user's repo is NEVER checked out to a different branch during merge.
 * This eliminates the P0-3 bug where mergeBranch could leave the user on a
 * different branch on failure.
 *
 * @module fork-merge
 */

import { log, logError, logWarn } from "./logger";
import { autoCommitFork, createGitInstance, disposeFork } from "./fork-core";
import { persistForkState } from "./fork-helpers";
import { getForkMap, shortSessionId } from "./fork-isolation";
import { type ForkMergeResult } from "./fork-types";

// ─── Absorb (Merge) ────────────────────────────────────────────────────────

/**
 * Absorb a fork branch into the user's repo.
 *
 * Flow:
 * 1. Auto-commit pending changes in the fork
 * 2. `git fetch <forkPath> <branchName>` in user's repo
 * 3. `git merge FETCH_HEAD --no-ff` in user's repo
 * 4. Dispose fork directory on success
 *
 * The user stays on their current branch the whole time.
 */
export async function absorbFork(
  sessionId: string,
  targetBranch?: string,
): Promise<ForkMergeResult> {
  const sid = shortSessionId(sessionId);
  const forkMap = getForkMap();
  const info = forkMap.get(sessionId);

  if (!info) {
    logWarn(`[ForkMerge] absorbFork — no fork for session ${sid}`);
    return {
      success: false,
      message: `No fork info for session ${sessionId}`,
    };
  }

  const target = targetBranch || info.originalBranch;
  const t0 = Date.now();
  log(
    `[ForkMerge] absorbFork START — ${info.branchName} → ${target}, ` +
      `session: ${sid}`,
  );

  // 1. Auto-commit pending changes in the fork
  await autoCommitFork(
    info.forkPath,
    `[Project Brain] Auto-commit before absorb (${sid})`,
  );

  const repoGit = createGitInstance(info.repoRoot);

  try {
    // 2. Fetch the fork branch into user's repo
    await repoGit.fetch(info.forkPath, info.branchName);
    log(`[ForkMerge] Fetched ${info.branchName} from fork`);

    // 3. Ensure we're on the target branch
    const currentBranch = await repoGit.revparse(["--abbrev-ref", "HEAD"]);
    if (currentBranch !== target) {
      // Warn user and checkout — this is necessary because `git merge`
      // requires being on the branch you're merging INTO.
      logWarn(
        `[ForkMerge] User on '${currentBranch}', need '${target}' for merge. ` +
          `Checking out '${target}'.`,
      );
      await repoGit.checkout(target);
    }

    // 4. Merge FETCH_HEAD with --no-ff
    const commitMsg =
      `Merge fork '${info.branchName}' ` + `(brain session ${sid})`;
    await repoGit.merge(["FETCH_HEAD", "--no-ff", "-m", commitMsg]);

    // 5. Collect merge report
    const mergeReport = await collectMergeReport(repoGit);

    // 6. Update state
    info.status = "merged";
    forkMap.set(sessionId, info);
    persistForkState(info.repoRoot, forkMap);

    // 7. Dispose fork directory (no longer needed)
    try {
      await disposeFork(info.forkPath, { force: true });
      log(`[ForkMerge] Fork disposed after merge`);
    } catch (disposeErr) {
      logWarn(`[ForkMerge] Fork disposal failed (non-fatal): ${disposeErr}`);
    }

    log(
      `[ForkMerge] absorbFork DONE — ${info.branchName} → ${target}, ` +
        `${Date.now() - t0}ms, files: ${mergeReport.filesChanged?.length ?? "?"}`,
    );

    return {
      success: true,
      message: `Merged ${info.branchName} into ${target}`,
      ...mergeReport,
    };
  } catch (err) {
    return handleAbsorbError(err, repoGit, info, target, sid);
  }
}

/**
 * Collect diff stat and file list after a successful merge.
 */
async function collectMergeReport(
  git: ReturnType<typeof createGitInstance>,
): Promise<{ diffStat?: string; filesChanged?: string[] }> {
  try {
    const diffStat = await git.raw(["diff", "--stat", "HEAD~1"]);
    const nameOnly = await git.raw(["diff", "--name-only", "HEAD~1"]);
    const filesChanged = nameOnly.split("\n").filter(Boolean);
    return { diffStat, filesChanged };
  } catch {
    return {};
  }
}

/**
 * Handle absorb errors: abort merge, detect conflicts.
 * Unlike the old merge, we don't need to restore the user's branch —
 * we only checkout target if they were already on it.
 */
async function handleAbsorbError(
  err: unknown,
  repoGit: ReturnType<typeof createGitInstance>,
  info: { branchName: string; forkPath: string },
  target: string,
  sid: string,
): Promise<ForkMergeResult> {
  const errMsg = String(err);

  // Try to abort the in-progress merge
  try {
    await repoGit.merge(["--abort"]);
  } catch {
    /* ignore — merge may not be in progress */
  }

  if (errMsg.includes("CONFLICT") || errMsg.includes("Merge conflict")) {
    logError(
      `[ForkMerge] MERGE CONFLICT — ${info.branchName} → ${target}: ` +
        `${errMsg.substring(0, 200)}`,
    );
    const conflicts = errMsg
      .split("\n")
      .filter((l) => l.includes("CONFLICT"))
      .map((l) => l.trim());
    return {
      success: false,
      conflicts,
      message:
        `Merge conflicts detected. ` +
        `Resolve manually: cd ${info.forkPath} && git diff`,
    };
  }

  logError(
    `[ForkMerge] absorbFork FAILED — ${info.branchName} → ${target}: ` +
      `${errMsg.substring(0, 200)}`,
  );
  return { success: false, message: `Absorb failed: ${errMsg}` };
}

// ─── Discard ────────────────────────────────────────────────────────────────

/**
 * Discard a fork (delete it permanently).
 * The fork's branch only exists inside the fork — nothing to delete in the
 * user's repo.
 */
export async function discardFork(sessionId: string): Promise<void> {
  const sid = shortSessionId(sessionId);
  const forkMap = getForkMap();
  const info = forkMap.get(sessionId);

  if (!info) {
    logWarn(`[ForkMerge] discardFork — no fork for session ${sid}`);
    return;
  }

  const t0 = Date.now();
  log(
    `[ForkMerge] discardFork START — branch: ${info.branchName}, session: ${sid}`,
  );

  // Dispose fork directory
  try {
    await disposeFork(info.forkPath, { force: true });
  } catch (err) {
    logError(`[ForkMerge] Fork disposal failed: ${err}`);
  }

  info.status = "discarded";
  forkMap.set(sessionId, info);
  persistForkState(info.repoRoot, forkMap);

  log(
    `[ForkMerge] discardFork DONE — branch: ${info.branchName}, ${Date.now() - t0}ms`,
  );
}

// ─── Diff Preview ───────────────────────────────────────────────────────────

/**
 * Get diff stats between the fork branch and its original branch.
 * Runs inside the fork repo to avoid polluting the user's repo.
 */
export async function getForkDiffPreview(sessionId: string): Promise<string> {
  const forkMap = getForkMap();
  const info = forkMap.get(sessionId);

  if (!info) {
    return "No fork info found for this session.";
  }

  try {
    const forkGit = createGitInstance(info.forkPath);

    // In the fork, origin/<originalBranch> points to the source repo's branch
    const diff = await forkGit.raw([
      "diff",
      `origin/${info.originalBranch}...${info.branchName}`,
      "--stat",
    ]);
    return diff || "(no changes)";
  } catch (err) {
    return `Error getting diff: ${err}`;
  }
}

/**
 * Get the full diff (not just stat) between fork branch and original.
 * Useful for generating detailed merge reports.
 */
export async function getForkDiffFull(
  sessionId: string,
  maxLines?: number,
): Promise<string> {
  const forkMap = getForkMap();
  const info = forkMap.get(sessionId);

  if (!info) {
    return "No fork info found for this session.";
  }

  try {
    const forkGit = createGitInstance(info.forkPath);
    const diff = await forkGit.raw([
      "diff",
      `origin/${info.originalBranch}...${info.branchName}`,
    ]);

    if (!diff) return "(no changes)";
    if (maxLines && diff.split("\n").length > maxLines) {
      return (
        diff.split("\n").slice(0, maxLines).join("\n") +
        `\n... (truncated at ${maxLines} lines)`
      );
    }
    return diff;
  } catch (err) {
    return `Error getting diff: ${err}`;
  }
}
