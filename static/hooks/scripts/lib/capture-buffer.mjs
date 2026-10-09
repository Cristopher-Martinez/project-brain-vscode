/**
 * Capture Buffer — Accumulate & process learning captures in agent mode.
 * Two-phase design:
 *   1. ACCUMULATE (PostToolUse): `appendCapture()` writes text snippets
 *      from tool explanations/syntheses to a JSONL buffer file.
 *   2. PROCESS (Stop): `processCaptureBuffer()` scans the buffer for
 *      the 12 capture patterns, deduplicates, and appends to 04_LEARNINGS.md.
 * This bridges the gap where Auto-Capture (src/auto-capture.ts) only runs
 * via @brain chat participant, leaving agent mode without learning capture.
 * Buffer file: .project-brain/memory/sessions/capture-buffer.jsonl
 * Format: one JSON object per line { tool, text, ts }
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { scanForCaptures } from "./capture-patterns.mjs";
import { sanitizeContent } from "./sanitize.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max entries in the buffer before auto-truncating oldest. */
const MAX_BUFFER_ENTRIES = 40;

/** Max learnings to extract per session. */
const MAX_LEARNINGS_PER_SESSION = 5;

/** Tools whose input text is worth scanning for learnings. */
const CAPTURE_TOOLS = new Set([
  "replace_string_in_file",
  "multi_replace_string_in_file",
  "create_file",
  "run_in_terminal",
  "edit_notebook_file",
  "runSubagent",
]);

// ─── Accumulation (called from PostToolUse) ──────────────────────────────────

/**
 * Append a text snippet to the capture buffer.
 * Called from PostToolUse for tools that carry agent reasoning.
 * @param {string} cwd - workspace root
 * @param {string} toolName - name of the tool
 * @param {object} toolInput - the tool's input parameters
 */
export function appendCapture(cwd, toolName, toolInput) {
  try {
    const texts = extractCaptureText(toolName, toolInput);
    if (texts.length === 0) return;

    const bufferPath = getBufferPath(cwd);
    ensureSessionsDir(cwd);

    // Rate-limit: check current buffer size
    const existing = readBufferLines(bufferPath);
    if (existing.length >= MAX_BUFFER_ENTRIES) return; // cap reached

    const entries = texts.map((text) =>
      JSON.stringify({
        tool: toolName,
        text: sanitizeContent(text).substring(0, 500),
        ts: Date.now(),
      }),
    );

    appendFileSync(bufferPath, entries.join("\n") + "\n", "utf8");
  } catch {
    /* non-critical — fail silently */
  }
}

/**
 * Extract capturable text fragments from tool input.
 * Returns text that contains agent reasoning, not raw file contents.
 */
function extractCaptureText(toolName, toolInput) {
  if (!toolInput) return [];
  const texts = [];

  // Tool explanation fields (agent reasoning about what they're doing)
  if (CAPTURE_TOOLS.has(toolName)) {
    const explanation = toolInput.explanation || toolInput.goal || "";
    if (explanation.length > 20) {
      texts.push(explanation);
    }
    // runSubagent carries reasoning in prompt/description
    const prompt = toolInput.prompt || "";
    if (prompt.length > 50) {
      texts.push(prompt.substring(0, 500));
    }
  }

  // loopAwaitInput synthesis (rich agent responses)
  if (toolName === "projectBrain_toolbox") {
    const synthesis = toolInput.synthesis || "";
    if (synthesis.length > 50) {
      texts.push(synthesis);
    }
  }

  return texts;
}

// ─── Processing (called from Stop hook) ──────────────────────────────────────

/**
 * Process the capture buffer: scan for patterns, write to 04_LEARNINGS.md.
 * Called once at session end from session-stop.mjs.
 * @param {string} memoryDir - path to .project-brain/memory/
 * @returns {{ captured: number, total: number }} stats
 */
export function processCaptureBuffer(memoryDir) {
  const bufferPath = join(memoryDir, "sessions", "capture-buffer.jsonl");
  if (!existsSync(bufferPath)) return { captured: 0, total: 0 };

  try {
    const lines = readBufferLines(bufferPath);
    if (lines.length === 0) {
      safeDelete(bufferPath);
      return { captured: 0, total: 0 };
    }

    // Combine all text for scanning
    const allText = lines
      .map((entry) => entry.text || "")
      .filter((t) => t.length > 20)
      .join("\n\n");

    // Scan for capture patterns
    const captures = scanForCaptures(allText);

    // Deduplicate against existing learnings
    const learningsPath = join(memoryDir, "04_LEARNINGS.md");
    const existingLearnings = existsSync(learningsPath)
      ? readFileSync(learningsPath, "utf8").toLowerCase()
      : "";

    const novel = captures.filter((c) => {
      const key = c.statement.toLowerCase().substring(0, 60);
      return !existingLearnings.includes(key);
    });

    // Limit per session
    const toWrite = novel.slice(0, MAX_LEARNINGS_PER_SESSION);

    if (toWrite.length > 0) {
      const now = new Date().toISOString().slice(0, 16);
      const section =
        `\n## Auto-Capture (Agent Mode) — ${now}\n\n` +
        toWrite
          .map(
            (c) =>
              `- **[${c.domain}]** (c=${c.confidence.toFixed(2)}) ${c.statement}`,
          )
          .join("\n") +
        "\n";

      appendFileSync(learningsPath, section, "utf8");
    }

    // Clean up buffer
    safeDelete(bufferPath);

    return { captured: toWrite.length, total: lines.length };
  } catch {
    safeDelete(bufferPath);
    return { captured: 0, total: 0 };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBufferPath(cwd) {
  return join(cwd, "docs", "memory", "sessions", "capture-buffer.jsonl");
}

function ensureSessionsDir(cwd) {
  const dir = join(cwd, "docs", "memory", "sessions");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readBufferLines(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function safeDelete(path) {
  try {
    unlinkSync(path);
  } catch {
    
  }
}
