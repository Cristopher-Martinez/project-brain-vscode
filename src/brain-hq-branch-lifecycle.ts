/**
 * Brain HQ Branch Lifecycle — end-of-loop branch finalization.
 * Extracted from brain-hq-branch-handler.ts to respect the 400 LOC limit.
 */
import * as vscode from "vscode";
import {
  auditBranchCompatibility,
  getAuditHistory,
  getAuditTrend,
} from "./branch-audit";
import { startStaleChecker } from "./branch-stale-checker";
import { finalizeFork } from "./fork-isolation";
import { getIsolationInfo, listAllBranches } from "./fork-queries";
import { getLoopState } from "./loop-engine";
import { generateLoopReport } from "./loop-report-generator";

let staleCheckerStarted = false;

/** Ensure stale checker runs once we have pending branches. */
function ensureStaleChecker(
  repoRoot: string,
  postToWebview: (msg: unknown) => void,
): void {
  if (staleCheckerStarted) return;
  staleCheckerStarted = true;
  startStaleChecker(repoRoot, (result) => {
    postToWebview({ type: "staleBranches", data: result });
  });
}

/** Reset stale checker flag (call from shutdownBranchServices). */
export function resetStaleCheckerFlag(): void {
  staleCheckerStarted = false;
}

function getRepoRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Handle branch finalization when ending a loop session.
 * Call this from endLoopSession case before resetting.
 */
export async function handleEndLoopBranchIsolation(
  sessionId: string,
  logFn: (msg: string) => void,
  postToWebview?: (msg: unknown) => void,
): Promise<boolean> {
  const isolation = getIsolationInfo(sessionId);
  if (!isolation || isolation.status !== "active") return false;
  try {
    const repoRoot = getRepoRoot();
    if (!repoRoot) return false;

    // INC-14: Pre-merge conflict check — warn user before finalization
    try {
      const preAudit = await auditBranchCompatibility(repoRoot, sessionId);
      if (!preAudit.compatible) {
        logFn(`[BrainHQ] Pre-merge audit: CONFLICTS DETECTED for ${sessionId}`);
        if (postToWebview) {
          postToWebview({
            type: "preMergeWarning",
            sessionId,
            data: {
              conflictFiles: preAudit.conflictFiles,
              behind: preAudit.aheadBehind.behind,
            },
          });
        }
      }
    } catch (auditErr) {
      logFn(`[BrainHQ] Pre-merge audit skipped: ${auditErr}`);
    }

    await finalizeFork(repoRoot, sessionId);
    logFn(`[BrainHQ] Branch isolation finalized for ${sessionId}`);
    // Auto-generate executive report for the backlog
    try {
      const loopState = getLoopState(sessionId);
      const report = await generateLoopReport(
        repoRoot,
        sessionId,
        loopState,
        isolation,
      );
      if (report) {
        logFn(`[BrainHQ] Report generated: ${report.reportPath}`);
        if (postToWebview) {
          const allBranches = listAllBranches();
          postToWebview({ type: "allBranches", data: allBranches });
        }
      }
    } catch (reportErr) {
      logFn(`[BrainHQ] Report generation failed: ${reportErr}`);
    }
    // Start stale checker if not already running
    if (postToWebview) {
      ensureStaleChecker(repoRoot, postToWebview);
    }
    // Auto-audit so the user sees results immediately
    if (postToWebview) {
      try {
        const audit = await auditBranchCompatibility(repoRoot, sessionId);
        const trend = getAuditTrend(sessionId);
        const rawHist = getAuditHistory(sessionId);
        const history = rawHist.map((h) => ({
          compatible: h.result.compatible,
          conflicts: h.result.conflictFiles.length,
          behind: h.result.aheadBehind.behind,
          timestamp: h.timestamp,
        }));
        postToWebview({
          type: "branchAudit",
          sessionId,
          data: audit,
          trend,
          history,
        });
        logFn(
          `[BrainHQ] Auto-audit sent for ${sessionId}: compatible=${audit.compatible}`,
        );
      } catch (auditErr) {
        logFn(`[BrainHQ] Auto-audit failed for ${sessionId}: ${auditErr}`);
      }
    }
    return true;
  } catch (err) {
    logFn(`[BrainHQ] finalizeFork error: ${err}`);
    return false;
  }
}
