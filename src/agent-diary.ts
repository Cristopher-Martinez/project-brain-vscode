/**
 * Agent Diary — Persistent per-mode learning journals.
 *
 * Inspired by MemPalace specialist agents: each agent mode
 * (reviewer, planner, documenter, etc.) maintains its own diary
 * of domain-specific learnings that survive across sessions.
 *
 * Diary entries are Markdown sections appended to per-mode files
 * under `.project-brain/memory/agents/`.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  | "project-brain";

export const DIARY_DIR = "agents";
const MAX_DIARY_ENTRIES = 100;
const MAX_RECALL_ENTRIES = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function diaryFilename(mode: AgentMode): string {
  return `${mode}-diary.md`;
}

function diaryPath(memoryPath: string, mode: AgentMode): string {
  return path.join(memoryPath, DIARY_DIR, diaryFilename(mode));
}

function isValidMode(mode: string): mode is AgentMode {
  return ["documenter", "reviewer", "planner", "researcher", "onboard", "project-brain"].includes(mode);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/** Ensure agents/ directory exists. Idempotent + no-op if already present. */
export function ensureAgentsDir(memoryPath: string): void {
  const agentsDir = path.join(memoryPath, DIARY_DIR);
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
    log("[AgentDiary] Created agents/ directory");
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Read last N entries from an agent's diary for auto-recall injection. */
export function readDiary(memoryPath: string, mode: string): string {
  if (!isValidMode(mode)) return "";
  const filePath = diaryPath(memoryPath, mode);
  if (!fs.existsSync(filePath)) return "";

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entries = content.split(/^## /m).filter(Boolean).slice(-MAX_RECALL_ENTRIES);
    if (entries.length === 0) return "";
    return `## Agent Diary (${mode})\n\n${entries.map((e) => "## " + e).join("\n")}`;
  } catch (err) {
    logWarn(`[AgentDiary] Failed to read ${mode} diary: ${err}`);
    return "";
  }
}

/** Read full diary content (for LM tool). */
export function readFullDiary(memoryPath: string, mode: string): string {
  if (!isValidMode(mode)) return `Unknown agent mode: "${mode}". Valid: documenter, reviewer, planner, researcher, onboard, project-brain.`;
  const filePath = diaryPath(memoryPath, mode);
  if (!fs.existsSync(filePath)) return `No diary found for ${mode}. It will be created when the agent captures its first learning.`;

  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    logWarn(`[AgentDiary] Failed to read full ${mode} diary: ${err}`);
    return `Error reading diary: ${err}`;
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Append a diary entry. Creates file if missing. Rotates if over MAX_DIARY_ENTRIES. */
export function appendToDiary(
  memoryPath: string,
  mode: string,
  entry: DiaryEntry,
): boolean {
  if (!isValidMode(mode)) {
    logWarn(`[AgentDiary] Invalid mode: "${mode}"`);
    return false;
  }

  ensureAgentsDir(memoryPath);
  const filePath = diaryPath(memoryPath, mode);

  const formatted =
    `## ${entry.date} — ${entry.title}\n` +
    `**Context**: ${entry.context}\n` +
    `**Learning**: ${entry.learning}\n` +
    `**Confidence**: ${entry.confidence}\n\n---\n\n`;

  try {
    // Rotation check: if file exists and has too many entries, trim oldest
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");
      const sections = existing.split(/^## /m).filter(Boolean);
      if (sections.length >= MAX_DIARY_ENTRIES) {
        const trimmed = sections.slice(-MAX_DIARY_ENTRIES + 1);
        const rotated = trimmed.map((s) => "## " + s).join("") + formatted;
        fs.writeFileSync(filePath, rotated, "utf-8");
        log(`[AgentDiary] Rotated ${mode} diary (kept ${MAX_DIARY_ENTRIES} entries)`);
        return true;
      }
    }

    fs.appendFileSync(filePath, formatted, "utf-8");
    log(`[AgentDiary] Appended to ${mode} diary: "${entry.title}"`);
    return true;
  } catch (err) {
    logWarn(`[AgentDiary] Failed to write ${mode} diary: ${err}`);
    return false;
  }
}
