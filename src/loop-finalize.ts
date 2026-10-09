/**
 * Loop Finalize — Persist completed loop sessions for archival.
 *
 * When a user manually finalizes a loop, its metadata is saved to disk
 * so it appears in the "Finalizados" tab of Brain HQ. Users can later
 * reconnect (re-launch) a finalized loop with the same goal.
 *
 * Storage: `.project-brain/loops/finalized/{sessionId}.json`
 */

import * as fs from "fs";
import * as path from "path";
import { getFinalizedDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FinalizedLoop {
  sessionId: string;
  goal: string;
  totalRounds: number;
  branchName?: string;
  finalizedAt: number;
  summary: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Finalized loops older than 90 days are auto-pruned. */
const FINALIZED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function finalizeDir(repoRoot: string): string {
  return getFinalizedDir(repoRoot);
}

function finalizePath(repoRoot: string, sessionId: string): string {
  return path.join(finalizeDir(repoRoot), `${sessionId}.json`);
}

// ─── Finalize ───────────────────────────────────────────────────────────────

export function saveFinalized(
  repoRoot: string,
  data: FinalizedLoop,
): boolean {
  try {
    fs.mkdirSync(finalizeDir(repoRoot), { recursive: true });
    fs.writeFileSync(
      finalizePath(repoRoot, data.sessionId),
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    log(
      `[Finalize] Saved finalized loop: ${data.sessionId.substring(0, 8)} — "${(data.goal || "").substring(0, 40)}"`,
    );
    return true;
  } catch (err) {
    logError(`[Finalize] Failed to save: ${err}`);
    return false;
  }
}

// ─── List ───────────────────────────────────────────────────────────────────

export function listFinalizedLoops(repoRoot: string): FinalizedLoop[] {
  const dir = finalizeDir(repoRoot);
  if (!fs.existsSync(dir)) return [];

  const results: FinalizedLoop[] = [];
  const now = Date.now();

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const snapshot = JSON.parse(raw) as FinalizedLoop;

        if (now - snapshot.finalizedAt > FINALIZED_TTL_MS) {
          fs.unlinkSync(path.join(dir, file));
          log(
            `[Finalize] Pruned old finalized session: ${snapshot.sessionId.substring(0, 8)}`,
          );
          continue;
        }

        results.push(snapshot);
      } catch {
        /* skip malformed files */
      }
    }
  } catch (err) {
    logWarn(`[Finalize] Failed to list: ${err}`);
  }

  return results.sort((a, b) => b.finalizedAt - a.finalizedAt);
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export function deleteFinalizedLoop(
  repoRoot: string,
  sessionId: string,
): boolean {
  const fp = finalizePath(repoRoot, sessionId);
  if (!fs.existsSync(fp)) return false;

  try {
    fs.unlinkSync(fp);
    log(`[Finalize] Deleted finalized session: ${sessionId.substring(0, 8)}`);
    return true;
  } catch (err) {
    logError(`[Finalize] Failed to delete: ${err}`);
    return false;
  }
}
