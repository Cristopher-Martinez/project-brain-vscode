// ─── Session Commands (extracted from extension.ts) ─────────────────────────
// Responsibility: saveSession, resumeSession, spawnSession commands
import * as path from "path";
import * as vscode from "vscode";
import { OpinionBank } from "./opinion-bank";
import { SessionManager } from "./session-manager";
import { SessionSpawner } from "./session-spawner";
import type { AutoCapture } from "./auto-capture";
import type { SessionDB } from "./session-db";

export interface SessionCommandsDeps {
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
  getSessionDb: () => SessionDB | null;
  getAutoCapture: () => AutoCapture | null;
  getGetState: () => (
    folder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
  ) => import("./extension-types").FolderState;
  log: (msg: string) => void;
}

export function registerSessionCommands(
  context: vscode.ExtensionContext,
  deps: SessionCommandsDeps,
): void {
  // ─── Spawn Session ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.spawnSession",
      async (rawArgs?: unknown) => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const spawner = new SessionSpawner(folder, deps.log);

        try {
          const config = vscode.workspace.getConfiguration("projectBrain");
          const memoryFolder = config.get<string>(
            "memoryFolder", ".project-brain/memory",
          );
          const mp = path.join(folder.uri.fsPath, memoryFolder);
          const spawnBank = new OpinionBank(mp, deps.log);
          const { AutoCapture: AC } = require("./auto-capture");
          const spawnCapture = new AC(spawnBank, deps.log);
          spawner.setNeuroplasticity(spawnCapture, spawnBank);
        } catch {
          /* non-fatal */
        }

        let args:
          | {
              reason?: string;
              task?: string;
              silent?: boolean;
              conversationSummary?: string;
            }
          | undefined;
        if (rawArgs && typeof rawArgs === "object") {
          args = rawArgs as typeof args;
        } else if (typeof rawArgs === "string") {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            /* ignore */
          }
        }

        if (args?.silent === false) {
          await spawner.interactiveSpawn();
        } else {
          await spawner.quickSpawn(
            args?.reason,
            args?.task,
            args?.conversationSummary,
          );
        }
      },
    ),
  );

  // ─── Save Session ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.saveSession", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const sm = new SessionManager(folder);
      sm.setSessionDbRef({ get: () => deps.getSessionDb() });

      const existing = await sm.loadSession();
      const savedPath = await sm.autoSave(
        existing?.goals,
        existing?.completed,
        existing?.pending,
        existing?.decisions,
        existing?.notes,
      );

      // Flush neuroplasticity on session save
      const autoCapture = deps.getAutoCapture();
      if (autoCapture) {
        try {
          const flushed = await autoCapture.flushPending();
          if (flushed > 0)
            deps.log(
              `[Flush] Session save: ${flushed} pending captures drained`,
            );
        } catch (e) {
          deps.log(`[Flush] Error during session save flush: ${e}`);
        }
      }

      deps.log(`Session saved to ${savedPath}`);
      vscode.window.showInformationMessage(
        "Session saved! Context captured automatically.",
      );

      // Re-vectorize
      const getState = deps.getGetState();
      const state = getState(folder, context);
      if (state.autoVectorizer?.isActive()) {
        deps.log("Auto-vectorizer will pick up session file");
      } else {
        try {
          await state.mcpManager.indexProject();
          deps.log("Session re-indexed for RAG search");
        } catch (err) {
          deps.log(`Session re-index failed: ${err}`);
        }
      }
    }),
  );

  // ─── Resume Session ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.resumeSession", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const sm = new SessionManager(folder);
      sm.setSessionDbRef({ get: () => deps.getSessionDb() });
      const session = await sm.loadSession();
      if (!session) {
        vscode.window.showInformationMessage(
          "No saved session found. Use 'Project Brain: Save Session' to create one.",
        );
        return;
      }

      const ageMinutes = sm.getSessionAge();
      const ageText =
        ageMinutes !== null
          ? ageMinutes < 60
            ? `${ageMinutes}m ago`
            : ageMinutes < 1440
              ? `${Math.round(ageMinutes / 60)}h ago`
              : `${Math.round(ageMinutes / 1440)}d ago`
          : "unknown";

      const config = vscode.workspace.getConfiguration("projectBrain");
      const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
      const handoffUri = vscode.Uri.joinPath(
        folder.uri,
        memoryFolder,
        "07_SESSION_HANDOFF.md",
      );
      await vscode.commands.executeCommand("vscode.open", handoffUri);

      const parts: string[] = [];
      if (session.goals.length) parts.push(`${session.goals.length} goals`);
      if (session.completed.length)
        parts.push(`${session.completed.length} completed`);
      if (session.pending.length)
        parts.push(`${session.pending.length} pending`);
      parts.push(`${session.activeFiles.length} files`);

      vscode.window.showInformationMessage(
        `Session resumed (${ageText}): ${parts.join(", ")}`,
      );
      deps.log(`Session resumed (saved ${ageText})`);
    }),
  );
}
