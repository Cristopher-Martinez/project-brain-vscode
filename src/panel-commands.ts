// ─── Panel Commands (extracted from extension.ts) ───────────────────────────
// Responsibility: openAdminPanel, openBrainHQ commands
import * as path from "path";
import * as vscode from "vscode";
import { AdminDB } from "./admin-db";
import { AdminPanel } from "./admin-panel";
import type { AgentRegistry } from "./agent-registry";
import { BrainHQPanel } from "./brain-hq";
import type { FolderState } from "./extension-types";
import type { ModelRouter } from "./model-router";
import type { OpinionBank } from "./opinion-bank";
import type { SaaSClient } from "./saas-client";

import type { OrchestrationManager } from "./orchestration-manager";
import { requireEnabled } from "./project-lifecycle-utils";

export interface PanelCommandsDeps {
  folderStates: Map<string, FolderState>;
  getAdminDb: () => AdminDB | null;
  setAdminDb: (db: AdminDB | null) => void;
  getSaasClient: () => SaaSClient | null;
  getOpinionBank: () => OpinionBank | null;
  getAgentRegistry: () => AgentRegistry | null;
  getModelRouter: () => ModelRouter | null;
  getOrchestrationManager: () => OrchestrationManager | null;
  log: (msg: string) => void;
}

export function registerPanelCommands(
  context: vscode.ExtensionContext,
  deps: PanelCommandsDeps,
): void {
  // ─── Admin Panel (admin-gated, lazy init) ─────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.openAdminPanel", async () => {
      if (!requireEnabled()) return;
      if (!deps.getAdminDb() && deps.getSaasClient()) {
        const saasClient = deps.getSaasClient()!;
        try {
          if (await saasClient.isAuthenticated()) {
            await saasClient.requireAuthenticatedLicense();
            deps.log(
              `[Admin] License refreshed for admin check — isAdmin=${saasClient.isAdmin}`,
            );
          } else {
            deps.log("[Admin] Not authenticated — cannot check admin role");
          }
        } catch (e) {
          deps.log(`[Admin] License refresh failed: ${e}`);
        }

        if (saasClient.isAdmin) {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) {
            deps.log("[Admin] No workspace folder available");
            return;
          }
          const adminMemPath = path.join(
            folder.uri.fsPath,
            vscode.workspace
              .getConfiguration("projectBrain")
              .get<string>("memoryFolder", ".project-brain/memory"),
          );
          const adminDb = new AdminDB(adminMemPath, deps.log);
          deps.setAdminDb(adminDb);
          deps.log("[Admin] AdminDB lazily initialized");
        }
      }

      if (!deps.getAdminDb()) {
        vscode.window.showWarningMessage(
          "🔒 Admin panel requires admin role. Log in with an admin account.",
        );
        return;
      }
      AdminPanel.createOrShow(
        context.extensionUri,
        deps.getAdminDb()!,
        deps.log,
        (() => {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) return "";
          return path.join(
            folder.uri.fsPath,
            vscode.workspace
              .getConfiguration("projectBrain")
              .get<string>("memoryFolder", ".project-brain/memory"),
          );
        })(),
      );
    }),
  );

  // ─── Brain HQ (Command Center) ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.openBrainHQ",
      async (initialTab?: string) => {
        if (!requireEnabled()) return;
        // Auth gate: require authentication if SaaS is configured
        const saasClient = deps.getSaasClient();
        if (saasClient) {
          const isAuth = await saasClient.isAuthenticated();
          if (!isAuth) {
            const action = await vscode.window.showWarningMessage(
              "🔒 Brain HQ requires authentication. Please log in first.",
              "Log In",
            );
            if (action === "Log In") {
              vscode.commands.executeCommand("projectBrain.saas.login");
            }
            return;
          }
        }

        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          vscode.window.showWarningMessage("No workspace folder open.");
          return;
        }
        const memFolder = vscode.workspace
          .getConfiguration("projectBrain")
          .get<string>("memoryFolder", ".project-brain/memory");
        const memPath = path.join(folder.uri.fsPath, memFolder);
        const state = deps.folderStates.get(folder.uri.toString());
        BrainHQPanel.createOrShow(
          {
            extensionUri: context.extensionUri,
            workspaceFolder: folder,
            memoryPath: memPath,
            identityManager: state?.identityManager,
            opinionBank: deps.getOpinionBank() ?? undefined,
            agentRegistry: deps.getAgentRegistry() ?? undefined,
            modelRouter: deps.getModelRouter() ?? undefined,
            orchestrationManager: deps.getOrchestrationManager() ?? undefined,
            getSaasClient: () => deps.getSaasClient(),
            log: deps.log,
          },
          typeof initialTab === "string" ? initialTab : undefined,
        );
      },
    ),
  );
}
