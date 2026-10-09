/**
 * invariants-queries.ts — Invariant query & history helpers.
 *
 * Extracted from invariants-manager.ts to stay under the 400-line limit.
 * Provides history read/append and module-level invariant queries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getLoopsDir } from "./brain-paths";
import { readInvariantsDoc } from "./invariants-manager";
import type {
  InvariantHistoryEntry,
  InvariantRecord,
} from "./test-pipeline-types";

const HISTORY_FILE = "invariant-history.json";

// ─── History I/O ─────────────────────────────────────────────

export function readHistory(wsRoot: string): InvariantHistoryEntry[] {
  const histPath = join(getLoopsDir(wsRoot), HISTORY_FILE);
  if (!existsSync(histPath)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(histPath, "utf-8"));
  } catch {
    return [];
  }
}

export function appendHistory(
  wsRoot: string,
  entry: InvariantHistoryEntry,
): void {
  const history = readHistory(wsRoot);
  history.push(entry);
  const dir = dirname(join(getLoopsDir(wsRoot), HISTORY_FILE));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(getLoopsDir(wsRoot), HISTORY_FILE),
    JSON.stringify(history, null, 2),
    "utf-8",
  );
}

// ─── Query Functions ─────────────────────────────────────────

/**
 * Get invariant records for a specific module path.
 * Used by gates to check if a core module has invariant coverage.
 */
export function getInvariantsForModule(
  wsRoot: string,
  modulePath: string,
): InvariantRecord[] {
  const records = readInvariantsDoc(wsRoot);
  const base = dirname(modulePath);
  return records.filter((r) =>
    r.files.some((f) => f.startsWith(base) || f.includes(base)),
  );
}

/**
 * Check if any invariants were deleted without justification.
 * Called by hooks to enforce deletion protection.
 */
export function getRecentDeletions(wsRoot: string): InvariantHistoryEntry[] {
  const history = readHistory(wsRoot);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return history.filter(
    (h) =>
      h.action === "deleted" && new Date(h.timestamp).getTime() > oneHourAgo,
  );
}
