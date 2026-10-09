/**
 * Cron Scheduler — VS Code wrapper for CronSchedulerCore.
 *
 * Reads settings, manages lifecycle, fires alert callbacks.
 * Pure logic lives in cron-scheduler-core.ts (testable without VS Code).
 */

import * as vscode from "vscode";
import { evaluateCronJobs, type CronActionHandler } from "./cron-engine";
import { CronSchedulerCore } from "./cron-scheduler-core";

export type CronAlertCallback = (alerts: string) => void;

/**
 * VS Code-aware cron scheduler.
 * Reads settings, manages lifecycle, fires alert callbacks.
 * Accepts action handlers for auto-healing jobs.
 */
export class CronScheduler implements vscode.Disposable {
  private core: CronSchedulerCore;
  private _alertCallbacks: CronAlertCallback[] = [];
  private _configListener: vscode.Disposable | null = null;
  private _actionHandlers: Map<string, CronActionHandler> = new Map();

  constructor(
    private memoryPath: string,
    private workspacePath: string,
    private log: (msg: string) => void,
  ) {
    const intervalMs = this.getIntervalMs();

    this.core = new CronSchedulerCore({
      intervalMs,
      evaluate: () => evaluateCronJobs(
        this.memoryPath, this.workspacePath, this.log, this._actionHandlers,
      ),
      onAlerts: (alerts) => {
        for (const cb of this._alertCallbacks) {
          try {
            cb(alerts);
          } catch (err) {
            this.log(`[CronScheduler] alert callback error: ${err}`);
          }
        }
      },
      log: this.log,
    });

    // Watch for settings changes
    this._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("projectBrain.cron.intervalMinutes")) {
        this.core.setInterval(this.getIntervalMs());
        this.log(`[CronScheduler] interval updated to ${this.getIntervalMs() / 60000} min`);
      }
      if (e.affectsConfiguration("projectBrain.cron.debugIntervalSeconds")) {
        this.core.setInterval(this.getIntervalMs());
        this.log(
          `[CronScheduler] debug interval updated to ${this.getIntervalMs() / 1000} sec (effective)`,
        );
      }
      if (e.affectsConfiguration("projectBrain.cron.enabled")) {
        const enabled = vscode.workspace
          .getConfiguration("projectBrain")
          .get<boolean>("cron.enabled", true);
        if (enabled && !this.core.isRunning) {
          this.core.start();
        } else if (!enabled && this.core.isRunning) {
          this.core.stop();
        }
      }
    });
  }

  /** Register a callback for when cron alerts are triggered. */
  onAlerts(callback: CronAlertCallback): void {
    this._alertCallbacks.push(callback);
  }

  /** Start the scheduler if cron is enabled. */
  start(): void {
    const enabled = vscode.workspace
      .getConfiguration("projectBrain")
      .get<boolean>("cron.enabled", true);
    if (!enabled) {
      this.log("[CronScheduler] cron.enabled is false — not starting");
      return;
    }
    this.core.start();
  }

  stop(): void {
    this.core.stop();
  }

  get isRunning(): boolean {
    return this.core.isRunning;
  }

  get isEvaluating(): boolean {
    return this.core.isEvaluating;
  }

  async triggerNow(): Promise<void> {
    await this.core.triggerNow();
  }

  /**
   * Register a cron action handler for auto-healing.
   * Handlers execute when a cron job with a matching action.type fires.
   */
  registerAction(type: string, handler: CronActionHandler): void {
    this._actionHandlers.set(type, handler);
    this.log(`[CronScheduler] Registered action handler: ${type}`);
  }

  dispose(): void {
    this._configListener?.dispose();
    this.core.dispose();
    this._alertCallbacks = [];
  }

  private getIntervalMs(): number {
    const debugSeconds = vscode.workspace
      .getConfiguration("projectBrain")
      .get<number>("cron.debugIntervalSeconds", 0);

    // Debug override: allows fast ticks for validating automation (e.g., 30s)
    if (debugSeconds && debugSeconds > 0) {
      const clampedSeconds = Math.max(5, Math.min(300, debugSeconds));
      return clampedSeconds * 1000;
    }

    const minutes = vscode.workspace
      .getConfiguration("projectBrain")
      .get<number>("cron.intervalMinutes", 15);
    return Math.max(5, Math.min(60, minutes)) * 60 * 1000;
  }
}
