/**
 * Brain HQ message handler — Branch Isolation / Merge Gate cases.
 * Extracted to keep brain-hq-message-handler.ts under 400 lines.
 */
import * as vscode from "vscode";
import { resetStaleCheckerFlag } from "./brain-hq-branch-lifecycle";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import {
  auditBranchCompatibility,
  checkoutBranch,
  getAuditHistory,
  getAuditTrend,
  returnFromBranch,
} from "./branch-audit";
import { stopStaleChecker } from "./branch-stale-checker";
import { absorbFork, discardFork, getForkDiffPreview } from "./fork-merge";
import {
  getIsolationInfo,
  listAllBranches,
  listPendingBranches,
  renameBranch,
  updateBranchMeta,
} from "./fork-queries";

/** Track checkout state per session so we can return properly */
const checkoutState = new Map<
  string,
  { previousBranch: string; stashed: boolean }
>();

/** Stop the stale checker (call on extension deactivation). */
export function shutdownBranchServices(): void {
  stopStaleChecker();
  resetStaleCheckerFlag();
}

/**
 * Handle branch-isolation related messages from Brain HQ webview.
 * Returns true if the message was handled, false otherwise.
 */
export async function handleBranchMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "requestPendingBranches": {
      const pending = listPendingBranches();
      instance.panel.webview.postMessage({
        type: "pendingBranches",
        data: pending,
      });
      return true;
    }

    case "requestAllBranches": {
      const allBranches = listAllBranches();
      instance.panel.webview.postMessage({
        type: "allBranches",
        data: allBranches,
      });
      return true;
    }

    case "requestAvailableBranches": {
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const { forkGitCmd } = await import("./fork-isolation");
        const raw = await forkGitCmd(repoRoot, [
          "branch",
          "--format=%(refname:short)",
        ]);
        const branches = raw.split("\n").filter((b) => b.trim().length > 0);
        instance.panel.webview.postMessage({
          type: "availableBranches",
          data: branches,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] requestAvailableBranches error: ${err}`);
      }
      return true;
    }

    case "getDiffPreview": {
      const dpSessionId = msg.sessionId as string;
      if (!dpSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const diff = await getForkDiffPreview(dpSessionId);
        instance.panel.webview.postMessage({
          type: "diffPreview",
          sessionId: dpSessionId,
          data: diff,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] getDiffPreview error: ${err}`);
      }
      return true;
    }

    case "mergeBranch": {
      const mbSessionId = msg.sessionId as string;
      if (!mbSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const result = await absorbFork(mbSessionId);
        instance.panel.webview.postMessage({
          type: "mergeResult",
          sessionId: mbSessionId,
          data: result,
        });
        // INC-10: Emit merge report with diff stats if available
        if (result.success && (result.diffStat || result.filesChanged)) {
          instance.panel.webview.postMessage({
            type: "mergeReport",
            sessionId: mbSessionId,
            data: {
              diffStat: result.diffStat ?? "(no diff)",
              filesChanged: result.filesChanged ?? [],
              filesCount: result.filesChanged?.length ?? 0,
            },
          });
        }
        if (result.success) {
          vscode.window.showInformationMessage(
            `Branch merged: ${result.message}`,
          );
        } else {
          vscode.window.showWarningMessage(`Merge issue: ${result.message}`);
        }
      } catch (err) {
        instance.ctx.log(`[BrainHQ] mergeBranch error: ${err}`);
      }
      return true;
    }

    case "discardBranch": {
      const dbSessionId = msg.sessionId as string;
      if (!dbSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        await discardFork(dbSessionId);
        instance.panel.webview.postMessage({
          type: "branchDiscarded",
          sessionId: dbSessionId,
        });
        vscode.window.showInformationMessage("Branch discarded successfully.");
      } catch (err) {
        instance.ctx.log(`[BrainHQ] discardBranch error: ${err}`);
      }
      return true;
    }

    case "keepBranch": {
      const kbSessionId = msg.sessionId as string;
      if (!kbSessionId) return true;
      const info = getIsolationInfo(kbSessionId);
      if (info) {
        instance.ctx.log(`[BrainHQ] Branch kept for later: ${info.branchName}`);
        vscode.window.showInformationMessage(
          `Branch ${info.branchName} kept — you can merge it manually later.`,
        );
      }
      return true;
    }

    case "openBranch": {
      const obSessionId = msg.sessionId as string;
      if (!obSessionId) return true;
      const info = getIsolationInfo(obSessionId);
      if (info?.forkPath) {
        const forkUri = vscode.Uri.file(info.forkPath);
        await vscode.commands.executeCommand("vscode.openFolder", forkUri, {
          forceNewWindow: true,
        });
        instance.ctx.log(
          `[BrainHQ] Opened fork in new window: ${info.forkPath}`,
        );
      } else {
        vscode.window.showWarningMessage("No fork path found for this branch.");
      }
      return true;
    }

    case "checkoutBranch": {
      const cbSessionId = msg.sessionId as string;
      if (!cbSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const result = await checkoutBranch(repoRoot, cbSessionId);
        checkoutState.set(cbSessionId, result);
        instance.panel.webview.postMessage({
          type: "branchCheckedOut",
          sessionId: cbSessionId,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] checkoutBranch error: ${err}`);
        vscode.window.showErrorMessage(`Failed to checkout branch: ${err}`);
      }
      return true;
    }

    case "returnFromBranch": {
      const rfSessionId = msg.sessionId as string;
      if (!rfSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const state = checkoutState.get(rfSessionId);
        if (!state) {
          instance.ctx.log(`[BrainHQ] No checkout state for ${rfSessionId}`);
          return true;
        }
        await returnFromBranch(repoRoot, state.previousBranch, state.stashed, rfSessionId);
        checkoutState.delete(rfSessionId);
        instance.panel.webview.postMessage({
          type: "branchReturned",
          sessionId: rfSessionId,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] returnFromBranch error: ${err}`);
        vscode.window.showErrorMessage(`Failed to return from branch: ${err}`);
      }
      return true;
    }

    case "openForkInVSCode": {
      const ofSessionId = msg.sessionId as string;
      if (!ofSessionId) return true;
      try {
        const info = getIsolationInfo(ofSessionId);
        if (!info?.forkPath) {
          vscode.window.showWarningMessage("No fork path found for this session.");
          return true;
        }
        const uri = vscode.Uri.file(info.forkPath);
        await vscode.commands.executeCommand("vscode.openFolder", uri, true);
      } catch (err) {
        instance.ctx.log(`[BrainHQ] openForkInVSCode error: ${err}`);
        vscode.window.showErrorMessage(`Failed to open fork: ${err}`);
      }
      return true;
    }

    case "auditBranch": {
      const abSessionId = msg.sessionId as string;
      if (!abSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const audit = await auditBranchCompatibility(repoRoot, abSessionId);
        const trend = getAuditTrend(abSessionId);
        const rawHistory = getAuditHistory(abSessionId);
        const history = rawHistory.map((h) => ({
          compatible: h.result.compatible,
          conflicts: h.result.conflictFiles.length,
          behind: h.result.aheadBehind.behind,
          timestamp: h.timestamp,
        }));
        instance.panel.webview.postMessage({
          type: "branchAudit",
          sessionId: abSessionId,
          data: audit,
          trend,
          history,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] auditBranch error: ${err}`);
      }
      return true;
    }

    case "requestBranchChanges": {
      const rcSessionId = msg.sessionId as string;
      const instructions = (msg.instructions as string) || "";
      if (!rcSessionId) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        // Checkout the branch first so the loop works on it
        const coResult = await checkoutBranch(repoRoot, rcSessionId);
        checkoutState.set(rcSessionId, coResult);
        // TODO(Tier3): When the sub-loop ends, we should auto-return to the
        // original branch. Currently the branch stays checked out after the
        // fix-loop finishes, which can confuse state. Needs an "onLoopEnd"
        // callback or event listener to call returnFromBranch automatically.
        // Launch a new loop session on this branch
        const loopSid = `branch-fix-${rcSessionId}-${Date.now()}`;
        const branchInfo = getIsolationInfo(rcSessionId);
        const branchName = branchInfo?.branchName ?? rcSessionId;
        const goal = instructions
          ? `Aplica cambios en branch ${branchName}: ${instructions}`
          : `Revisa y mejora el código en branch ${branchName}`;
        await vscode.commands.executeCommand(
          "projectBrain.launchLoopSession",
          loopSid,
          goal,
          false, // No nested branch isolation
        );
        instance.panel.webview.postMessage({
          type: "branchChangesStarted",
          sessionId: rcSessionId,
          loopSessionId: loopSid,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] requestBranchChanges error: ${err}`);
        vscode.window.showErrorMessage(`Failed to start changes loop: ${err}`);
      }
      return true;
    }

    case "renameBranch": {
      const rnSessionId = msg.sessionId as string;
      const newName = msg.newName as string;
      if (!rnSessionId || !newName) return true;
      try {
        const repoRoot = getRepoRoot();
        if (!repoRoot) return true;
        const result = await renameBranch(repoRoot, rnSessionId, newName);
        instance.panel.webview.postMessage({
          type: "branchRenamed",
          sessionId: rnSessionId,
          newName: result.success ? newName : "",
          success: result.success,
          message: result.message,
        });
        if (result.success) {
          const allBranches = listAllBranches();
          instance.panel.webview.postMessage({
            type: "allBranches",
            data: allBranches,
          });
          const pending = listPendingBranches();
          instance.panel.webview.postMessage({
            type: "pendingBranches",
            data: pending,
          });
        }
      } catch (err) {
        instance.ctx.log(`[BrainHQ] renameBranch error: ${err}`);
      }
      return true;
    }

    case "updateBranchSummary": {
      const ubSessionId = msg.sessionId as string;
      const summary = msg.summary as string;
      if (!ubSessionId) return true;
      updateBranchMeta(ubSessionId, { summary });
      const allBranches = listAllBranches();
      instance.panel.webview.postMessage({
        type: "allBranches",
        data: allBranches,
      });
      return true;
    }

    default:
      return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRepoRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}
