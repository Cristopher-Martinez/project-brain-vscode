/**
 * Loop Mailbox Archive — persists cleared messages instead of deleting them.
 *
 * When a session ends and its messages are cleared from the active mailbox,
 * they are moved here for historical reference. Keeps last 500 entries.
 */

import * as fs from "fs";
import * as path from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logError } from "./logger";
import type { LoopMessage } from "./loop-mailbox";

// ——— Constants ———————————————————————————————————————
// Archive dir resolved via brain-paths.
const ARCHIVE_FILE = "mailbox-archive.json";
const MAX_ARCHIVED = 500;

// ——— Helpers ——————————————————————————————————————————

function archivePath(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), ARCHIVE_FILE);
}

function readArchive(repoRoot: string): LoopMessage[] {
  const fp = archivePath(repoRoot);
  try {
    const raw = fs.readFileSync(fp, "utf8");
    return JSON.parse(raw) as LoopMessage[];
  } catch {
    return [];
  }
}

function writeArchive(repoRoot: string, messages: LoopMessage[]): void {
  const fp = archivePath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(messages, null, 2), "utf8");
}

// ——— Public API ———————————————————————————————————————

/**
 * Move messages to the archive file (`.project-brain/loops/mailbox-archive.json`).
 * Capped at MAX_ARCHIVED entries, oldest are dropped.
 */
export function archiveMessages(
  repoRoot: string,
  messages: LoopMessage[],
): void {
  if (messages.length === 0) return;

  try {
    const existing = readArchive(repoRoot);
    const merged = [...existing, ...messages];
    const trimmed =
      merged.length > MAX_ARCHIVED ? merged.slice(-MAX_ARCHIVED) : merged;
    writeArchive(repoRoot, trimmed);
    log(
      `[MailboxArchive] Archived ${messages.length} message(s) (total: ${trimmed.length})`,
    );
  } catch (err) {
    logError(`[MailboxArchive] Failed to archive: ${err}`);
  }
}

/**
 * Read archived messages (for debugging/inspection).
 */
export function getArchivedMessages(repoRoot: string): LoopMessage[] {
  return readArchive(repoRoot);
}
