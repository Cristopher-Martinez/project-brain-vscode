import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ——— Session Summarizer Helpers ————————————————————————————————————————————————
// Extracted from session-summarizer.ts to keep it under 400 lines.
// Contains: types, pending context writer, context builder, prompt builder.
// ——————————————————————————————————————————————————————————————————————————————

export const PENDING_FILE = ".session-pending.json";

export interface PendingSession {
  date: string;
  branch: string;
  lastCommit: string;
  recentCommits: string;
  uncommittedChanges: string;
  diffStat: string;
  changedFiles: string;
  taskContext?: string;
}

/**
 * Write a pending session context file.
 * Called from the stop hook or from deactivate().
 */
export function writePendingContext(memoryPath: string, cwd: string): void {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim();
    } catch {
      return "(unavailable)";
    }
  };

  const pending: PendingSession = {
    date: new Date().toISOString(),
    branch: run("git branch --show-current"),
    lastCommit: run('git log -1 --format="%h %s"'),
    recentCommits: run("git log --oneline -10"),
    uncommittedChanges: run("git status --short"),
    diffStat: run("git diff --stat HEAD~5"),
    changedFiles: run("git diff --name-only HEAD~5"),
  };

  const pendingPath = path.join(memoryPath, PENDING_FILE);
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf8");
}

/**
 * Build a text context string from the pending session data.
 * Includes tool-usage stats and TASK_QUEUE decisions if available.
 */
export function buildSessionContext(
  memoryPath: string,
  log: (msg: string) => void,
  pending: PendingSession,
): string {
  const parts = [
    `**Branch**: ${pending.branch}`,
    `**Date**: ${pending.date}`,
    `**Last commit**: ${pending.lastCommit}`,
    "",
    "### Recent commits",
    pending.recentCommits,
    "",
    "### Changed files",
    pending.changedFiles,
    "",
    "### Diff stats",
    pending.diffStat,
    "",
    "### Uncommitted changes",
    pending.uncommittedChanges || "(clean)",
  ];

  if (pending.taskContext) {
    parts.push("", "### Task context", pending.taskContext);
  }

  appendToolUsage(parts, memoryPath, log);
  appendTaskQueue(parts, memoryPath, log);

  return parts.join("\n");
}

/** Append tool-usage.jsonl stats to context parts (mutates array). */
function appendToolUsage(
  parts: string[],
  memoryPath: string,
  log: (msg: string) => void,
): void {
  const toolUsagePath = path.join(
    memoryPath,
    "sessions",
    "tool-usage.jsonl",
  );
  if (!fs.existsSync(toolUsagePath)) return;

  try {
    const raw = fs.readFileSync(toolUsagePath, "utf8").trim();
    if (!raw) return;

    const lines = raw.split("\n").slice(-30); // Last 30 entries max
    const errors = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(
        (
          e,
        ): e is { t: string; tool: string; err: boolean; snip: string } =>
          e !== null,
      );

    if (errors.length > 0) {
      const errorEntries = errors.filter((e) => e.err);
      const toolSummary = errors.reduce<Record<string, number>>(
        (acc, e) => {
          acc[e.tool] = (acc[e.tool] || 0) + 1;
          return acc;
        },
        {},
      );

      parts.push("", "### Tool usage");
      parts.push(
        `Total: ${errors.length} entries, ${errorEntries.length} errors`,
      );
      parts.push(
        "Tools: " +
          Object.entries(toolSummary)
            .map(([k, v]) => `${k}(${v})`)
            .join(", "),
      );

      if (errorEntries.length > 0) {
        parts.push("", "Errors:");
        for (const e of errorEntries.slice(-5)) {
          parts.push(`- [${e.tool}] ${e.snip.substring(0, 100)}`);
        }
      }
    }

    // Clear the file after reading (it's been consumed)
    fs.writeFileSync(toolUsagePath, "", "utf8");
  } catch (e) {
    log(`[SessionSummarizer] Error reading tool-usage.jsonl: ${e}`);
  }
}

/** Append TASK_QUEUE decisions to context parts (mutates array). */
function appendTaskQueue(
  parts: string[],
  memoryPath: string,
  log: (msg: string) => void,
): void {
  const taskQueuePath = path.join(memoryPath, "TASK_QUEUE.md");
  if (!fs.existsSync(taskQueuePath)) return;

  try {
    const taskContent = fs.readFileSync(taskQueuePath, "utf8").trim();
    // Only include the last 2 Pre-Compact sections
    const sections = taskContent.split(/\n## Pre-Compact Save/).slice(-2);
    if (sections.length > 0 && sections.some((s) => s.trim().length > 10)) {
      parts.push(
        "",
        "### Prior decisions (TASK_QUEUE)",
        sections
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  } catch (e) {
    log(`[SessionSummarizer] Error reading TASK_QUEUE.md: ${e}`);
  }
}

/**
 * Build the LM chat messages for session summarization.
 * Detects language from identity config and returns bilingual prompts.
 */
export function buildSummarizationMessages(
  context: string,
  memoryPath: string,
): vscode.LanguageModelChatMessage[] {
  // Read language from identity config
  let lang = "English";
  try {
    const idPath = path.join(memoryPath, "08_AGENT_IDENTITY.md");
    const idRaw = fs.readFileSync(idPath, "utf-8");
    lang = idRaw.match(/\*\*Language\*\*:\s*(.+)/)?.[1]?.trim() ?? "English";
  } catch {
    /* default English */
  }
  const isEs = /espa[nñ]ol|spanish/i.test(lang);

  return [
    vscode.LanguageModelChatMessage.User(
      isEs
        ? `Eres un documentador de sesiones de desarrollo de software. Analiza el siguiente contexto de una sesión de desarrollo y genera un resumen estructurado en español.

REGLAS:
- Sé conciso pero específico (archivos, funciones, líneas concretas cuando sea posible)
- Solo incluye secciones que tengan contenido real derivado del contexto
- NO inventes información que no esté en el contexto
- Usa markdown
- Si no hay suficiente información para una sección, omítela

FORMATO REQUERIDO (solo incluir secciones con contenido):

## Aprendizajes
- [cosas nuevas descubiertas o patrones identificados]

## Decisiones Tomadas
- [decisiones de diseño, implementación o arquitectura con su justificación]

## Errores Resueltos
- [bugs o problemas encontrados y cómo se solucionaron]

## Consideraciones
- [aspectos importantes a tener en cuenta para el futuro]

## Próximos Pasos
- [qué queda pendiente o se debería hacer a continuación]

---

CONTEXTO DE LA SESIÓN:
${context}`
        : `You are a software development session documenter. Analyze the following development session context and generate a structured summary in ${lang}.

RULES:
- Be concise but specific (files, functions, concrete lines when possible)
- Only include sections with real content derived from context
- Do NOT invent information not present in context
- Use markdown
- If there's not enough information for a section, omit it

REQUIRED FORMAT (only include sections with content):

## Learnings
- [new discoveries or identified patterns]

## Decisions Made
- [design, implementation, or architecture decisions with rationale]

## Errors Resolved
- [bugs or issues found and how they were fixed]

## Considerations
- [important aspects to keep in mind for the future]

## Next Steps
- [what's pending or should be done next]

---

SESSION CONTEXT:
${context}`,
    ),
  ];
}
