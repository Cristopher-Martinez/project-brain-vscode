/**
 * Execution Checkpoint — Crash-recovery breadcrumbs for Context Window Death.
 * PROBLEM: When a session crashes mid-execution (context window full, network error,
 * VS Code restart), the next session only gets 07_SESSION_HANDOFF.md which contains
 * git state — but not WHAT the agent was doing, WHY, or what was TRIED.
 * SOLUTION: The loop engine writes a checkpoint to disk on every loopAwaitInput call.
 * The session-start hook reads it, detects "stale" checkpoints (session died), and
 * injects a rich crash-recovery context into the new session.
 * File: .project-brain/memory/sessions/execution-checkpoint.json
 * Flow:
 *   loop-engine (extension)  →  writes checkpoint on loopWaitForFeedback
 *   session-stop.mjs (hook)  →  clears checkpoint on clean exit
 *   session-start.mjs (hook) →  reads stale checkpoint, injects into context
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const CHECKPOINT_FILE = "execution-checkpoint.json";
const TOOL_CHECKPOINT_FILE = "tool-checkpoint.json";

/**
 * Save an execution checkpoint to disk.
 * Called by the extension's loop-engine when synthesis is posted.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @param {object} data - Checkpoint data
 * @param {string} data.sessionId
 * @param {string} data.goal
 * @param {string} data.lastSynthesis - Latest agent synthesis (rich summary)
 * @param {Array<{index: number, synthesis?: string, feedback?: string}>} [data.iterations]
 * @param {string} [data.startedAt] - ISO timestamp
 * @param {string} [data.status] - Always "in-progress" during execution
 */
export function saveCheckpoint(memoryDir, data) {
  const sessionsDir = join(memoryDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const checkpoint = {
    sessionId: data.sessionId,
    goal: data.goal || "(sin objetivo)",
    lastSynthesis: data.lastSynthesis || "",
    iterations: (data.iterations || []).map((it) => ({
      index: it.index,
      synthesis: (it.synthesis || "").slice(0, 500),
      feedback: (it.feedback || "").slice(0, 300),
    })),
    startedAt: data.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "in-progress",
  };

  writeFileSync(
    join(sessionsDir, CHECKPOINT_FILE),
    JSON.stringify(checkpoint, null, 2),
    "utf8",
  );
}

/**
 * Load the current execution checkpoint, if any.
 * Returns null if no checkpoint exists or it's corrupted.
 * @param {string} memoryDir
 * @returns {object|null}
 */
export function loadCheckpoint(memoryDir) {
  const filePath = join(memoryDir, "sessions", CHECKPOINT_FILE);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear the checkpoint (called on clean session end).
 * @param {string} memoryDir
 */
export function clearCheckpoint(memoryDir) {
  const filePath = join(memoryDir, "sessions", CHECKPOINT_FILE);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    
  }
}

/**
 * Check if a checkpoint is "stale" — meaning the session crashed.
 * A checkpoint is stale if:
 *   1. status === "in-progress"
 *   2. It exists (it should have been cleared on clean exit)
 * @param {object|null} checkpoint
 * @returns {boolean}
 */
export function isStaleCheckpoint(checkpoint) {
  if (!checkpoint) return false;
  return checkpoint.status === "in-progress";
}

/**
 * Format a stale checkpoint for injection into session-start context.
 * This is the crash-recovery payload — gives the new session everything
 * it needs to understand what was happening when the previous one died.
 * @param {object} checkpoint
 * @returns {string} Markdown-formatted crash recovery context
 */
export function formatCheckpointForInjection(checkpoint) {
  if (!checkpoint) return "";

  const parts = [];
  parts.push(`**Sesión interrumpida**: \`${checkpoint.sessionId}\``);
  parts.push(`**Objetivo**: ${checkpoint.goal}`);
  parts.push(`**Última actualización**: ${checkpoint.updatedAt}`);

  if (checkpoint.lastSynthesis) {
    parts.push(`\n**Última síntesis del agente** (lo que estaba haciendo cuando murió):\n> ${checkpoint.lastSynthesis.replace(/\n/g, "\n> ")}`);
  }

  if (checkpoint.iterations?.length > 0) {
    parts.push(`\n**Historial de rondas** (${checkpoint.iterations.length} completadas):`);
    // Show last 3 iterations for context
    const recent = checkpoint.iterations.slice(-3);
    for (const it of recent) {
      const synth = it.synthesis ? it.synthesis.slice(0, 200) : "(sin síntesis)";
      const fb = it.feedback ? ` → Feedback: ${it.feedback.slice(0, 100)}` : "";
      parts.push(`- Ronda ${it.index}: ${synth}${fb}`);
    }
  }

  parts.push(
    `\n**ACCIÓN REQUERIDA**: La sesión anterior murió mid-ejecución. ` +
    `Usa esta información para continuar donde se quedó. ` +
    `NO repitas trabajo ya completado — verifica el estado actual primero.`
  );

  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL-LEVEL CHECKPOINTS — Finer granularity (pre-tool → post-tool lifecycle)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save a tool-level checkpoint before a tool executes.
 * Written by pre-tool hook, cleared by post-tool hook.
 * If the session crashes during tool execution, this tells us exactly
 * which tool was running and what it was trying to do.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @param {object} data
 * @param {string} data.tool - Tool name
 * @param {string} [data.inputSummary] - Compact summary of tool input
 */
export function saveToolCheckpoint(memoryDir, data) {
  const sessionsDir = join(memoryDir, "sessions");
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

  const checkpoint = {
    tool: data.tool,
    inputSummary: (data.inputSummary || "").slice(0, 300),
    startedAt: new Date().toISOString(),
  };

  writeFileSync(
    join(sessionsDir, TOOL_CHECKPOINT_FILE),
    JSON.stringify(checkpoint),
    "utf8",
  );
}

/**
 * Load the tool-level checkpoint, if any.
 * @param {string} memoryDir
 * @returns {object|null}
 */
export function loadToolCheckpoint(memoryDir) {
  const filePath = join(memoryDir, "sessions", TOOL_CHECKPOINT_FILE);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Clear the tool-level checkpoint (called by post-tool hook after success).
 * @param {string} memoryDir
 */
export function clearToolCheckpoint(memoryDir) {
  const filePath = join(memoryDir, "sessions", TOOL_CHECKPOINT_FILE);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    
  }
}

/**
 * Summarize tool input compactly for checkpoint storage.
 * Avoids storing huge replacement strings or file contents.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string} Compact summary (max ~300 chars)
 */
export function summarizeToolInput(toolName, toolInput) {
  if (!toolInput) return "";

  switch (toolName) {
    case "replace_string_in_file":
    case "create_file":
      return `file: ${(toolInput.filePath || "").split(/[/\\]/).pop()}`;

    case "multi_replace_string_in_file":
      return `${(toolInput.replacements || []).length} replacements: ${(toolInput.explanation || "").slice(0, 200)}`;

    case "run_in_terminal":
      return `cmd: ${(toolInput.command || "").slice(0, 250)}`;

    case "grep_search":
    case "semantic_search":
      return `query: ${(toolInput.query || "").slice(0, 250)}`;

    case "read_file":
      return `file: ${(toolInput.filePath || "").split(/[/\\]/).pop()} L${toolInput.startLine || "?"}-${toolInput.endLine || "?"}`;

    case "file_search":
      return `glob: ${(toolInput.query || "").slice(0, 250)}`;

    default:
      return JSON.stringify(toolInput).slice(0, 250);
  }
}
