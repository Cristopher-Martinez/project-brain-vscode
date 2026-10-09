/**
 * Branch Audit & Inspection — Extracted from branch-isolation.ts.
 * Handles checkout for inspection, return, and merge-compatibility auditing.
 * Also tracks audit history for trend analysis (Tier 2).
 */

import { log, logError } from "./logger";
import { forkGitCmd, shortSessionId } from "./fork-isolation";
import type { ForkIsolationInfo } from "./fork-types";
import { getIsolationInfo } from "./fork-queries";

// ─── Audit Types ────────────────────────────────────────────────────────────

export interface AuditResult {
  compatible: boolean;
  conflictFiles: string[];
  aheadBehind: { ahead: number; behind: number };
  diffSummary: string;
}

export interface AuditHistoryEntry {
  result: AuditResult;
  timestamp: number;
  targetBranch: string;
}

export type AuditTrend = "improving" | "stable" | "degrading" | "unknown";

// ─── Audit History ──────────────────────────────────────────────────────────

const auditHistory = new Map<string, AuditHistoryEntry[]>();

/** Get audit history for a session. */
export function getAuditHistory(sessionId: string): AuditHistoryEntry[] {
  return auditHistory.get(sessionId) ?? [];
}

/** Compute trend from audit history. */
export function getAuditTrend(sessionId: string): AuditTrend {
  const history = auditHistory.get(sessionId);
  if (!history || history.length < 2) return "unknown";

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  const prevScore = prev.result.conflictFiles.length;
  const currScore = curr.result.conflictFiles.length;

  if (prevScore > currScore) return "improving";
  if (prevScore < currScore) return "degrading";

  // Check ahead/behind changes
  const prevDrift = prev.result.aheadBehind.behind;
  const currDrift = curr.result.aheadBehind.behind;
  if (prevDrift > currDrift) return "improving";
  if (prevDrift < currDrift) return "degrading";

  return "stable";
}

/** Record an audit result in history. */
function recordAudit(
  sessionId: string,
  result: AuditResult,
  targetBranch: string,
): void {
  const entries = auditHistory.get(sessionId) ?? [];
  entries.push({ result, timestamp: Date.now(), targetBranch });
  // Keep last 10 entries per session
  if (entries.length > 10) entries.splice(0, entries.length - 10);
  auditHistory.set(sessionId, entries);
}

// ─── Branch Inspection ──────────────────────────────────────────────────────

/**
 * Checkout a fork's isolation branch for inspection.
 * Stashes current work inside the fork, switches to the isolation branch.
 * NOTE: Operates on info.forkPath (the fork clone), NEVER on the user's repo.
 */
export async function checkoutBranch(
  _repoRoot: string,
  sessionId: string,
): Promise<{ previousBranch: string; stashed: boolean }> {
  const info = getIsolationInfo(sessionId);
  if (!info)
    throw new Error(`[BranchAudit] No isolation info for ${sessionId}`);
  if (info.status !== "completed") {
    throw new Error(
      `[BranchAudit] Branch ${info.branchName} is ${info.status}, not completed`,
    );
  }

  const cwd = info.forkPath;
  const previousBranch = await forkGitCmd(cwd, [
    "branch",
    "--show-current",
  ]);

  // Stash if dirty (inside fork)
  let stashed = false;
  const status = await forkGitCmd(cwd, ["status", "--porcelain"]);
  if (status.length > 0) {
    await forkGitCmd(cwd, [
      "stash",
      "push",
      "-m",
      `brain-checkout-${shortSessionId(sessionId)}`,
    ]);
    stashed = true;
  }

  await forkGitCmd(cwd, ["checkout", info.branchName]);
  log(`[BranchAudit] Checked out branch: ${info.branchName} (in fork: ${cwd})`);
  return { previousBranch, stashed };
}

/**
 * Return from inspecting a branch back to the previous branch.
 * Operates inside the fork, NEVER the user's repo.
 */
export async function returnFromBranch(
  _repoRoot: string,
  previousBranch: string,
  restoreStash: boolean,
  sessionId?: string,
): Promise<void> {
  // Determine cwd: prefer forkPath when sessionId is available
  let cwd = _repoRoot;
  if (sessionId) {
    const info = getIsolationInfo(sessionId);
    if (info?.forkPath) cwd = info.forkPath;
  }
  await forkGitCmd(cwd, ["checkout", previousBranch]);
  if (restoreStash) {
    try {
      await forkGitCmd(cwd, ["stash", "pop"]);
    } catch (err) {
      logError(`[BranchAudit] stash pop failed: ${err}`);
    }
  }
  log(`[BranchAudit] Returned to ${previousBranch} (cwd: ${cwd})`);
}

// ─── Conflict Audit ─────────────────────────────────────────────────────────

/**
 * Audit a branch for merge compatibility against a target (default: main/original).
 * Does NOT modify the working tree — uses git merge-tree for dry-run.
 * Records result in audit history for trend tracking.
 * Operates inside the fork (info.forkPath), NEVER in the user's repo.
 */
export async function auditBranchCompatibility(
  _repoRoot: string,
  sessionId: string,
  targetBranch?: string,
): Promise<AuditResult> {
  const info = getIsolationInfo(sessionId);
  if (!info)
    throw new Error(`[BranchAudit] No isolation info for ${sessionId}`);

  const cwd = info.forkPath;
  const target = targetBranch || info.originalBranch;
  const result = await performAudit(cwd, info, target);

  // Record in history for trend tracking
  recordAudit(sessionId, result, target);

  log(
    `[BranchAudit] Audit ${info.branchName} vs ${target}: ` +
      `compatible=${result.compatible}, ahead=${result.aheadBehind.ahead}, behind=${result.aheadBehind.behind}`,
  );

  return result;
}

/** Internal: run the actual git audit operations. */
async function performAudit(
  repoRoot: string,
  info: ForkIsolationInfo,
  target: string,
): Promise<AuditResult> {
  // Ahead/behind count
  let ahead = 0;
  let behind = 0;
  try {
    const abStr = await forkGitCmd(repoRoot, [
      "rev-list",
      "--left-right",
      "--count",
      `${target}...${info.branchName}`,
    ]);
    const parts = abStr.split(/\s+/);
    behind = parseInt(parts[0], 10) || 0;
    ahead = parseInt(parts[1], 10) || 0;
  } catch {
    /* unable to compute */
  }

  // Diff summary (stat)
  let diffSummary = "(no changes)";
  try {
    diffSummary = await forkGitCmd(repoRoot, [
      "diff",
      "--stat",
      `${target}...${info.branchName}`,
    ]);
    if (!diffSummary) diffSummary = "(no changes)";
  } catch {
    /* ignore */
  }

  // Conflict detection: try merge in memory
  let compatible = true;
  let conflictFiles: string[] = [];
  try {
    const base = await forkGitCmd(repoRoot, [
      "merge-base",
      target,
      info.branchName,
    ]);
    const mergeResult = await forkGitCmd(repoRoot, [
      "merge-tree",
      base,
      target,
      info.branchName,
    ]);
    if (mergeResult.includes("<<<<<<<") || mergeResult.includes(">>>>>>>")) {
      compatible = false;
      // merge-tree (legacy) outputs conflict markers inline with file content.
      // Extract filenames from the "changed in both" sections or conflict markers.
      const lines = mergeResult.split("\n");
      const fileSet = new Set<string>();
      for (const line of lines) {
        // Legacy merge-tree prefixes conflicted sections with file info
        const markerMatch = line.match(/^<<<<<<< \.our\s*$/);
        if (markerMatch) continue; // marker line, skip
        // Look for "+++ b/<filename>" style headers in the output
        const diffHeader = line.match(/^\+\+\+ b\/(.+)/);
        if (diffHeader) {
          fileSet.add(diffHeader[1]);
          continue;
        }
        // Also try "changed in both" or similar merge-tree section headers
        const sectionMatch = line.match(/^([^\s].*\S)\s*$/);
        if (
          sectionMatch &&
          !line.startsWith("<") &&
          !line.startsWith(">") &&
          !line.startsWith("=") &&
          !line.startsWith("+") &&
          !line.startsWith("-") &&
          !line.startsWith("@") &&
          line.includes("/")
        ) {
          // Heuristic: standalone line with a path-like string
          fileSet.add(sectionMatch[1]);
        }
      }
      conflictFiles = Array.from(fileSet);
      if (conflictFiles.length === 0) {
        // Fallback: use diff --name-only to show which files differ
        try {
          const nameOnly = await forkGitCmd(repoRoot, [
            "diff",
            "--name-only",
            `${target}...${info.branchName}`,
          ]);
          if (nameOnly) {
            conflictFiles = nameOnly
              .split("\n")
              .filter(Boolean)
              .map((f) => `${f} (may conflict)`);
          }
        } catch {
          /* ignore */
        }
        if (conflictFiles.length === 0) {
          conflictFiles = ["(conflict detected — inspect branch for details)"];
        }
      }
    }
  } catch (err) {
    compatible = false;
    conflictFiles = [`Error during audit: ${err}`];
  }

  return {
    compatible,
    conflictFiles,
    aheadBehind: { ahead, behind },
    diffSummary,
  };
}
