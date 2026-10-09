/** Brain HQ — Commit/Audit bypass toggle handlers (extracted from loop-handler). */

import * as vscode from "vscode";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import {
  getLoopState,
  loopSetAuditBypass,
  loopSetCommitBypass,
} from "./loop-engine";
import {
  readAuditState,
  readCommitState,
  writeAuditState,
  writeCommitState,
} from "./commit-session-ops";

/** Handle toggleCommitBypass message. */
export function handleToggleCommitBypass(
  msg: any,
  instance: BrainHqInstance,
): boolean {
  const tbSessionId = msg.sessionId as string;
  const tbEnabled = !!msg.enabled;
  if (!tbSessionId) return true;

  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath ?? process.cwd();

  const current = readCommitState(cwd, tbSessionId) ?? {
    editedSinceCommit: [],
    lastCommitTs: 0,
    lastSuggestionTs: null,
    commitCount: 0,
    suppressUntilFeedback: false,
  };
  current.commitBypass = tbEnabled;
  writeCommitState(cwd, tbSessionId, current);

  loopSetCommitBypass(tbSessionId, tbEnabled);

  const updated = getLoopState(tbSessionId);
  instance.panel.webview.postMessage({ type: "loopUpdate", data: updated });

  instance.ctx.log(
    `[BrainHQ] Commit bypass toggled: session=${tbSessionId} enabled=${tbEnabled}`,
  );
  return true;
}

/** Handle toggleAuditBypass message. */
export function handleToggleAuditBypass(
  msg: any,
  instance: BrainHqInstance,
): boolean {
  const abSessionId = msg.sessionId as string;
  const abEnabled = !!msg.enabled;
  if (!abSessionId) return true;

  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath ?? process.cwd();

  const auditCurrent = readAuditState(cwd, abSessionId) ?? {
    editedFiles: [],
    auditRound: 0,
    lastAuditTs: null,
    synthesisAttempts: 0,
    urgentMessages: [],
  };
  auditCurrent.auditBypass = abEnabled;
  writeAuditState(cwd, abSessionId, auditCurrent);

  loopSetAuditBypass(abSessionId, abEnabled);

  const abUpdated = getLoopState(abSessionId);
  instance.panel.webview.postMessage({ type: "loopUpdate", data: abUpdated });

  instance.ctx.log(
    `[BrainHQ] Audit bypass toggled: session=${abSessionId} enabled=${abEnabled}`,
  );
  return true;
}
