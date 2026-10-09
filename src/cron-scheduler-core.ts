/**
 * CronSchedulerCore — Pure scheduler logic (no VS Code dependency).
 *
 * Owns the timer and evaluation mutex.
 * Delegates evaluation and notification via callbacks.
 * Fully unit-testable.
 */

export interface CronSchedulerCoreOptions {
  intervalMs: number;
  evaluate: () => Promise<string>;
  onAlerts: (alerts: string) => void;
  log: (msg: string) => void;
}

export class CronSchedulerCore {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _evaluating = false;
  private _intervalMs: number;
  private _evaluate: () => Promise<string>;
  private _onAlerts: (alerts: string) => void;
  private _log: (msg: string) => void;

  constructor(opts: CronSchedulerCoreOptions) {
    this._intervalMs = opts.intervalMs;
    this._evaluate = opts.evaluate;
    this._onAlerts = opts.onAlerts;
    this._log = opts.log;
  }

  get isRunning(): boolean {
    return this._timer !== null;
  }

  get isEvaluating(): boolean {
    return this._evaluating;
  }

  start(): void {
    if (this._timer) return;
    this._log(`[CronScheduler] started (interval: ${this._intervalMs / 60000} min)`);
    // Immediate first tick — don't wait a full interval before first evaluation
    setTimeout(() => this.tick(), 500);
    this._timer = setInterval(() => this.tick(), this._intervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._log("[CronScheduler] stopped");
    }
  }

  /** Update interval. Resets the timer if running. */
  setInterval(ms: number): void {
    this._intervalMs = ms;
    if (this._timer) {
      this.stop();
      this.start();
    }
  }

  /** Manual trigger — respects mutex. */
  async triggerNow(): Promise<void> {
    await this.tick();
  }

  dispose(): void {
    this.stop();
  }

  private async tick(): Promise<void> {
    if (this._evaluating) {
      this._log("[CronScheduler] skipped tick — already evaluating");
      return;
    }

    this._evaluating = true;
    try {
      const alerts = await this._evaluate();
      if (alerts.trim()) {
        this._onAlerts(alerts);
      }
    } catch (err) {
      this._log(`[CronScheduler] evaluation error: ${err}`);
    } finally {
      this._evaluating = false;
    }
  }
}
