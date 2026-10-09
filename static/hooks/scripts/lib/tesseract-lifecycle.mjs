/**
 * Tesseract Lifecycle — Auto-summary, incremental promotion, read→edit correlation.
 * Single entry point: runLifecycle(). Keeps post-tool-capture.mjs lean.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getPromotableNotes, markPromoted, writeNote } from "./temporal-mailbox.mjs";

const SUMMARY_EVERY = 10;
const PROMOTE_EVERY = 50;
const MAX_READS = 20;
const CORRELATION_WINDOW = 120_000; // 2 min

/**
 * Single entry point — call once per PostToolUse.
 * @param {{ sessionsDir: string, memDir: string, callCount: number, toolName: string, toolInput: object }} ctx
 */
export function runLifecycle({ sessionsDir, memDir, callCount, toolName, toolInput }) {
  try { autoSummarize(sessionsDir, callCount); } catch { /* */ }
  try { promote(sessionsDir, memDir, callCount); } catch { /* */ }
  try { trackReadsAndCorrelate(sessionsDir, toolName, toolInput); } catch { /* */ }
}

function autoSummarize(sessionsDir, callCount) {
  if (!callCount || callCount % SUMMARY_EVERY !== 0) return;
  const buf = join(sessionsDir, "capture-buffer.jsonl");
  if (!existsSync(buf)) return;

  const lines = readFileSync(buf, "utf8").trim().split("\n").filter(Boolean).slice(-SUMMARY_EVERY);
  if (lines.length < 3) return;

  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = {}, files = new Set();
  for (const e of entries) {
    tools[e.tool || "?"] = (tools[e.tool || "?"] || 0) + 1;
    ((e.text || "").match(/[\w.-]+\.(ts|mjs|js|md|json)/g) || []).forEach((f) => files.add(f));
  }

  const toolStr = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t}×${c}`).join(", ");
  const fileStr = [...files].slice(0, 5).join(", ");
  writeNote(sessionsDir, `Resumen calls ${callCount - SUMMARY_EVERY + 1}-${callCount}: ${toolStr}${fileStr ? ` | ${fileStr}` : ""}`, 0.45, [...files].slice(0, 5));
}

function promote(sessionsDir, memDir, callCount) {
  if (!callCount || callCount % PROMOTE_EVERY !== 0) return;
  const { promotable } = getPromotableNotes(sessionsDir);
  if (!promotable.length) return;

  const opinionsPath = join(memDir, "14_OPINIONS.md");
  if (!existsSync(opinionsPath)) return;

  const date = new Date().toISOString().slice(0, 10);
  const block = promotable.map((n) =>
    `\n### [auto-promoted] ${n.text.slice(0, 80)}\n- **Confidence**: ${(n.importance * 100).toFixed(0)}%\n- **Source**: Temporal (${date})\n- **Hits**: ${n.hits}\n`
  ).join("");

  appendFileSync(opinionsPath, block, "utf8");
  markPromoted(sessionsDir, promotable.map((n) => n.id));
}

const READ_TOOLS = new Set(["read_file", "grep_search", "semantic_search", "file_search"]);
const EDIT_TOOLS = new Set(["replace_string_in_file", "multi_replace_string_in_file", "create_file"]);

function trackReadsAndCorrelate(sessionsDir, toolName, toolInput) {
  const tracker = join(sessionsDir, "read-tracker.jsonl");

  if (READ_TOOLS.has(toolName)) {
    const raw = toolInput.filePath || toolInput.path || toolInput.query || "";
    const basename = raw.split(/[\\/]/).pop() || "";
    if (!basename) return;
    appendFileSync(tracker, JSON.stringify({ file: basename, ts: Date.now() }) + "\n", "utf8");
    if (existsSync(tracker)) {
      const all = readFileSync(tracker, "utf8").trim().split("\n").filter(Boolean);
      if (all.length > MAX_READS) writeFileSync(tracker, all.slice(-MAX_READS).join("\n") + "\n", "utf8");
    }
    return;
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (!existsSync(tracker)) return;
    const edited = toolName === "multi_replace_string_in_file"
      ? (toolInput.replacements || []).map((r) => (r.filePath || "").split(/[\\/]/).pop()).filter(Boolean)
      : [(toolInput.filePath || "").split(/[\\/]/).pop()].filter(Boolean);
    if (!edited.length) return;

    const now = Date.now();
    const reads = readFileSync(tracker, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((r) => (now - r.ts) < CORRELATION_WINDOW);

    const editSet = new Set(edited);
    const uniqueReads = [...new Set(reads.map((r) => r.file))].filter((r) => !editSet.has(r)).slice(0, 3);
    if (!uniqueReads.length) return;

    writeNote(sessionsDir, `Read→Edit: ${uniqueReads.join(", ")} → ${edited.slice(0, 3).join(", ")}`, 0.4, [...uniqueReads, ...edited].slice(0, 5));
  }
}
