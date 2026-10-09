// ─── Auto-Save Listener (extracted from extension.ts) ───────────────────────
// Watches file saves and auto-saves session context (debounced, throttled).
import * as vscode from "vscode";
import type { GetStateFn } from "./extension-types";
import type { SessionDB } from "./session-db";
import { SessionManager } from "./session-manager";

export interface AutoSaveListenerDeps {
  getSessionDb: () => SessionDB | null;
  getState: GetStateFn;
  log: (msg: string) => void;
}

let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSessionSave = 0;

/** Set up auto-save listener that triggers on file saves */
export function setupAutoSaveListener(
  context: vscode.ExtensionContext,
  deps: AutoSaveListenerDeps,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = vscode.workspace.getConfiguration("projectBrain");
      if (!config.get<boolean>("autoSessionSave", true)) return;
      if (
        doc.fileName.includes("07_SESSION_HANDOFF") ||
        doc.fileName.includes(".project-brain-session")
      )
        return;

      const intervalMs = config.get<number>("autoSessionInterval", 120) * 1000;
      const now = Date.now();
      if (now - lastSessionSave < intervalMs) return;
      if (sessionSaveTimer) clearTimeout(sessionSaveTimer);

      sessionSaveTimer = setTimeout(async () => {
        try {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders) return;
          for (const folder of folders) {
            const memoryFolder = config.get<string>(
              "memoryFolder",
              ".project-brain/memory",
            );
            const memoryPath = vscode.Uri.joinPath(folder.uri, memoryFolder);
            try {
              await vscode.workspace.fs.stat(memoryPath);
            } catch {
              continue;
            }

            const sm = new SessionManager(folder);
            sm.setSessionDbRef({ get: deps.getSessionDb });
            const existing = await sm.loadSession();
            await sm.autoSave(
              existing?.goals,
              existing?.completed,
              existing?.pending,
              existing?.decisions,
              existing?.notes,
            );
            if (sm.needsVectorization()) {
              const state = deps.getState(folder, context);
              if (state.mcpManager) {
                deps.log(
                  "Memory docs changed — triggering smart vectorization",
                );
                try {
                  await state.mcpManager.indexProject();
                  sm.markVectorized();
                  deps.log("Smart vectorization complete");
                } catch (err) {
                  deps.log(`Smart vectorization failed: ${err}`);
                }
              }
            }
          }
          lastSessionSave = Date.now();
          deps.log("Session auto-saved (triggered by file save)");
        } catch (err) {
          deps.log(`Session auto-save error: ${err}`);
        }
      }, 2000);
    }),
  );
}
