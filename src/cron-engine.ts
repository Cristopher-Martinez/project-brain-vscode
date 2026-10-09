/**
 * Cron Engine — Session-based reminder system.
 *
 * Evaluates scheduled jobs on each awaken call and background timer.
 * Jobs are stored in .project-brain/memory/cron.json.
 * Trigger types: file-lines, days-since, git-uncommitted, date-after, always,
 *                content-match (v2), interval (v2).
 *
 * Design principles:
 * - Per-trigger try/catch (one broken trigger doesn't kill the rest)
 * - Atomic write for all mutations (temp + rename)
 * - Async I/O throughout (fs.promises + execFile)
 * - Max 5 alerts per evaluation to avoid output contamination
 * - Graceful degradation: missing/malformed cron.json → silent no-op
 * - Serialized writes via async queue (prevents race conditions)
 * - content-match capped at 1MB (prevents DoS on large files)
 * - Auto-reactivation of expired snoozes
 */

import * as fsp from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ─── Types (exported for tests + consumers) ────────────────────────────

export interface TriggerFileLines {
  type: "file-lines";
  /** Path relative to workspace root. */
  path: string;
  threshold: number;
}

export interface TriggerDaysSince {
  type: "days-since";
  /** Path relative to workspace root. */
  referenceFile: string;
  days: number;
}

export interface TriggerGitUncommitted {
  type: "git-uncommitted";
  threshold: number;
}

export interface TriggerDateAfter {
  type: "date-after";
  date: string; // ISO date string
}

export interface TriggerAlways {
  type: "always";
}

export interface TriggerContentMatch {
  type: "content-match";
  /** Path relative to workspace root. */
  path: string;
  /** Plain text substring to search for (case-sensitive). */
  substring: string;
}

export interface TriggerInterval {
  type: "interval";
  /** Interval in hours. Fires when elapsed since lastTriggered (or createdAt). */
  hours: number;
}

export type CronTrigger =
  | TriggerFileLines
  | TriggerDaysSince
  | TriggerGitUncommitted
  | TriggerDateAfter
  | TriggerAlways
  | TriggerContentMatch
  | TriggerInterval;

export interface CronJob {
  id: string;
  description: string;
  trigger: CronTrigger;
  message: string;
  priority?: "info" | "warning" | "critical";
  status: "active" | "snoozed" | "done";
  createdAt: string;
  lastTriggered: string | null;
  cooldownDays: number;
  /** Optional: cooldown in minutes (takes precedence over cooldownDays). */
  cooldownMinutes?: number;
  /** ISO date — when snooze expires and job reactivates. */
  snoozeUntil: string | null;
  /** Optional action to execute when triggered (auto-healing). */
  action?: CronAction;

  // ─── Execution history (#4) ─────────────────────────────
  /** Result of the last executed action (persisted for visibility). */
  lastActionResult?: string | null;

  // ─── Per-job mute (#5) ────────────────────────────────
  /** If true, actions still execute but toast notifications are suppressed for this job. */
  muted?: boolean;

  // ─── Auto-expiration (#7) ──────────────────────────────
  /** ISO date — auto-mark as done after this date. */
  expiresAt?: string | null;
  /** Max number of times this job can fire. Auto-done after reaching this count. */
  maxRuns?: number;
  /** How many times this job has successfully triggered. */
  runCount?: number;
  /** If true, this job should never be permanently completed — completeCronJob reactivates it instead. */
  recurring?: boolean;

  // ─── Retry policy (#8) ───────────────────────────────
  /** Max retries on action failure. 0 = no retry (default behavior). */
  maxRetries?: number;
  /** Current consecutive failure count. Resets to 0 on success. */
  retryCount?: number;
  /** Last error message from a failed action. */
  lastError?: string | null;
}

/**
 * Actions that a cron job can execute automatically.
 * Each action maps to a handler registered by the extension.
 */
export type CronAction =
  | { type: "opinion-reflect"; dryRun?: boolean }
  | { type: "opinion-health-check" }
  | { type: "custom"; handler: string };

/**
 * Action handler function — receives the job + action, returns a result string.
 * Must be self-contained and handle its own errors.
 */
export type CronActionHandler = (
  job: CronJob,
  log: (msg: string) => void,
) => Promise<string>;

export interface CronFile {
  jobs: CronJob[];
}

/** Max alerts to include per evaluation. */
const MAX_ALERTS = 5;

/** Max file size for content-match trigger (1MB). */
const MAX_CONTENT_MATCH_BYTES = 1024 * 1024;

/** Priority sort order (critical first). */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function getCooldownMs(job: Pick<CronJob, "cooldownMinutes" | "cooldownDays">): number {
  if (typeof job.cooldownMinutes === "number" && job.cooldownMinutes > 0) {
    return job.cooldownMinutes * 60 * 1000;
  }
  if (typeof job.cooldownDays === "number" && job.cooldownDays > 0) {
    return job.cooldownDays * 24 * 60 * 60 * 1000;
  }
  return 0;
}

// ─── Write queue (serializes all cron.json mutations) ──────────────────

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(cronPath: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(cronPath) ?? Promise.resolve();
  const next = prev.then(fn, fn); // Run fn even if previous failed
  writeQueues.set(cronPath, next);
  return next;
}

// ─── Main entry ─────────────────────────────────────────────────────────

/**
 * Evaluate all cron jobs and return triggered alerts.
 * Called from AwakenTool.invoke() and CronScheduler.
 *
 * @param memoryPath - Absolute path to .project-brain/memory/
 * @param workspacePath - Absolute path to workspace root
 * @param log - Logger function
 * @param actionHandlers - Optional map of action type → handler function (auto-healing)
 * @returns Formatted alert string (empty if no alerts)
 */
export async function evaluateCronJobs(
  memoryPath: string,
  workspacePath: string,
  log: (msg: string) => void,
  actionHandlers?: Map<string, CronActionHandler>,
): Promise<string> {
  const cronPath = path.join(memoryPath, "cron.json");

  // Graceful: no cron.json → no-op
  try { await fsp.access(cronPath); } catch { return ""; }

  let cronFile: CronFile;
  try {
    const raw = await fsp.readFile(cronPath, "utf-8");
    cronFile = JSON.parse(raw);
  } catch (err) {
    log(`[Cron] cron.json malformed or unreadable: ${err}`);
    return "";
  }

  if (!Array.isArray(cronFile?.jobs)) {
    log("[Cron] cron.json missing 'jobs' array, skipping");
    return "";
  }

  const now = new Date();
  const triggered: { job: CronJob; priority: number; actionResult?: string }[] = [];
  let dirty = false;

  // Auto-reactivate expired snoozes
  for (const job of cronFile.jobs) {
    if (
      job.status === "snoozed" &&
      job.snoozeUntil &&
      now > new Date(job.snoozeUntil)
    ) {
      job.status = "active";
      job.snoozeUntil = null;
      dirty = true;
    }
  }

  for (const job of cronFile.jobs) {
    // Skip invalid, inactive, or done jobs
    if (!job?.id || !job?.trigger || !job?.message) continue;
    if (job.status !== "active") continue;

    // Auto-expiration: check expiresAt date
    if (job.expiresAt && now > new Date(job.expiresAt)) {
      job.status = "done";
      dirty = true;
      log(`[Cron] Job ${job.id} auto-expired (expiresAt: ${job.expiresAt})`);
      continue;
    }

    // Auto-expiration: check maxRuns
    if (job.maxRuns && (job.runCount ?? 0) >= job.maxRuns) {
      job.status = "done";
      dirty = true;
      log(`[Cron] Job ${job.id} auto-completed (maxRuns: ${job.maxRuns}, ran: ${job.runCount})`);
      continue;
    }

    // Cooldown check
    if (job.lastTriggered) {
      const cooldownMs = getCooldownMs(job);
      if (cooldownMs > 0) {
        const last = new Date(job.lastTriggered);
        const elapsedMs = now.getTime() - last.getTime();
        if (elapsedMs < cooldownMs) continue;
      }
    }

    // Retry backoff: if retryCount > 0, apply exponential backoff (2^n minutes)
    if ((job.retryCount ?? 0) > 0 && job.lastTriggered) {
      const backoffMinutes = Math.pow(2, job.retryCount ?? 0);
      const backoffMs = backoffMinutes * 60 * 1000;
      const timeSinceLast = now.getTime() - new Date(job.lastTriggered).getTime();
      if (timeSinceLast < backoffMs) continue;
    }

    // Evaluate trigger (per-trigger try/catch)
    try {
      const fired = await checkTrigger(job, workspacePath, log);
      if (fired) {
        // Execute action if present and handler is registered
        let actionResult = "";
        let actionFailed = false;
        if (job.action && actionHandlers) {
          const handler = actionHandlers.get(job.action.type);
          if (handler) {
            try {
              actionResult = await handler(job, log);
              log(`[Cron] Action ${job.action.type} executed for ${job.id}: ${actionResult.substring(0, 100)}`);
              // Success: reset retry counter
              job.retryCount = 0;
              job.lastError = null;
            } catch (actionErr) {
              actionFailed = true;
              const errMsg = String(actionErr);
              actionResult = `[action error: ${errMsg}]`;
              log(`[Cron] Action ${job.action.type} failed for ${job.id}: ${errMsg}`);
              // Retry tracking
              job.retryCount = (job.retryCount ?? 0) + 1;
              job.lastError = errMsg.substring(0, 200);
              const maxRetries = job.maxRetries ?? 0;
              if (maxRetries > 0 && job.retryCount > maxRetries) {
                log(`[Cron] Job ${job.id} exceeded maxRetries (${maxRetries}), marking done`);
                job.status = "done";
              }
            }
          } else {
            log(`[Cron] No handler registered for action type: ${job.action.type}`);
          }
        }

        // Persist action result for history visibility
        job.lastActionResult = actionResult || null;

        // Only update lastTriggered + runCount on SUCCESS (#6)
        if (!actionFailed) {
          job.lastTriggered = now.toISOString();
          job.runCount = (job.runCount ?? 0) + 1;
        }
        dirty = true;

        // Only include in alerts if NOT muted (#5)
        if (!job.muted) {
          triggered.push({
            job,
            priority: PRIORITY_ORDER[job.priority ?? "info"] ?? 2,
            actionResult,
          });
        } else {
          log(`[Cron] Job ${job.id} triggered but muted — suppressing notification`);
        }
      }
    } catch (err) {
      log(`[Cron] trigger ${job.id} failed: ${err}`);
      // Don't block other jobs
    }
  }

  // Persist mutations atomically via write queue
  if (dirty) {
    await enqueueWrite(cronPath, () => atomicWriteJson(cronPath, cronFile, log));
  }

  if (triggered.length === 0) return "";

  // Sort by priority (critical first), cap at MAX_ALERTS
  triggered.sort((a, b) => a.priority - b.priority);
  const shown = triggered.slice(0, MAX_ALERTS);
  const overflow = triggered.length - MAX_ALERTS;

  const lines = shown.map((t) => {
    const icon =
      t.job.priority === "critical"
        ? "🚨"
        : t.job.priority === "warning"
          ? "⚠️"
          : "📌";
    const actionSuffix = t.actionResult ? ` | ${t.actionResult}` : "";
    return `${icon} ${t.job.message}${actionSuffix}`;
  });

  let output = `\n🔔 Reminders:\n${lines.join("\n")}`;
  if (overflow > 0) {
    output += `\n... y ${overflow} más (ver cron.json)`;
  }

  log(`[Cron] ${triggered.length} job(s) triggered`);
  return output;
}

// ─── Trigger evaluators ────────────────────────────────────────────────

async function checkTrigger(
  job: CronJob,
  workspacePath: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const trigger = job.trigger;

  switch (trigger.type) {
    case "file-lines":
      return checkFileLines(trigger, workspacePath);

    case "days-since":
      return checkDaysSince(trigger, workspacePath);

    case "git-uncommitted":
      return checkGitUncommitted(trigger, workspacePath, log);

    case "date-after":
      return new Date() > new Date(trigger.date);

    case "always":
      return true;

    case "content-match":
      return checkContentMatch(trigger, workspacePath, log);

    case "interval":
      return checkInterval(trigger, job);

    default:
      log(`[Cron] unknown trigger type: ${JSON.stringify(trigger)}`);
      return false;
  }
}

/** Count newlines in a file via Buffer (avoids UTF-16 string conversion). */
async function checkFileLines(
  trigger: TriggerFileLines,
  workspacePath: string,
): Promise<boolean> {
  const filePath = path.resolve(workspacePath, trigger.path);
  try {
    const buf = await fsp.readFile(filePath);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++; // \n
    }
    return count >= trigger.threshold;
  } catch {
    return false; // File doesn't exist or unreadable
  }
}

async function checkDaysSince(
  trigger: TriggerDaysSince,
  workspacePath: string,
): Promise<boolean> {
  const filePath = path.resolve(workspacePath, trigger.referenceFile);
  try {
    const stat = await fsp.stat(filePath);
    const daysSince =
      (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    return daysSince >= trigger.days;
  } catch {
    return false; // File doesn't exist
  }
}

async function checkGitUncommitted(
  trigger: TriggerGitUncommitted,
  workspacePath: string,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspacePath,
      timeout: 5000,
    });
    const lines = stdout.trim().split("\n").filter((l) => l.trim());
    return lines.length >= trigger.threshold;
  } catch (err) {
    log(`[Cron] git-uncommitted check failed (git not in PATH?): ${err}`);
    return false; // Graceful: no git → trigger doesn't fire
  }
}

/**
 * Check if a substring exists in a file.
 * Skips files larger than 1MB for safety.
 */
async function checkContentMatch(
  trigger: TriggerContentMatch,
  workspacePath: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const filePath = path.resolve(workspacePath, trigger.path);
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_CONTENT_MATCH_BYTES) {
      log(`[Cron] content-match: ${trigger.path} too large (${stat.size} bytes), skipping`);
      return false;
    }
    const content = await fsp.readFile(filePath, "utf-8");
    return content.includes(trigger.substring);
  } catch {
    return false;
  }
}

/**
 * Check if enough hours have elapsed since lastTriggered (or createdAt).
 */
function checkInterval(trigger: TriggerInterval, job: CronJob): boolean {
  const ref = job.lastTriggered ?? job.createdAt;
  if (!ref) return true; // No reference → fire immediately
  const elapsed = (Date.now() - new Date(ref).getTime()) / (1000 * 60 * 60);
  return elapsed >= trigger.hours;
}

// ─── CRUD helpers ──────────────────────────────────────────────────────

/** Read cron file, returning empty structure if missing/malformed. */
async function readCronFile(
  cronPath: string,
  _log: (msg: string) => void,
): Promise<CronFile> {
  try {
    await fsp.access(cronPath);
    const raw = await fsp.readFile(cronPath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data?.jobs)) return data;
  } catch {
    // Fall through
  }
  return { jobs: [] };
}

/**
 * Add a new cron job. Creates cron.json if it doesn't exist.
 * Rejects duplicate IDs.
 */
export async function addCronJob(
  memoryPath: string,
  job: CronJob,
  log: (msg: string) => void,
): Promise<void> {
  const cronPath = path.join(memoryPath, "cron.json");

  await enqueueWrite(cronPath, async () => {
    const cronFile = await readCronFile(cronPath, log);

    if (cronFile.jobs.some((j) => j.id === job.id)) {
      throw new Error(`Cron job '${job.id}' already exists`);
    }

    cronFile.jobs.push(job);
    await atomicWriteJson(cronPath, cronFile, log);
    log(`[Cron] added job: ${job.id}`);
  });
}

/**
 * Remove a cron job by ID. Returns true if found and removed.
 */
export async function removeCronJob(
  memoryPath: string,
  jobId: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const cronPath = path.join(memoryPath, "cron.json");
  let found = false;

  await enqueueWrite(cronPath, async () => {
    const cronFile = await readCronFile(cronPath, log);
    const idx = cronFile.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return;

    cronFile.jobs.splice(idx, 1);
    await atomicWriteJson(cronPath, cronFile, log);
    found = true;
    log(`[Cron] removed job: ${jobId}`);
  });

  return found;
}

/**
 * List all cron jobs. Returns empty array if no cron.json.
 */
export async function listCronJobs(
  memoryPath: string,
  log: (msg: string) => void,
): Promise<CronJob[]> {
  const cronPath = path.join(memoryPath, "cron.json");
  const cronFile = await readCronFile(cronPath, log);
  return cronFile.jobs;
}

/**
 * Snooze a cron job for N days. Sets status to "snoozed" and snoozeUntil.
 * Returns true if found.
 */
export async function snoozeCronJob(
  memoryPath: string,
  jobId: string,
  days: number,
  log: (msg: string) => void,
): Promise<boolean> {
  const cronPath = path.join(memoryPath, "cron.json");
  let found = false;

  await enqueueWrite(cronPath, async () => {
    const cronFile = await readCronFile(cronPath, log);
    const job = cronFile.jobs.find((j) => j.id === jobId);
    if (!job) return;

    job.status = "snoozed";
    job.snoozeUntil = new Date(
      Date.now() + days * 24 * 60 * 60 * 1000,
    ).toISOString();
    await atomicWriteJson(cronPath, cronFile, log);
    found = true;
    log(`[Cron] snoozed job ${jobId} for ${days} days`);
  });

  return found;
}

/**
 * Mark a cron job as done. Returns true if found.
 * Recurring jobs (recurring: true) are NOT marked done — they are snoozed
 * for their cooldownDays instead. This prevents polling-based jobs like
 * git-uncommitted from being permanently silenced.
 */
export async function completeCronJob(
  memoryPath: string,
  jobId: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const cronPath = path.join(memoryPath, "cron.json");
  let found = false;

  await enqueueWrite(cronPath, async () => {
    const cronFile = await readCronFile(cronPath, log);
    const job = cronFile.jobs.find((j) => j.id === jobId);
    if (!job) return;

    if (job.recurring) {
      // Recurring jobs get snoozed, not killed
      const snoozeMs = getCooldownMs(job);
      const effectiveSnoozeMs = snoozeMs > 0 ? snoozeMs : 24 * 60 * 60 * 1000;
      const snoozeUntil = new Date(Date.now() + effectiveSnoozeMs);
      job.status = "snoozed";
      job.snoozeUntil = snoozeUntil.toISOString();
      log(`[Cron] recurring job ${jobId} snoozed instead of completed`);
    } else {
      job.status = "done";
      log(`[Cron] completed job ${jobId}`);
    }

    await atomicWriteJson(cronPath, cronFile, log);
    found = true;
  });

  return found;
}

/**
 * Toggle muted state for a cron job. Returns the new muted value, or null if not found.
 */
export async function toggleMuteCronJob(
  memoryPath: string,
  jobId: string,
  log: (msg: string) => void,
): Promise<boolean | null> {
  const cronPath = path.join(memoryPath, "cron.json");
  let newValue: boolean | null = null;

  await enqueueWrite(cronPath, async () => {
    const cronFile = await readCronFile(cronPath, log);
    const job = cronFile.jobs.find((j) => j.id === jobId);
    if (!job) return;

    job.muted = !job.muted;
    newValue = job.muted;
    await atomicWriteJson(cronPath, cronFile, log);
    log(`[Cron] job ${jobId} muted=${newValue}`);
  });

  return newValue;
}

// ─── Atomic write ──────────────────────────────────────────────────────

export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  log: (msg: string) => void,
): Promise<void> {
  const tmpPath = filePath + ".tmp";
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    log(`[Cron] atomic write failed: ${err}`);
    // Cleanup tmp if rename failed
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // ignore
    }
  }
}

// ─── Trigger builder from params bag ───────────────────────────────────

/**
 * Build a CronTrigger from a type string + params bag.
 * Used by LM tools to convert agent natural-language params into typed triggers.
 * Returns null if params are invalid for the given type.
 */
export function buildTriggerFromParams(
  type: string,
  params: Record<string, unknown>,
): CronTrigger | null {
  switch (type) {
    case "date-after": {
      const date = params.date as string | undefined;
      const days = params.days as number | undefined;
      if (date) return { type: "date-after", date };
      if (days && days > 0) {
        const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        return { type: "date-after", date: d.toISOString() };
      }
      return null;
    }
    case "interval": {
      const hours = params.hours as number | undefined;
      return hours && hours >= 0.5 ? { type: "interval", hours } : null;
    }
    case "file-lines": {
      const p = params.path as string | undefined;
      const threshold = params.threshold as number | undefined;
      return p && threshold && threshold > 0
        ? { type: "file-lines", path: p, threshold }
        : null;
    }
    case "content-match": {
      const p = params.path as string | undefined;
      const substring = params.substring as string | undefined;
      return p && substring ? { type: "content-match", path: p, substring } : null;
    }
    case "days-since": {
      const referenceFile = params.referenceFile as string | undefined;
      const days = params.days as number | undefined;
      return referenceFile && days && days > 0
        ? { type: "days-since", referenceFile, days }
        : null;
    }
    case "git-uncommitted": {
      const threshold = params.threshold as number | undefined;
      return threshold && threshold > 0
        ? { type: "git-uncommitted", threshold }
        : null;
    }
    case "always":
      return { type: "always" };
    default:
      return null;
  }
}
