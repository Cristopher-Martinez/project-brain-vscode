/**
 * Cron Composer — QuickPick-driven cron job creation flow.
 *
 * Guides the user through trigger type selection and parameter input
 * via VS Code QuickPick/InputBox. Produces a complete CronJob and
 * writes it to cron.json via addCronJob().
 *
 * Depends on VS Code API — NOT unit-testable, only integration-testable.
 */

import * as vscode from "vscode";
import { addCronJob, type CronJob, type CronTrigger } from "./cron-engine";

/** Trigger type options for QuickPick. */
const TRIGGER_OPTIONS: vscode.QuickPickItem[] = [
  {
    label: "$(calendar) Fecha específica",
    description: "date-after",
    detail: "Se dispara después de una fecha (ej: 'en 3 días')",
  },
  {
    label: "$(watch) Intervalo periódico",
    description: "interval",
    detail: "Se repite cada N horas (ej: cada 24 horas)",
  },
  {
    label: "$(file-text) Líneas en archivo",
    description: "file-lines",
    detail: "Se dispara cuando un archivo supera N líneas",
  },
  {
    label: "$(search) Contenido en archivo",
    description: "content-match",
    detail: "Se dispara cuando un archivo contiene un texto específico",
  },
  {
    label: "$(clock) Días sin modificar",
    description: "days-since",
    detail: "Se dispara cuando un archivo lleva N días sin cambios",
  },
  {
    label: "$(git-commit) Archivos sin commit",
    description: "git-uncommitted",
    detail: "Se dispara cuando hay N+ archivos sin commit",
  },
  {
    label: "$(zap) Siempre",
    description: "always",
    detail: "Se dispara en cada evaluación (útil para tests)",
  },
];

const PRIORITY_OPTIONS: vscode.QuickPickItem[] = [
  { label: "📌 Info", description: "info" },
  { label: "⚠️ Warning", description: "warning" },
  { label: "🚨 Critical", description: "critical" },
];

/**
 * Guide the user through creating a cron job via QuickPick.
 * Returns the created job, or null if cancelled.
 */
export async function composeCronJob(
  memoryPath: string,
  log: (msg: string) => void,
): Promise<CronJob | null> {
  // Step 1: Message
  const message = await vscode.window.showInputBox({
    title: "Nuevo Recordatorio (1/4): Mensaje",
    prompt: "¿Qué quieres que te recuerde?",
    placeHolder: "Ej: Revisar los tests de integración",
    validateInput: (v) => (v.trim().length < 5 ? "Mínimo 5 caracteres" : undefined),
  });
  if (!message) return null;

  // Step 2: Trigger type
  const triggerPick = await vscode.window.showQuickPick(TRIGGER_OPTIONS, {
    title: "Nuevo Recordatorio (2/4): Tipo de trigger",
    placeHolder: "¿Cuándo debe activarse?",
  });
  if (!triggerPick) return null;

  const triggerType = triggerPick.description!;

  // Step 3: Trigger parameters
  const trigger = await buildTrigger(triggerType);
  if (!trigger) return null;

  // Step 4: Priority
  const priorityPick = await vscode.window.showQuickPick(PRIORITY_OPTIONS, {
    title: "Nuevo Recordatorio (4/4): Prioridad",
    placeHolder: "¿Qué tan importante es?",
  });
  if (!priorityPick) return null;

  const priority = priorityPick.description as "info" | "warning" | "critical";

  // Build the job
  const id = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const job: CronJob = {
    id,
    description: message.trim(),
    trigger,
    message: message.trim(),
    priority,
    status: "active",
    createdAt: new Date().toISOString(),
    lastTriggered: null,
    cooldownDays: trigger.type === "interval" ? 0 : 1,
    snoozeUntil: null,
  };

  try {
    await addCronJob(memoryPath, job, log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Error al crear recordatorio: ${msg}`);
    return null;
  }
  return job;
}

// ─── Trigger builders ──────────────────────────────────────────────────

async function buildTrigger(type: string): Promise<CronTrigger | null> {
  switch (type) {
    case "date-after":
      return buildDateAfter();
    case "interval":
      return buildInterval();
    case "file-lines":
      return buildFileLines();
    case "content-match":
      return buildContentMatch();
    case "days-since":
      return buildDaysSince();
    case "git-uncommitted":
      return buildGitUncommitted();
    case "always":
      return { type: "always" };
    default:
      return null;
  }
}

async function buildDateAfter(): Promise<CronTrigger | null> {
  const input = await vscode.window.showInputBox({
    title: "Trigger: Fecha",
    prompt: "¿En cuántos días? (número)",
    placeHolder: "Ej: 3",
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) || n < 1 ? "Ingresa un número positivo" : undefined;
    },
  });
  if (!input) return null;

  const days = parseInt(input, 10);
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return { type: "date-after", date: date.toISOString() };
}

async function buildInterval(): Promise<CronTrigger | null> {
  const input = await vscode.window.showInputBox({
    title: "Trigger: Intervalo",
    prompt: "¿Cada cuántas horas? (número)",
    placeHolder: "Ej: 24",
    validateInput: (v) => {
      const n = parseFloat(v);
      return isNaN(n) || n < 0.5 ? "Mínimo 0.5 horas" : undefined;
    },
  });
  if (!input) return null;

  return { type: "interval", hours: parseFloat(input) };
}

async function buildFileLines(): Promise<CronTrigger | null> {
  const filePath = await vscode.window.showInputBox({
    title: "Trigger: Líneas en archivo (1/2)",
    prompt: "Ruta relativa al archivo",
    placeHolder: "Ej: .project-brain/memory/sessions/tool-usage.jsonl",
    validateInput: (v) => (v.trim().length === 0 ? "La ruta no puede estar vacía" : undefined),
  });
  if (!filePath) return null;

  const threshold = await vscode.window.showInputBox({
    title: "Trigger: Líneas en archivo (2/2)",
    prompt: "¿Cuántas líneas para activarse?",
    placeHolder: "Ej: 500",
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) || n < 1 ? "Número positivo" : undefined;
    },
  });
  if (!threshold) return null;

  return { type: "file-lines", path: filePath.trim(), threshold: parseInt(threshold, 10) };
}

async function buildContentMatch(): Promise<CronTrigger | null> {
  const filePath = await vscode.window.showInputBox({
    title: "Trigger: Contenido (1/2)",
    prompt: "Ruta relativa al archivo",
    placeHolder: "Ej: src/config.ts",
    validateInput: (v) => (v.trim().length === 0 ? "La ruta no puede estar vacía" : undefined),
  });
  if (!filePath) return null;

  const substring = await vscode.window.showInputBox({
    title: "Trigger: Contenido (2/2)",
    prompt: "Texto a buscar (case-sensitive)",
    placeHolder: "Ej: TODO: fix",
    validateInput: (v) => (v.length === 0 ? "El texto no puede estar vacío" : undefined),
  });
  if (!substring) return null;

  return { type: "content-match", path: filePath.trim(), substring: substring };
}

async function buildDaysSince(): Promise<CronTrigger | null> {
  const filePath = await vscode.window.showInputBox({
    title: "Trigger: Días sin modificar (1/2)",
    prompt: "Ruta relativa al archivo de referencia",
    placeHolder: "Ej: .project-brain/memory/14_OPINIONS.md",
    validateInput: (v) => (v.trim().length === 0 ? "La ruta no puede estar vacía" : undefined),
  });
  if (!filePath) return null;

  const days = await vscode.window.showInputBox({
    title: "Trigger: Días sin modificar (2/2)",
    prompt: "¿Cuántos días sin cambios para activarse?",
    placeHolder: "Ej: 7",
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) || n < 1 ? "Número positivo" : undefined;
    },
  });
  if (!days) return null;

  return { type: "days-since", referenceFile: filePath.trim(), days: parseInt(days, 10) };
}

async function buildGitUncommitted(): Promise<CronTrigger | null> {
  const threshold = await vscode.window.showInputBox({
    title: "Trigger: Archivos sin commit",
    prompt: "¿Cuántos archivos sin commit para activarse?",
    placeHolder: "Ej: 20",
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) || n < 1 ? "Número positivo" : undefined;
    },
  });
  if (!threshold) return null;

  return { type: "git-uncommitted", threshold: parseInt(threshold, 10) };
}
