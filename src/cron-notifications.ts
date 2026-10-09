/**
 * Cron Notification Manager — Aggregated toast + TreeView badge.
 *
 * Expert panel mandated: "single aggregated notification per evaluation cycle".
 * This module provides:
 * - `notify(alerts)` — Shows ONE toast with summary of all fired alerts
 * - `setBadge(count)` — Updates TreeView badge with active alert count
 * - `clearBadge()` — Clears the badge
 *
 * Designed to plug into CronScheduler.onAlerts() callback.
 */

import * as vscode from "vscode";

export class CronNotificationManager {
  private _treeView: vscode.TreeView<unknown> | null = null;
  private _lastAlertCount = 0;
  private _memoryPath: string | null = null;

  constructor(private log: (msg: string) => void) {}

  /** Whether notifications are muted (reads from workspace setting). */
  get isMuted(): boolean {
    return vscode.workspace
      .getConfiguration("projectBrain")
      .get<boolean>("cron.notificationsMuted", false);
  }

  /** Mute cron toast notifications. */
  async mute(): Promise<void> {
    await vscode.workspace
      .getConfiguration("projectBrain")
      .update(
        "cron.notificationsMuted",
        true,
        vscode.ConfigurationTarget.Workspace,
      );
    this.log("[CronNotify] Notifications muted");
  }

  /** Unmute cron toast notifications. */
  async unmute(): Promise<void> {
    await vscode.workspace
      .getConfiguration("projectBrain")
      .update(
        "cron.notificationsMuted",
        false,
        vscode.ConfigurationTarget.Workspace,
      );
    this.log("[CronNotify] Notifications unmuted");
  }

  /** Link to the TreeView for badge updates. */
  setTreeView(treeView: vscode.TreeView<unknown>): void {
    this._treeView = treeView;
  }

  /** Set memory path to open cron.json directly. */
  setMemoryPath(memoryPath: string): void {
    this._memoryPath = memoryPath;
  }

  /**
   * Process alerts from a cron evaluation cycle.
   * Shows one aggregated toast and updates the badge.
   */
  notify(alerts: string): void {
    if (!alerts.trim()) {
      // No alerts this cycle — clear badge
      this.clearBadge();
      return;
    }

    // Count individual alerts (each starts with emoji prefix on a new line)
    const lines = alerts.split("\n").filter((l) => l.trim().length > 0);
    const alertCount = lines.length;

    this._lastAlertCount = alertCount;

    // Skip toast if muted — still update badge so tree-view shows count
    if (this.isMuted) {
      this.log(`[CronNotify] ${alertCount} alert(s) suppressed (muted)`);
      this.setBadge(alertCount);
      return;
    }

    // Aggregated toast — never >1 per cycle
    const summary =
      alertCount === 1
        ? lines[0].substring(0, 100)
        : `${alertCount} reminders triggered`;

    void vscode.window
      .showInformationMessage(
        `🔔 ${summary}`,
        "View Details",
        "Don't show again",
      )
      .then(async (choice) => {
        if (choice === "View Details") {
          const header = `# 🔔 Cron Alerts — ${new Date().toLocaleString()}\n\n`;
          const body = lines.map((l) => `- ${l}`).join("\n");
          const doc = await vscode.workspace.openTextDocument({
            language: "markdown",
            content: header + body + "\n",
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        } else if (choice === "Don't show again") {
          await this.mute();
          vscode.window.showInformationMessage(
            "🔇 Cron notifications muted. Re-enable from the Reminders section in the tree view.",
          );
        }
      });

    this.log(`[CronNotify] ${alertCount} alert(s) shown`);

    // Update badge
    this.setBadge(alertCount);
  }

  /** Set the TreeView badge count. */
  setBadge(count: number): void {
    if (!this._treeView) return;

    if (count > 0) {
      this._treeView.badge = {
        value: count,
        tooltip: `${count} cron reminder${count > 1 ? "s" : ""} triggered`,
      };
    } else {
      this._treeView.badge = undefined;
    }
  }

  /** Clear the badge. */
  clearBadge(): void {
    this.setBadge(0);
    this._lastAlertCount = 0;
  }

  get lastAlertCount(): number {
    return this._lastAlertCount;
  }
}
