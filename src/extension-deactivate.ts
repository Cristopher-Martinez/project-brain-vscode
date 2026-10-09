// ─── Extension Deactivation (extracted from extension.ts) ───────────────────
// Responsibility: clean shutdown of all services, session auto-save
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AdminDB } from "./admin-db";
import type { AutoCapture } from "./auto-capture";
import { shutdownBranchServices } from "./brain-hq-branch-handler";
import type { CronScheduler } from "./cron-scheduler";
import type { DualOpinionBank } from "./dual-opinion-bank";
import type { FolderState } from "./extension-types";
import type { GlobalKnowledgeManager } from "./global-knowledge";
import type { LearningIngester } from "./learning-ingester";
import type { LoginWebviewProvider } from "./login-webview";
import type { McpGateway } from "./mcp-gateway";
import type { OfflineManager } from "./offline-manager";
import type { OpinionBank } from "./opinion-bank";
import type { SessionDB } from "./session-db";
import { SessionManager } from "./session-manager";
import { stopAllHeartbeats } from "./loop-engine";
import { stopTerminalCwdGuard } from "./terminal-cwd-guard";

export interface DeactivateRefs {
  flushInterval: ReturnType<typeof setInterval> | null;
  reflectInterval: ReturnType<typeof setInterval> | null;
  learningIngester: LearningIngester | null;
  autoCapture: AutoCapture | null;
  opinionBank: OpinionBank | null;
  dualOpinionBank: DualOpinionBank | null;
  offlineManager: OfflineManager | null;
  loginWebview: LoginWebviewProvider | null;
  sessionDb: SessionDB | null;
  adminDb: AdminDB | null;
  cronScheduler: CronScheduler | null;
  statusBarItem: vscode.StatusBarItem | null;
  folderStates: Map<string, FolderState>;
  gateway: McpGateway | null;
  globalKnowledge: GlobalKnowledgeManager | null;
}

export async function deactivateExtension(refs: DeactivateRefs): Promise<void> {
  // Flush neuroplasticity before shutdown
  if (refs.flushInterval) {
    clearInterval(refs.flushInterval);
  }
  if (refs.reflectInterval) {
    clearInterval(refs.reflectInterval);
  }
  if (refs.learningIngester) {
    try {
      await refs.learningIngester.ingest();
      refs.learningIngester.dispose();
    } catch {
      /* best-effort */
    }
  }
  if (refs.autoCapture) {
    try {
      await refs.autoCapture.flushPending();
    } catch {
      /* best-effort */
    }
  }
  if (refs.opinionBank) {
    try {
      refs.opinionBank.flush();
      // Promote high-confidence opinions to global knowledge
      if (refs.globalKnowledge) {
        const allOpinions = refs.opinionBank.getOpinions();
        const projectName =
          vscode.workspace.workspaceFolders?.[0]?.name ?? "unknown";
        refs.globalKnowledge.promoteOpinions(allOpinions, projectName);
      }
    } catch {
      /* best-effort */
    }
  }

  // SaaS cleanup
  if (refs.dualOpinionBank) {
    try {
      await refs.dualOpinionBank.sync();
    } catch {
      /* best-effort */
    }
  }
  if (refs.offlineManager) {
    try {
      await refs.offlineManager.flush();
    } catch {
      /* best-effort */
    }
    try {
      refs.offlineManager.dispose();
    } catch {
      /* best-effort */
    }
  }
  if (refs.loginWebview) {
    try {
      refs.loginWebview.dispose();
    } catch {
      /* best-effort */
    }
  }

  // SessionDB cleanup
  if (refs.sessionDb) {
    try {
      refs.sessionDb.dispose();
    } catch {
      /* best-effort */
    }
  }
  if (refs.adminDb) {
    try {
      refs.adminDb.dispose();
    } catch {
      /* best-effort */
    }
  }
  if (refs.cronScheduler) {
    refs.cronScheduler.dispose();
  }
  // MCP Gateway shutdown (BEFORE neuroplasticity flush to prevent token leaks)
  if (refs.gateway) {
    try {
      await refs.gateway.stop();
    } catch {
      /* best-effort */
    }
  }
  // Branch isolation stale checker cleanup
  stopAllHeartbeats(); // Stop all loop heartbeat intervals before shutdown
  shutdownBranchServices();
  stopTerminalCwdGuard(); // INC-15
  if (refs.statusBarItem) {
    refs.statusBarItem.dispose();
  }

  // Auto-save session snapshot on deactivation
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        await autoSaveOnDeactivation(folder, refs.sessionDb);
      }
    }
  } catch {
    /* best-effort */
  }

  // Dispose all folder states
  const disposals: Promise<void>[] = [];
  for (const state of refs.folderStates.values()) {
    if (state.autoVectorizer) {
      disposals.push(state.autoVectorizer.stop().catch(() => {}));
      state.autoVectorizer.dispose();
    }
  }
  await Promise.allSettled(disposals);
  refs.folderStates.clear();
}

async function autoSaveOnDeactivation(
  folder: vscode.WorkspaceFolder,
  sessionDb: SessionDB | null,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const memoryFolder = config.get<string>(
    "memoryFolder",
    ".project-brain/memory",
  );
  const memoryPath = vscode.Uri.joinPath(folder.uri, memoryFolder);
  try {
    await vscode.workspace.fs.stat(memoryPath);
    const sm = new SessionManager(folder);
    sm.setSessionDbRef({ get: () => sessionDb });
    const existing = await sm.loadSession();
    await sm.autoSave(
      existing?.goals,
      existing?.completed,
      existing?.pending,
      existing?.decisions,
      existing?.notes
        ? existing.notes + "\n[Auto-saved on deactivation]"
        : "[Auto-saved on deactivation]",
    );

    try {
      const { SessionSummarizer } = require("./session-summarizer");
      const fsMemoryPath = path.join(folder.uri.fsPath, memoryFolder);
      if (fs.existsSync(fsMemoryPath)) {
        SessionSummarizer.writePendingContext(fsMemoryPath, folder.uri.fsPath);
      }
    } catch {
      /* best-effort */
    }
  } catch {
    /* memory folder doesn't exist — skip */
  }
}
