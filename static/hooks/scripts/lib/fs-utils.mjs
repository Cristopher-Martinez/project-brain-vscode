/**
 * fs-utils.mjs — Safe file system utilities for hooks.
 * Provides capped reads and safe writes to prevent memory explosions
 * when reading large .project-brain/memory files from hooks.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { FILE_READ_MAX, KNOWLEDGE_MAX } from "./constants.mjs";
import {
  loadPipelineConfig,
  getPipelineBasenamesFromConfig,
} from "./pipeline-config.mjs";

/**
 * Read a file with a character cap. Returns empty string if missing/error.
 * @param {string} filePath - Absolute path to read
 * @param {number} [maxLen] - Max characters to return (default: FILE_READ_MAX)
 * @returns {string} File content (capped) or empty string
 */
export function safeRead(filePath, maxLen = FILE_READ_MAX) {
  try {
    if (!existsSync(filePath)) return "";
    // Check file size first to avoid reading huge files into memory
    const stats = statSync(filePath);
    if (stats.size === 0) return "";
    // Read with byte limit (rough: 1 char ≈ 1 byte for ASCII/UTF-8 common chars)
    const content = readFileSync(filePath, "utf8");
    if (content.length <= maxLen) return content;
    // Cut at last newline before cap to avoid mid-line truncation
    const cutIndex = content.lastIndexOf("\n", maxLen);
    return cutIndex > maxLen * 0.5
      ? content.slice(0, cutIndex)
      : content.slice(0, maxLen);
  } catch {
    return "";
  }
}

/**
 * Count lines in a file without reading the entire content into a string.
 * Uses readFileSync but avoids allocating arrays.
 * @param {string} filePath - Absolute path to file
 * @param {number} [maxLines=5000] - Stop counting after this many lines
 * @returns {number} Line count (0 if file missing/error)
 */
export function countLines(filePath, maxLines = 5000) {
  try {
    if (!existsSync(filePath)) return 0;
    const content = readFileSync(filePath, "utf8");
    let count = 0;
    let pos = 0;
    while (pos < content.length && count < maxLines) {
      const idx = content.indexOf("\n", pos);
      if (idx === -1) break;
      count++;
      pos = idx + 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Read the pre-computed knowledge summary file.
 * Falls back to empty string if not generated yet.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {string} Knowledge summary content or empty
 */
export function readKnowledgeSummary(memoryDir) {
  return safeRead(
    join(memoryDir, "sessions", "knowledge-summary.txt"),
    KNOWLEDGE_MAX,
  );
}

/**
 * Append a file path to the session edit tracker.
 * Used by PostToolUse to remember which files were edited this session.
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @param {string} filePath - Absolute path of edited file
 */
export function appendEditTracker(sessionsDir, filePath) {
  try {
    const basename = filePath.split(/[/\\]/).pop() || "";
    if (!basename) return;
    appendFileSync(
      join(sessionsDir, "edit-tracker.txt"),
      basename + "\n",
      "utf8",
    );
  } catch {
    
  }
}

/**
 * Read unique file basenames from the edit tracker, then clear it.
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @returns {string[]} Unique basenames (e.g., ["brain-hq.ts", "lm-tools.ts"])
 */
export function readAndClearEditTracker(sessionsDir) {
  const trackerPath = join(sessionsDir, "edit-tracker.txt");
  try {
    if (!existsSync(trackerPath)) return [];
    const content = readFileSync(trackerPath, "utf8");
    const unique = [...new Set(content.split("\n").filter(Boolean))];
    writeFileSync(trackerPath, "", "utf8"); // clear after read
    return unique;
  } catch {
    return [];
  }
}

/**
 * Pipeline file basenames (lowercased) — files that are part of
 * known message pipelines and need coordinated changes.
 * HARDCODED FALLBACK — config-driven basenames are checked first.
 */
const PIPELINE_BASENAMES = new Set([
  "messages.ts",
  "reducer.ts",
  "messagehandler.ts",
  "brain-hq-message-handler.ts",
  "brain-hq-loop-handler.ts",
  "brain-hq-gateway-handler.ts",
  "brain-hq-branch-handler.ts",
]);

/**
 * Check if a file is a pipeline file using config (primary) or hardcoded set (fallback).
 * @param {string} lower - Lowercased basename
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/ (to derive cwd)
 * @returns {boolean}
 */
function isPipelineFileSync(lower, sessionsDir) {
  // Try config-driven check first
  try {
    // sessionsDir = <cwd>/.project-brain/memory/sessions → cwd = 3 levels up
    const cwd = join(sessionsDir, "..", "..", "..");
    const config = loadPipelineConfig(cwd);
    if (config) {
      const configBasenames = getPipelineBasenamesFromConfig(config);
      if (configBasenames.has(lower)) return true;
      // Also check handlerPattern from config pipelines
      for (const pipeline of config.pipelines || []) {
        if (pipeline.handlerPattern && new RegExp(pipeline.handlerPattern).test(lower)) return true;
      }
    }
  } catch { /* fall through to hardcoded */ }
  // Hardcoded fallback
  return PIPELINE_BASENAMES.has(lower) || /^brain-hq-\w+-handler\.ts$/.test(lower);
}

/**
 * Append a pipeline edit to the session pipeline tracker.
 * Unlike edit-tracker.txt, this is NOT cleared during knowledge injection.
 * It accumulates pipeline edits across the session for integration audit reminders.
 * Uses config-driven basenames when available, hardcoded fallback otherwise.
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @param {string} basename - Basename of the edited file
 */
export function appendPipelineEdit(sessionsDir, basename) {
  const lower = basename.toLowerCase();
  // Config-driven check (sync: read config inline)
  if (!isPipelineFileSync(lower, sessionsDir)) return;
  try {
    appendFileSync(
      join(sessionsDir, "pipeline-edit-tracker.txt"),
      basename + "\n",
      "utf8",
    );
  } catch {
    
  }
}

/**
 * Read unique pipeline file edits from the session tracker (without clearing).
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @returns {string[]} Unique pipeline basenames edited this session
 */
export function readPipelineEdits(sessionsDir) {
  const trackerPath = join(sessionsDir, "pipeline-edit-tracker.txt");
  try {
    if (!existsSync(trackerPath)) return [];
    const content = readFileSync(trackerPath, "utf8");
    return [...new Set(content.split("\n").filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Detect pipeline integration gaps from the session's pipeline-edit-tracker.
 * Reusable by both PreToolUse and PostToolUse hooks.
 * @param {string} cwd - Workspace root path
 * @returns {string[]} Gap warning strings, empty if no gaps
 */
export function detectPipelineGaps(cwd) {
  try {
    const sessionsDir = join(cwd, "docs", "memory", "sessions");
    const pipelineEdits = readPipelineEdits(sessionsDir);
    if (pipelineEdits.length < 2) return [];
    const editSet = new Set(pipelineEdits.map((f) => f.toLowerCase()));
    const gaps = [];
    if (editSet.has("messages.ts") && !editSet.has("brain-hq-message-handler.ts")) {
      gaps.push("messages.ts editado sin brain-hq-message-handler.ts (routing switch)");
    }
    if (editSet.has("messages.ts") && !editSet.has("messagehandler.ts")) {
      gaps.push("messages.ts editado sin messageHandler.ts (dispatch case)");
    }
    if (editSet.has("reducer.ts") && !editSet.has("messages.ts")) {
      gaps.push("reducer.ts editado sin messages.ts (type definitions)");
    }
    if (editSet.has("messagehandler.ts") && !editSet.has("reducer.ts")) {
      gaps.push("messageHandler.ts editado sin reducer.ts (action + case)");
    }
    if (editSet.has("brain-hq-message-handler.ts") && !editSet.has("messages.ts")) {
      gaps.push("brain-hq-message-handler.ts editado sin messages.ts (types)");
    }
    const handlerRx = /^brain-hq-\w+-handler\.ts$/;
    const hasHandler = [...editSet].some(
      (f) => handlerRx.test(f) && f !== "brain-hq-message-handler.ts",
    );
    if (hasHandler && !editSet.has("brain-hq-message-handler.ts")) {
      gaps.push("Handler file editado sin brain-hq-message-handler.ts (routing)");
    }
    return gaps;
  } catch {
    return [];
  }
}
