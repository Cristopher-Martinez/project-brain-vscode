import * as vscode from "vscode";
import { log } from "./logger";
import { composeCronJob } from "./cron-composer";
import {
  completeCronJob,
  removeCronJob,
  snoozeCronJob,
  toggleMuteCronJob,
} from "./cron-engine";

export interface CronCommandDeps {
  getSaasClient: () => any | null;
  getUpgradePrompts: () => any | null;
  getCronScheduler: () => any | null;
  getMemoryPath: () => string;
  treeDataProvider: any;
}

export function registerCronCommands(
  context: vscode.ExtensionContext,
  deps: CronCommandDeps,
): void {
  // ─── Cron Commands ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.createReminder", async () => {
      const memoryPath = deps.getMemoryPath();
      // Plan gate
      const activeSaasClient = deps.getSaasClient();
      const currentPlan = activeSaasClient?.currentPlan ?? "free";
      if (currentPlan === "free") {
        const activeUpgradePrompts = deps.getUpgradePrompts();
        if (activeUpgradePrompts) {
          await activeUpgradePrompts.promptForFeature(
            "cron_reminders" as any,
            currentPlan,
          );
        } else {
          vscode.window.showWarningMessage(
            "⛔ Reminders require a Pro plan. Upgrade at https://projectbrain.dev/pricing",
          );
        }
        return;
      }
      await composeCronJob(memoryPath, log);
      deps.treeDataProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.snoozeReminder",
      async (item?: { cronJobId?: string }) => {
        const memoryPath = deps.getMemoryPath();
        const jobId = item?.cronJobId;
        if (!jobId) return;

        const days = await vscode.window.showInputBox({
          prompt: "Snooze for how many days?",
          value: "1",
          validateInput: (v) => {
            const n = Number(v);
            if (isNaN(n) || n < 1 || n > 365) return "Enter 1-365";
            return null;
          },
        });
        if (!days) return;

        const ok = await snoozeCronJob(memoryPath, jobId, Number(days), log);
        if (ok) {
          vscode.window.showInformationMessage(
            `Reminder snoozed for ${days} day(s)`,
          );
          deps.treeDataProvider.refresh();
        } else {
          vscode.window.showWarningMessage("Reminder not found");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.completeReminder",
      async (item?: { cronJobId?: string }) => {
        const memoryPath = deps.getMemoryPath();
        const jobId = item?.cronJobId;
        if (!jobId) return;

        const ok = await completeCronJob(memoryPath, jobId, log);
        if (ok) {
          vscode.window.showInformationMessage("Reminder marked as done");
          deps.treeDataProvider.refresh();
        } else {
          vscode.window.showWarningMessage("Reminder not found");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.deleteReminder",
      async (item?: { cronJobId?: string; label?: string }) => {
        const memoryPath = deps.getMemoryPath();
        const jobId = item?.cronJobId;
        if (!jobId) return;

        const displayName = item?.label || jobId;
        const confirm = await vscode.window.showWarningMessage(
          `Delete reminder "${displayName}"?`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") return;

        const ok = await removeCronJob(memoryPath, jobId, log);
        if (ok) {
          vscode.window.showInformationMessage("Reminder deleted");
          deps.treeDataProvider.refresh();
        } else {
          vscode.window.showWarningMessage("Reminder not found");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.muteReminder",
      async (item?: { cronJobId?: string }) => {
        const memoryPath = deps.getMemoryPath();
        const jobId = item?.cronJobId;
        if (!jobId) return;

        const result = await toggleMuteCronJob(memoryPath, jobId, log);
        if (result !== null) {
          vscode.window.showInformationMessage(
            result ? "Reminder muted 🔇" : "Reminder unmuted 🔔",
          );
          deps.treeDataProvider.refresh();
        } else {
          vscode.window.showWarningMessage("Reminder not found");
        }
      },
    ),
  );
}
