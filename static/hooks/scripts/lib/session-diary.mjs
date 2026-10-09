/**
 * Session Diary — Episodic memory layer
 * Appends a compact chronological entry to 16_SESSION_DIARY.md at session end.
 * Reads last N entries at session start for temporal continuity.
 * Entry format:
 *   ## YYYY-MM-DD HH:MM | branch-name
 *   **Topics**: hooks, memory
 *   **Files**: bootstrapper.ts, session-stop.mjs (+3 more)
 *   **Summary**: Last commit message or task context
 *   **Status**: ✅ Clean | ⚠️ WIP | 📝 Docs
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const DIARY_FILE = "16_SESSION_DIARY.md";
const MAX_ENTRIES = 50;
const RECALL_COUNT = 3;
const MAX_FILES_SHOWN = 4;

// ─── Topic Mapping ──────────────────────────────────────────────────────────

/** @type {Array<[RegExp, string]>} */
const TOPIC_RULES = [
  [/\.github\/hooks\//, "hooks"],
  [/server\//, "mcp-server"],
  [/saas\//, "saas"],
  [/docs\/memory\//, "memory"],
  [/scripts\//, "scripts"],
  [/src\/swarm/, "swarm"],
  [/src\/brain-hq/, "brain-hq"],
  [/src\/loop/, "loops"],
  [/src\/cron/, "cron"],
  [/src\/opinion|src\/auto-capture|src\/auto-recall/, "neuroplasticity"],
  [/src\/session/, "sessions"],
  [/src\/branch/, "branches"],
  [/src\/chat/, "chat"],
  [/src\/model-router/, "model-router"],
  [/src\/mcp/, "mcp"],
  [/src\/saas|src\/cloud|src\/login/, "cloud"],
  [/src\/identity|src\/agent-identity/, "identity"],
  [/src\/bootstrapper/, "bootstrap"],
  [/src\/scanner/, "scanner"],
  [/src\/lm-tools/, "lm-tools"],
  [/webview-ui\//, "webview"],
  [/static\//, "static"],
  [/package\.json|tsconfig/, "config"],
  [/src\/self-learning/, "self-learning"],
];

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Extract topics from a list of file paths.
 * @param {string[]} files
 * @returns {string[]}
 */
function extractTopics(files) {
  const topics = new Set();
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    for (const [pattern, topic] of TOPIC_RULES) {
      if (pattern.test(normalized)) {
        topics.add(topic);
        break;
      }
    }
  }
  return [...topics].slice(0, 5);
}

/**
 * Extract file paths from git status --short output.
 * @param {string} gitStatus
 * @returns {string[]}
 */
function parseChangedFiles(gitStatus) {
  if (!gitStatus || gitStatus === "(unavailable)") return [];
  return gitStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[MADRCU?!\s]+\s+/, "")
        .replace(/^"(.+)"$/, "$1")
        .replace(/ -> .+$/, ""),
    )
    .filter(Boolean);
}

/**
 * Determine session outcome from git status.
 * @param {string} gitStatus
 * @param {string[]} files
 * @returns {string}
 */
function determineOutcome(gitStatus, files) {
  if (!gitStatus || gitStatus === "(unavailable)" || !gitStatus.trim()) {
    return "✅ Clean";
  }
  if (files.every((f) => /docs\/|\.md$|\.txt$/.test(f))) {
    return "📝 Docs";
  }
  return "⚠️ WIP";
}

/**
 * Format file list compactly, showing basenames to save space.
 * @param {string[]} files
 * @returns {string}
 */
function formatFiles(files) {
  if (files.length === 0) return "(no changes)";
  const names = [...new Set(files.map((f) => basename(f)))];
  if (names.length <= MAX_FILES_SHOWN) return names.join(", ");
  const shown = names.slice(0, MAX_FILES_SHOWN - 1);
  return `${shown.join(", ")} (+${names.length - shown.length} more)`;
}

/**
 * Extract summary line from a raw diary entry block.
 * @param {string} entryBlock - text after "## " header
 * @returns {string}
 */
function extractSummaryFromEntry(entryBlock) {
  const match = entryBlock.match(/\*\*Summary\*\*: (.+)/);
  return match ? match[1].trim().slice(0, 100) : "(no summary)";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Append a diary entry for the current session.
 * @param {string} memoryDir - path to .project-brain/memory/
 * @param {object} data
 * @param {string} data.branch - current git branch
 * @param {string} data.status - git status --short output
 * @param {string} data.lastCommit - "hash message" format
 * @param {string} [data.taskContext] - optional task description
 */
export function appendDiaryEntry(
  memoryDir,
  { branch, status, lastCommit, taskContext },
) {
  try {
    const diaryPath = join(memoryDir, DIARY_FILE);
    const files = parseChangedFiles(status);
    const topics = extractTopics(files);
    const outcome = determineOutcome(status, files);

    // Compact readable timestamp
    const dateStr = new Date().toISOString().slice(0, 16).replace("T", " ");

    // Summary: prefer taskContext, fall back to last commit message
    let summary = taskContext || "";
    if (!summary && lastCommit && lastCommit !== "(unavailable)") {
      summary = lastCommit.replace(/^\w+\s+/, ""); // strip hash prefix
    }
    if (!summary) {
      summary = topics.length
        ? `Work on: ${topics.join(", ")}`
        : "Session ended";
    }

    // Build entry block
    const lines = [
      `## ${dateStr} | ${branch || "unknown"}`,
      topics.length ? `**Topics**: ${topics.join(", ")}` : null,
      `**Files**: ${formatFiles(files)}`,
      `**Summary**: ${summary.slice(0, 120)}`,
      `**Status**: ${outcome}`,
    ];
    const entry = lines.filter(Boolean).join("\n");

    // Read existing diary or create header
    let existing = "";
    if (existsSync(diaryPath)) {
      existing = readFileSync(diaryPath, "utf8");
    }
    if (!existing.includes("# Session Diary")) {
      existing = `# Session Diary\n\n<!-- Auto-generated episodic memory. Last ${MAX_ENTRIES} sessions. -->\n`;
    }

    // Append new entry
    const updated = existing.trimEnd() + "\n\n" + entry + "\n";

    // Enforce MAX_ENTRIES cap
    const parts = updated.split(/^## /m);
    const header = parts[0]; // "# Session Diary..." header
    const sessions = parts.slice(1);

    if (sessions.length > MAX_ENTRIES) {
      const kept = sessions.slice(sessions.length - MAX_ENTRIES);
      const trimmed =
        header.trimEnd() + "\n\n" + kept.map((e) => `## ${e}`).join("\n");
      writeFileSync(diaryPath, trimmed, "utf8");
    } else {
      writeFileSync(diaryPath, updated, "utf8");
    }
  } catch {
    /* non-critical — fail silently */
  }
}

/**
 * Read last N diary entries for session-start injection.
 * @param {string} memoryDir - path to .project-brain/memory/
 * @param {number} [count=3] - number of recent entries to return
 * @returns {string} formatted markdown lines, or empty string
 */
export function recallDiary(memoryDir, count = RECALL_COUNT) {
  try {
    const diaryPath = join(memoryDir, DIARY_FILE);
    if (!existsSync(diaryPath)) return "";

    const raw = readFileSync(diaryPath, "utf8");
    const entries = raw.split(/^## /m).filter(Boolean).slice(1); // skip header
    if (entries.length === 0) return "";

    const recent = entries.slice(-count);
    return recent
      .map((e) => {
        const header = e.split("\n")[0]?.trim() || "unknown";
        const summary = extractSummaryFromEntry(e);
        return `- **${header}**: ${summary}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}
