/**
 * Agent Diary — portable (zero vscode deps).
 *
 * Per-mode learning journals under `.project-brain/memory/agents/`.
 * Migrated from the extension's agent-diary so diaries work from ANY MCP
 * client (Codex, Cursor, OpenCode…). Pure fs/path; takes memoryPath directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface DiaryEntry {
  date: string;
  title: string;
  context: string;
  learning: string;
  confidence: "high" | "medium" | "low";
}

export type AgentMode =
  | "documenter"
  | "reviewer"
  | "planner"
  | "researcher"
  | "onboard"
  | "project-brain"
  | "general";

export const DIARY_DIR = "agents";
const MAX_DIARY_ENTRIES = 100;
const MAX_RECALL_ENTRIES = 5;
const VALID_MODES = ["documenter", "reviewer", "planner", "researcher", "onboard", "project-brain", "general"];

function diaryFilename(mode: AgentMode): string {
  return `${mode}-diary.md`;
}

function diaryPath(memoryPath: string, mode: AgentMode): string {
  return path.join(memoryPath, DIARY_DIR, diaryFilename(mode));
}

function isValidMode(mode: string): mode is AgentMode {
  return VALID_MODES.includes(mode);
}

/** Ensure agents/ directory exists. Idempotent. */
export function ensureAgentsDir(memoryPath: string): void {
  const agentsDir = path.join(memoryPath, DIARY_DIR);
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
}

/** Read full diary content for a mode. */
export function readFullDiary(memoryPath: string, mode: string): string {
  if (!isValidMode(mode)) {
    return `Unknown agent mode: "${mode}". Valid: ${VALID_MODES.join(", ")}.`;
  }
  const filePath = diaryPath(memoryPath, mode);
  if (!fs.existsSync(filePath)) {
    return `No diary found for ${mode}. It will be created on first write.`;
  }
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return `Error reading diary: ${err}`;
  }
}

/** Read last N entries (recall slice) for a mode. */
export function readDiaryRecall(memoryPath: string, mode: string): string {
  if (!isValidMode(mode)) return "";
  const filePath = diaryPath(memoryPath, mode);
  if (!fs.existsSync(filePath)) return "";
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entries = content.split(/^## /m).filter(Boolean).slice(-MAX_RECALL_ENTRIES);
    if (entries.length === 0) return "";
    return `## Agent Diary (${mode})\n\n${entries.map((e) => "## " + e).join("\n")}`;
  } catch {
    return "";
  }
}

/** Append a diary entry. Creates file if missing. Rotates over MAX_DIARY_ENTRIES. */
export function appendToDiary(
  memoryPath: string,
  mode: string,
  entry: DiaryEntry,
): boolean {
  if (!isValidMode(mode)) return false;

  ensureAgentsDir(memoryPath);
  const filePath = diaryPath(memoryPath, mode);

  const formatted =
    `## ${entry.date} — ${entry.title}\n` +
    `**Context**: ${entry.context}\n` +
    `**Learning**: ${entry.learning}\n` +
    `**Confidence**: ${entry.confidence}\n\n---\n\n`;

  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");
      const sections = existing.split(/^## /m).filter(Boolean);
      if (sections.length >= MAX_DIARY_ENTRIES) {
        const trimmed = sections.slice(-MAX_DIARY_ENTRIES + 1);
        const rotated = trimmed.map((s) => "## " + s).join("") + formatted;
        fs.writeFileSync(filePath, rotated, "utf-8");
        return true;
      }
    }
    fs.appendFileSync(filePath, formatted, "utf-8");
    return true;
  } catch {
    return false;
  }
}
