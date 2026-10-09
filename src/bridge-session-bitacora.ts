/**
 * bridge-session-bitacora — Rolling session journal for PM context.
 *
 * Captures key decisions, corrections, and constraints across the
 * entire session, surviving beyond the 20-message sliding window.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";
import { getLoopDir } from "./brain-paths";
import type {
  SessionBitacora,
  BitacoraEntry,
  BitacoraEntryType,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";

const BITACORA_FILENAME = "bitacora.json";
const DEFAULT_MAX_CHARS = 1500;
const MAX_ENTRY_TEXT = 200;

// —— Factory ———————————————————————————————

export function createBitacora(sessionId: string): SessionBitacora {
  return { sessionId, entries: [], maxChars: DEFAULT_MAX_CHARS, updatedAt: Date.now() };
}

// —— Persistence ——————————————————————————

export function loadBitacora(repoRoot: string, sessionId: string): SessionBitacora | null {
  const filePath = path.join(getLoopDir(repoRoot, sessionId), BITACORA_FILENAME);
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionBitacora;
  } catch (err) {
    logWarn(`[Bitacora] Failed to load: ${err}`);
    return null;
  }
}

export function saveBitacora(repoRoot: string, bitacora: SessionBitacora): boolean {
  const loopDir = getLoopDir(repoRoot, bitacora.sessionId);
  const filePath = path.join(loopDir, BITACORA_FILENAME);
  try {
    if (!fs.existsSync(loopDir)) { fs.mkdirSync(loopDir, { recursive: true }); }
    bitacora.updatedAt = Date.now();
    fs.writeFileSync(filePath, JSON.stringify(bitacora, null, 2), "utf-8");
    return true;
  } catch (err) {
    logWarn(`[Bitacora] Failed to save: ${err}`);
    return false;
  }
}

// —— Entry Extraction ———————————————————————

/**
 * Extract bitacora entries from a PM suggestion.
 * Rule-based: checks suggestion type and content for key patterns.
 */
export function extractBitacoraEntries(
  suggestion: PmSuggestionResult,
  turn: number,
): BitacoraEntry[] {
  const entries: BitacoraEntry[] = [];
  const now = Date.now();

  // Decision entries from approved/rejected patterns
  const rec = suggestion.recommendation || "";
  if (rec.toLowerCase().includes("aprobad") || rec.toLowerCase().includes("approved")) {
    entries.push({ turn, timestamp: now, type: "decision", text: truncText(rec) });
  }
  if (rec.toLowerCase().includes("rechaz") || rec.toLowerCase().includes("rejected")) {
    entries.push({ turn, timestamp: now, type: "decision", text: truncText("Rejected: " + rec) });
  }

  // Constraint entries from warning/blocker patterns
  if (rec.toLowerCase().includes("constraint") || rec.toLowerCase().includes("restricci")) {
    entries.push({ turn, timestamp: now, type: "constraint", text: truncText(rec) });
  }

  // Context entry every 5th turn as a general summary
  if (turn > 0 && turn % 5 === 0) {
    entries.push({
      turn, timestamp: now, type: "context",
      text: truncText(`Turn ${turn}: ${rec.slice(0, 150)}`),
    });
  }

  return entries;
}

// —— Append & Trim —————————————————————————

export function appendBitacoraEntries(
  bitacora: SessionBitacora,
  entries: BitacoraEntry[],
): SessionBitacora {
  if (entries.length === 0) { return bitacora; }
  const updated = { ...bitacora, entries: [...bitacora.entries, ...entries], updatedAt: Date.now() };
  return trimBitacora(updated);
}

/** Remove oldest entries until total char budget is respected. */
function trimBitacora(bitacora: SessionBitacora): SessionBitacora {
  let totalChars = bitacora.entries.reduce((sum, e) => sum + e.text.length, 0);
  const trimmed = [...bitacora.entries];
  while (totalChars > bitacora.maxChars && trimmed.length > 1) {
    const removed = trimmed.shift()!;
    totalChars -= removed.text.length;
  }
  return { ...bitacora, entries: trimmed };
}

// —— Context Formatting ——————————————————————

/** Format bitacora entries for injection into PM context. */
export function formatBitacoraForContext(bitacora: SessionBitacora, maxChars: number): string {
  if (bitacora.entries.length === 0) { return ""; }
  const lines: string[] = ["## Session Log"];
  let chars = lines[0].length;
  for (const e of bitacora.entries) {
    const line = `- [${e.type}] T${e.turn}: ${e.text}`;
    if (chars + line.length + 1 > maxChars) { break; }
    lines.push(line);
    chars += line.length + 1;
  }
  log(`[Bitacora] Formatted ${lines.length - 1} entries (${chars} chars)`);
  return lines.join("\n");
}

// —— Helpers ————————————————————————————

function truncText(text: string): string {
  if (text.length <= MAX_ENTRY_TEXT) { return text; }
  return text.slice(0, MAX_ENTRY_TEXT - 3) + "...";
}
