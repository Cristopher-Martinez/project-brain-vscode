import * as vscode from "vscode";
import { log } from "./logger";

export interface SaaSCommandDeps {
  getSaasClient: () => any | null;
  getOfflineManager: () => any | null;
  getDualOpinionBank: () => any | null;
  getLoginWebview: () => any | null;
  getUpgradePrompts: () => any | null;
  folderStates: Map<string, any>;
}

export function registerSaaSCommands(
  context: vscode.ExtensionContext,
  deps: SaaSCommandDeps,
): void {
  // ─── SaaS Commands ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.saas.login", async () => {
      const activeSaasClient = deps.getSaasClient();
      if (!activeSaasClient) {
        vscode.window.showInformationMessage(
          "Project Brain: Enable SaaS features first (projectBrain.saas.enabled = true) and reload.",
        );
        return;
      }
      const activeLoginWebview = deps.getLoginWebview();
      if (activeLoginWebview) {
        await activeLoginWebview.show();
      } else {
        vscode.window.showErrorMessage(
          "Project Brain: Login UI unavailable. Check Output panel for errors.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.saas.logout", async () => {
      const activeSaasClient = deps.getSaasClient();
      if (!activeSaasClient) {
        vscode.window.showInformationMessage(
          "Project Brain: SaaS features are not enabled.",
        );
        return;
      }
      await activeSaasClient.logout();
      log("[SaaS] User logged out");
      vscode.window.showInformationMessage(
        "Project Brain: Logged out successfully.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.saas.status", async () => {
      const activeSaasClient = deps.getSaasClient();
      const activeOfflineManager = deps.getOfflineManager();
      if (!activeSaasClient) {
        vscode.window.showInformationMessage(
          "Project Brain: SaaS features are not enabled.",
        );
        return;
      }
      const isAuth = await activeSaasClient.isAuthenticated();
      const plan = activeSaasClient.currentPlan;
      const online = await activeSaasClient.ping();
      const pendingOps = activeOfflineManager?.pendingCount ?? 0;

      const parts = [
        `Plan: ${plan}`,
        `Authenticated: ${isAuth}`,
        `Online: ${online}`,
      ];
      if (pendingOps > 0) parts.push(`Pending sync: ${pendingOps}`);

      vscode.window.showInformationMessage(
        `Project Brain SaaS — ${parts.join(" | ")}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.saas.syncOpinions",
      async () => {
        const activeSaasClient = deps.getSaasClient();
        if (!activeSaasClient) {
          vscode.window.showInformationMessage(
            "Project Brain: SaaS features are not enabled.",
          );
          return;
        }
        const isAuth = await activeSaasClient.isAuthenticated();
        if (!isAuth) {
          vscode.window.showWarningMessage(
            "Project Brain: Log in first to sync opinions.",
          );
          return;
        }
        const activeDualOpinionBank = deps.getDualOpinionBank();
        if (!activeDualOpinionBank) {
          vscode.window.showErrorMessage(
            "Project Brain: DualOpinionBank unavailable.",
          );
          return;
        }

        try {
          await activeDualOpinionBank.sync();
          log("[SaaS] Opinions synced successfully");
          vscode.window.showInformationMessage(
            "Project Brain: Opinions synced with cloud.",
          );
        } catch (e) {
          log(`[SaaS] Opinion sync failed: ${e}`);
          vscode.window.showErrorMessage(`Project Brain: Sync failed — ${e}`);
        }
      },
    ),
  );

  // ─── Restore Memory from Cloud ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.restoreMemory", async () => {
      const activeSaasClient = deps.getSaasClient();
      if (!activeSaasClient) {
        vscode.window.showWarningMessage("Project Brain: SaaS not available.");
        return;
      }
      const isAuth = await activeSaasClient.isAuthenticated();
      if (!isAuth) {
        vscode.window.showWarningMessage(
          "Project Brain: Log in first to restore memory.",
        );
        return;
      }
      const currentPlan = activeSaasClient.currentPlan;
      const activeUpgradePrompts = deps.getUpgradePrompts();
      if (currentPlan === "free") {
        if (activeUpgradePrompts) {
          await activeUpgradePrompts.promptForFeature(
            "global_memory",
            currentPlan,
          );
        }
        return;
      }
      const activeDualOpinionBank = deps.getDualOpinionBank();
      if (!activeDualOpinionBank) {
        vscode.window.showErrorMessage(
          "Project Brain: DualOpinionBank unavailable.",
        );
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        "This will pull all opinions from the cloud and merge them with your local memory. Continue?",
        { modal: true },
        "Restore",
      );
      if (confirm !== "Restore") return;

      try {
        const summary = await activeDualOpinionBank.sync();
        // Also refresh plan cache
        const folderPaths = [...deps.folderStates.keys()].map(
          (uri) => vscode.Uri.parse(uri).fsPath,
        );
        activeSaasClient.writePlanCache(folderPaths);
        log(
          `[SaaS] Memory restored: pushed=${summary.pushed}, pulled=${summary.pulled}`,
        );
        vscode.window.showInformationMessage(
          `Project Brain: Memory restored — ${summary.pulled} opinions pulled from cloud, ${summary.pushed} pushed.`,
        );
      } catch (e) {
        log(`[SaaS] Memory restore failed: ${e}`);
        vscode.window.showErrorMessage(`Project Brain: Restore failed — ${e}`);
      }
    }),
  );
}
