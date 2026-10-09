/**
 * Stale Branch Checker & Cross-Session Conflict Detection.
 * Extracted from branch-audit.ts to keep files under 400 LOC.
 */

import * as vscode from "vscode";
import { log, logError } from "./logger";
import { discardFork } from "./fork-merge";
import { forkGitCmd } from "./fork-isolation";
import { listPendingBranches, listAllBranches } from "./fork-queries";

// ─── Constants ──────────────────────────────────────────────────────────────

const STALE_WARN_MS = 3 * 24 * 60 * 60_000; // 3 days
const STALE_DANGER_MS = 7 * 24 * 60 * 60_000; // 7 days
const CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes

// ─── Module State ───────────────────────────────────────────────────────────

let staleTimer: ReturnType<typeof setInterval> | null = null;
let staleInitialTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── Stale Check Types ─────────────────────────────────────────────────────

export interface StaleCheckResult {
  staleIds: string[];
  dangerIds: string[];
}

export type StaleCallback = (result: StaleCheckResult) => void;

// ─── Core Logic ─────────────────────────────────────────────────────────────

function checkStaleBranches(repoRoot: string): StaleCheckResult {
  const pending = listPendingBranches();
  const now = Date.now();
  const staleIds: string[] = [];
  const dangerIds: string[] = [];

  for (const b of pending) {
    const age = now - b.createdAt;
    if (age > STALE_DANGER_MS) {
      dangerIds.push(b.sessionId);
    } else if (age > STALE_WARN_MS) {
      staleIds.push(b.sessionId);
    }
  }
  return { staleIds, dangerIds };
}

// ─── Stale Checker Lifecycle ────────────────────────────────────────────────

export function startStaleChecker(
  repoRoot: string,
  onStale: StaleCallback,
): void {
  stopStaleChecker();
  log("[BranchAudit] Stale checker started (interval: 30min)");

  const run = () => {
    const result = checkStaleBranches(repoRoot);
    if (result.staleIds.length > 0 || result.dangerIds.length > 0) {
      onStale(result);

      // Show VS Code notification for danger-level branches
      if (result.dangerIds.length > 0) {
        const msg = `🏴‍☠️ ${result.dangerIds.length} branch(es) older than 7 days! Consider merging or discarding.`;
        vscode.window
          .showWarningMessage(msg, "Show Branches", "Auto-Discard")
          .then((action) => {
            if (action === "Show Branches") {
              vscode.commands.executeCommand("projectBrain.openBrainHQ");
            } else if (action === "Auto-Discard") {
              for (const id of result.dangerIds) {
                discardFork(id).catch((err) => {
                  logError(
                    `[BranchAudit] Auto-discard failed for ${id}: ${err}`,
                  );
                });
              }
            }
          });
      }
    }
  };

  // Initial check after 60s (tracked for cleanup)
  staleInitialTimeout = setTimeout(run, 60_000);
  staleTimer = setInterval(run, CHECK_INTERVAL_MS);
}

export function stopStaleChecker(): void {
  if (staleInitialTimeout) {
    clearTimeout(staleInitialTimeout);
    staleInitialTimeout = null;
  }
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
    log("[BranchAudit] Stale checker stopped");
  }
}

/**
 * Start global stale checker (not tied to Brain HQ webview).
 * VS Code notifications for danger-level branches are built into
 * startStaleChecker — the no-op callback just skips webview updates.
 */
export function startGlobalStaleChecker(repoRoot: string): void {
  startStaleChecker(repoRoot, () => {});
}

// ─── Cross-Session Conflict Detection ───────────────────────────────────────

export interface CrossSessionConflict {
  file: string;
  sessions: string[]; // sessionIds
}

/**
 * Detect files modified by multiple active sessions simultaneously.
 * Runs `git diff --name-only` for each active branch and finds overlaps.
 * @returns Array of conflicting files (empty if no overlap).
 */
export async function detectCrossSessionConflicts(
  repoRoot: string,
): Promise<CrossSessionConflict[]> {
  const active = listAllBranches().filter(
    (i) => i.status === "active" && i.branchName,
  );
  if (active.length < 2) return []; // need ≥2 sessions to conflict

  // Gather changed files per session (parallel)
  const filesBySession = await Promise.all(
    active.map(async (info) => {
      try {
        const cwd = info.forkPath || repoRoot;
        const raw = await forkGitCmd(cwd, [
          "diff",
          "--name-only",
          `${info.originalBranch}...${info.branchName}`,
        ]);
        return {
          sessionId: info.sessionId,
          files: raw.trim().split("\n").filter(Boolean),
        };
      } catch {
        return { sessionId: info.sessionId, files: [] as string[] };
      }
    }),
  );

  // Build file → sessions map
  const fileMap = new Map<string, string[]>();
  for (const { sessionId, files } of filesBySession) {
    for (const f of files) {
      const list = fileMap.get(f) || [];
      list.push(sessionId);
      fileMap.set(f, list);
    }
  }

  // Filter to files with ≥2 sessions
  const conflicts: CrossSessionConflict[] = [];
  for (const [file, sessions] of fileMap) {
    if (sessions.length >= 2) {
      conflicts.push({ file, sessions });
    }
  }

  if (conflicts.length > 0) {
    log(
      `[BranchAudit] Cross-session conflicts: ${conflicts.length} file(s) overlap across ${active.length} sessions`,
    );
  }
  return conflicts;
}
