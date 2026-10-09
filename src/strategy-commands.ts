import * as vscode from "vscode";
import type { CronNotificationManager } from "./cron-notifications";
import type { BrainTreeDataProvider } from "./tree-view";

export interface StrategyCommandDeps {
  getCronNotifications: () => CronNotificationManager | null;
  treeDataProvider: BrainTreeDataProvider;
}

export function registerStrategyCommands(
  context: vscode.ExtensionContext,
  deps: StrategyCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.toggleCronNotifications",
      async () => {
        const activeCronNotifications = deps.getCronNotifications();
        if (activeCronNotifications) {
          if (activeCronNotifications.isMuted) {
            await activeCronNotifications.unmute();
            vscode.window.showInformationMessage(
              "🔔 Cron notifications enabled",
            );
          } else {
            await activeCronNotifications.mute();
            vscode.window.showInformationMessage("🔇 Cron notifications muted");
          }
        } else {
          // Fallback: toggle setting directly
          const config = vscode.workspace.getConfiguration("projectBrain");
          const current = config.get<boolean>("cron.notificationsMuted", false);
          await config.update(
            "cron.notificationsMuted",
            !current,
            vscode.ConfigurationTarget.Workspace,
          );
          vscode.window.showInformationMessage(
            !current
              ? "🔇 Cron notifications muted"
              : "🔔 Cron notifications enabled",
          );
        }
        deps.treeDataProvider.refresh();
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.strategy.toggleSatisfactionCheck",
      async () => {
        const config = vscode.workspace.getConfiguration("projectBrain");
        const current = config.get<boolean>("strategy.satisfactionCheck", true);
        await config.update(
          "strategy.satisfactionCheck",
          !current,
          vscode.ConfigurationTarget.Workspace,
        );
        vscode.window.showInformationMessage(
          `Satisfaction Check: ${!current ? "ON" : "OFF"}`,
        );
        deps.treeDataProvider.refresh();
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.strategy.toggleAutoCommit",
      async () => {
        const config = vscode.workspace.getConfiguration("projectBrain");
        const current = config.get<boolean>("strategy.autoCommit", true);
        await config.update(
          "strategy.autoCommit",
          !current,
          vscode.ConfigurationTarget.Workspace,
        );
        vscode.window.showInformationMessage(
          `Auto-Commit: ${!current ? "ON" : "OFF"}`,
        );
        deps.treeDataProvider.refresh();
      },
    ),
  );
}
