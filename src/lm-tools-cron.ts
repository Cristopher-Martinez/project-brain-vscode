/**
 * Cron Reminder LM Tools — extracted from lm-tools.ts
 *
 * CreateReminderTool, ListRemindersTool, SnoozeReminderTool, CompleteReminderTool
 * All Pro+ gated via Toolbox plan checks.
 */

import * as vscode from "vscode";
import {
  addCronJob,
  buildTriggerFromParams,
  completeCronJob,
  listCronJobs,
  snoozeCronJob,
  type CronJob,
} from "./cron-engine";

// ═══════════════════════════════════════════════════════════════════════
// CRON REMINDER TOOLS (Pro+)
// ═══════════════════════════════════════════════════════════════════════

// ——— createReminder ————————————————————————————————————————————————

export interface CreateReminderInput {
  message: string;
  triggerType:
    | "date-after"
    | "interval"
    | "file-lines"
    | "content-match"
    | "days-since"
    | "git-uncommitted"
    | "always";
  /** For date-after: ISO date string. For interval: hours. For file-lines: { path, threshold }. etc. */
  triggerParams?: Record<string, unknown>;
  priority?: "info" | "warning" | "critical";
  cooldownDays?: number;
}

export class CreateReminderTool implements vscode.LanguageModelTool<CreateReminderInput> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateReminderInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { message, triggerType, triggerParams, priority, cooldownDays } =
      options.input;

    if (!message || message.trim().length < 5) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("❌ Message required (min 5 chars)."),
      ]);
    }

    const trigger = buildTriggerFromParams(triggerType, triggerParams ?? {});
    if (!trigger) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ Invalid trigger params for type "${triggerType}".`,
        ),
      ]);
    }

    const job: CronJob = {
      id: `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description: message.trim(),
      trigger,
      message: message.trim(),
      priority: priority ?? "info",
      status: "active",
      createdAt: new Date().toISOString(),
      lastTriggered: null,
      cooldownDays: cooldownDays ?? (triggerType === "interval" ? 0 : 1),
      snoozeUntil: null,
    };

    try {
      await addCronJob(this.memoryPath, job, this.log);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`❌ Error: ${msg}`),
      ]);
    }

    const msg = `✅ Reminder created: "${job.description}" (${job.trigger.type}, ${job.priority}) [${job.id}]`;
    this.log(`[Cron] createReminder: ${job.id}`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}

// ——— listReminders ————————————————————————————————————————————————

export interface ListRemindersInput {
  status?: "active" | "snoozed" | "done" | "all";
}

export class ListRemindersTool implements vscode.LanguageModelTool<ListRemindersInput> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListRemindersInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const jobs = await listCronJobs(this.memoryPath, this.log);
    const filter = options.input.status ?? "all";
    const filtered =
      filter === "all" ? jobs : jobs.filter((j) => j.status === filter);

    if (filtered.length === 0) {
      const msg =
        filter === "all"
          ? "No reminders found."
          : `No ${filter} reminders found.`;
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(msg),
      ]);
    }

    const lines = filtered.map((j) => {
      const snooze = j.snoozeUntil ? ` (snoozed until ${j.snoozeUntil})` : "";
      const prio =
        j.priority === "critical"
          ? "🚨"
          : j.priority === "warning"
            ? "⚠️"
            : "📌";
      return `${prio} **${j.description}** — ${j.trigger.type} [${j.status}]${snooze} \`${j.id}\``;
    });

    const msg = `## Reminders (${filtered.length})\n${lines.join("\n")}`;
    this.log(`[Cron] listReminders: ${filtered.length} jobs`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}

// ——— snoozeReminder ——————————————————————————————————————————————

export interface SnoozeReminderInput {
  id: string;
  days: number;
}

export class SnoozeReminderTool implements vscode.LanguageModelTool<SnoozeReminderInput> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SnoozeReminderInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { id, days } = options.input;

    if (!id || !days || days < 0.01) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "❌ Provide reminder ID and days > 0.",
        ),
      ]);
    }

    let found: boolean;
    try {
      found = await snoozeCronJob(this.memoryPath, id, days, this.log);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`❌ ${msg}`),
      ]);
    }

    if (!found) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`❌ Reminder "${id}" not found.`),
      ]);
    }

    const until = new Date(
      Date.now() + days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const msg = `😴 Reminder "${id}" snoozed until ${until}`;
    this.log(`[Cron] snoozeReminder: ${id} for ${days}d`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}

// ——— completeReminder ——————————————————————————————————————————

export interface CompleteReminderInput {
  id: string;
}

export class CompleteReminderTool implements vscode.LanguageModelTool<CompleteReminderInput> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CompleteReminderInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { id } = options.input;

    if (!id) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("❌ Provide reminder ID."),
      ]);
    }

    let found: boolean;
    try {
      found = await completeCronJob(this.memoryPath, id, this.log);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`❌ ${msg}`),
      ]);
    }

    if (!found) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`❌ Reminder "${id}" not found.`),
      ]);
    }

    const msg = `✅ Reminder "${id}" marked as done.`;
    this.log(`[Cron] completeReminder: ${id}`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}
