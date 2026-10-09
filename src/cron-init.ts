// ─── Cron Scheduler Initialization (extracted from extension.ts) ────────────
// Responsibility: CronScheduler, CronNotificationManager, auto-healing actions
import * as vscode from "vscode";
import { CronNotificationManager } from "./cron-notifications";
import { CronScheduler } from "./cron-scheduler";
import type { BrainTreeDataProvider } from "./tree-view";
import type { OpinionBank } from "./opinion-bank";
import type { SaaSClient } from "./saas-client";

export interface CronInitOpts {
  memoryPath: string;
  workspacePath: string;
  context: vscode.ExtensionContext;
  opinionBank: OpinionBank;
  treeDataProvider: BrainTreeDataProvider;
  treeView: vscode.TreeView<unknown>;
  getSaasClient: () => SaaSClient | null;
  log: (msg: string) => void;
}

export interface CronInitResult {
  cronScheduler: CronScheduler;
  cronNotifications: CronNotificationManager;
}

export function initializeCronLayer(opts: CronInitOpts): CronInitResult | null {
  const {
    memoryPath,
    workspacePath,
    context,
    opinionBank,
    treeDataProvider,
    treeView,
    log,
  } = opts;

  try {
    const cronNotifications = new CronNotificationManager(log);
    cronNotifications.setTreeView(treeView);
    cronNotifications.setMemoryPath(memoryPath);

    const cronScheduler = new CronScheduler(memoryPath, workspacePath, log);

    // Auto-healing action handlers
    cronScheduler.registerAction(
      "opinion-health-check",
      async (_job, actionLog) => {
        const health = opinionBank.healthCheck();
        const status = health.healthy ? "✅ healthy" : "⚠️ needs attention";
        actionLog(
          `[AutoHealing] OpinionBank health: ${status} ` +
            `(${health.total} opinions, avg c=${health.avgConfidence}, ` +
            `${health.duplicatePairs} dupes, ${health.staleCount} stale, ` +
            `${health.testArtifactCount} test artifacts)`,
        );
        if (!health.healthy) {
          return `OpinionBank ${status}: ${health.total} opinions, ${health.duplicatePairs} duplicates, ${health.staleCount} stale, ${health.testArtifactCount} test artifacts`;
        }
        return `OpinionBank ${status} (${health.total} opinions, avg c=${health.avgConfidence})`;
      },
    );

    cronScheduler.registerAction("opinion-reflect", async (job, actionLog) => {
      const dryRun = (job.action as { dryRun?: boolean })?.dryRun ?? false;
      const report = opinionBank.reflect(dryRun);
      const mode = dryRun ? "[DRY RUN] " : "";
      const parts: string[] = [];
      if (report.pruned.length > 0)
        parts.push(`${report.pruned.length} pruned`);
      if (report.merged.length > 0)
        parts.push(`${report.merged.length} merged`);
      if (report.testArtifacts.length > 0)
        parts.push(`${report.testArtifacts.length} test artifacts removed`);
      if (report.contradictions.length > 0)
        parts.push(`${report.contradictions.length} contradictions`);
      if (report.stale.length > 0) parts.push(`${report.stale.length} stale`);

      const summary = parts.length > 0 ? parts.join(", ") : "all clean";
      actionLog(
        `[AutoHealing] ${mode}Reflect: ${summary}. ${report.total} opinions remaining.`,
      );
      return `${mode}Reflect: ${summary} (${report.total} remaining)`;
    });

    log(
      "[AutoHealing] Opinion maintenance handlers registered on CronScheduler",
    );

    // Connect alerts → notifications + TreeView refresh
    cronScheduler.onAlerts((alerts) => {
      cronNotifications.notify(alerts);
      treeDataProvider.refresh();
    });

    // Plan-gated start (deferred 2s for SaaS init)
    setTimeout(() => void startCronIfAllowed(cronScheduler, opts), 2000);

    context.subscriptions.push(cronScheduler);
    log("[Cron] Notification manager + scheduler wired");

    return { cronScheduler, cronNotifications };
  } catch (err) {
    log(`[Cron] Init error (non-fatal): ${err}`);
    return null;
  }
}

async function startCronIfAllowed(
  scheduler: CronScheduler,
  opts: Pick<CronInitOpts, "getSaasClient" | "log">,
): Promise<void> {
  try {
    const debugSeconds = vscode.workspace
      .getConfiguration("projectBrain")
      .get<number>("cron.debugIntervalSeconds", 0);
    if (debugSeconds && debugSeconds > 0) {
      scheduler.start();
      opts.log(
        `[Cron] Scheduler FORCE-started (debugIntervalSeconds=${debugSeconds}s — SaaS gate bypassed)`,
      );
      return;
    }
    const saasClient = opts.getSaasClient();
    if (saasClient) {
      const hasAccess = await saasClient.checkAccess("cron_reminders");
      if (hasAccess) {
        scheduler.start();
        opts.log("[Cron] Scheduler started (plan allows cron_reminders)");
      } else {
        opts.log("[Cron] Scheduler not started — cron_reminders requires Pro+");
      }
    } else {
      scheduler.start();
      opts.log("[Cron] Scheduler started (no SaaS client — offline mode)");
    }
  } catch (err) {
    opts.log(`[Cron] Scheduler start error: ${err}`);
  }
}
