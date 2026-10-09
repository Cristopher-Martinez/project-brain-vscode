/**
 * Fork Helpers — Persistence, cleanup, and utility operations for fork isolation.
 *
 * Equivalent of branch-isolation-helpers.ts but for the fork-based architecture.
 * Handles state serialization to `.brain-forks/state.json`, orphan cleanup,
 * and round context generation.
 *
 * @module fork-helpers
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError, logWarn } from "./logger";
import {
  createGitInstance,
  disposeFork,
  generateForkId,
  getForkPath,
  isBrainFork,
} from "./fork-core";
import {
  FORK_BASE_DIR,
  FORK_COMPLETED_TTL_MS,
  FORK_RESERVED_DIRS,
  FORK_STATE_FILE,
  type ForkIsolationInfo,
  type ForkStatus,
} from "./fork-types";

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Persist the fork isolation map to `.brain-forks/state.json`.
 * Call after every forkMap mutation.
 */
export function persistForkState(
  repoRoot: string,
  forkMap: Map<string, ForkIsolationInfo>,
): void {
  try {
    const baseDir = path.join(repoRoot, FORK_BASE_DIR);
    fs.mkdirSync(baseDir, { recursive: true });

    const serializable: Record<string, ForkIsolationInfo> = {};
    for (const [key, val] of forkMap) {
      serializable[key] = val;
    }

    const filePath = path.join(baseDir, FORK_STATE_FILE);
    fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf-8");
    log(`[ForkHelpers] State persisted: ${forkMap.size} forks`);
  } catch (err) {
    logError(`[ForkHelpers] persistForkState FAILED: ${err}`);
  }
}

/**
 * Restore fork state from disk on activation.
 * @returns Number of sessions restored.
 */
export function restoreForkState(
  repoRoot: string,
  forkMap: Map<string, ForkIsolationInfo>,
): number {
  try {
    const filePath = path.join(repoRoot, FORK_BASE_DIR, FORK_STATE_FILE);
    if (!fs.existsSync(filePath)) return 0;

    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, ForkIsolationInfo>;

    let count = 0;
    for (const [key, val] of Object.entries(data)) {
      // Skip entries with forkPaths that no longer exist on disk
      if (val.forkPath && !fs.existsSync(val.forkPath)) {
        logWarn(
          `[ForkHelpers] Skipping restored session ${key} — fork path gone: ${val.forkPath}`,
        );
        continue;
      }
      forkMap.set(key, val);
      count++;
    }

    log(`[ForkHelpers] State restored: ${count} forks from disk`);
    return count;
  } catch (err) {
    logError(`[ForkHelpers] restoreForkState FAILED: ${err}`);
    return 0;
  }
}

// ─── Orphan Cleanup ─────────────────────────────────────────────────────────

/**
 * Clean up orphan fork directories that aren't tracked in the state map.
 * A fork is orphan if:
 * 1. Its directory exists in .brain-forks/ but isn't in the forkMap
 * 2. It has brain.fork=true config (avoids deleting user-created directories)
 *
 * @returns Count of orphan forks removed.
 */
export async function cleanupOrphanForks(
  repoRoot: string,
  forkMap: Map<string, ForkIsolationInfo>,
): Promise<number> {
  const baseDir = path.join(repoRoot, FORK_BASE_DIR);

  if (!fs.existsSync(baseDir)) return 0;

  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  const trackedPaths = new Set(
    Array.from(forkMap.values()).map((info) => path.normalize(info.forkPath)),
  );

  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (FORK_RESERVED_DIRS.has(entry.name)) continue;
    if (entry.name === FORK_STATE_FILE) continue;

    const fullPath = path.normalize(path.join(baseDir, entry.name));
    if (trackedPaths.has(fullPath)) continue;

    // Verify it's actually a brain fork before deleting
    const isOrphan = await isBrainFork(fullPath);
    if (!isOrphan) {
      logWarn(
        `[ForkHelpers] Skipping non-brain directory in forks base: ${entry.name}`,
      );
      continue;
    }

    try {
      log(`[ForkHelpers] Cleaning orphan fork: ${entry.name}`);
      await disposeFork(fullPath, { force: true });
      cleaned++;
    } catch (err) {
      logError(
        `[ForkHelpers] Failed to clean orphan fork ${entry.name}: ${err}`,
      );
    }
  }

  if (cleaned > 0) {
    log(`[ForkHelpers] Cleaned ${cleaned} orphan fork(s)`);
  }
  return cleaned;
}

// ─── TTL Cleanup ────────────────────────────────────────────────────────────

/**
 * Remove forks that completed/merged/discarded longer than FORK_COMPLETED_TTL_MS ago.
 * Should run on extension activation alongside cleanupOrphanForks.
 *
 * @returns Array of sessionIds that were cleaned up.
 */
export async function cleanupStaleForks(
  forkMap: Map<string, ForkIsolationInfo>,
): Promise<string[]> {
  const now = Date.now();
  const terminal: ForkStatus[] = ["completed", "merged", "discarded"];
  const cleaned: string[] = [];

  for (const [sessionId, info] of forkMap) {
    if (!terminal.includes(info.status)) continue;
    const age = now - info.createdAt;
    if (age < FORK_COMPLETED_TTL_MS) continue;

    try {
      if (fs.existsSync(info.forkPath)) {
        log(`[ForkHelpers] TTL cleanup: ${info.forkPath} (age: ${Math.floor(age / 86_400_000)}d)`);
        await disposeFork(info.forkPath, { force: true });
      }
      forkMap.delete(sessionId);
      cleaned.push(sessionId);
    } catch (err) {
      logError(`[ForkHelpers] TTL cleanup failed for ${sessionId}: ${err}`);
    }
  }

  if (cleaned.length > 0) {
    log(`[ForkHelpers] TTL-cleaned ${cleaned.length} stale fork(s)`);
  }
  return cleaned;
}

// ─── Round Context ──────────────────────────────────────────────────────────

/**
 * Generate context about the current fork for LLM round injections.
 * Includes diff stats and branch drift for round-by-round awareness.
 */
export async function getForkRoundContext(
  info: ForkIsolationInfo | undefined,
): Promise<string> {
  if (!info || info.status !== "active") return "";

  const parts: string[] = [];
  const cwd = info.forkPath || info.repoRoot;

  // Diff stat: accumulated changes in this fork branch
  try {
    const git = createGitInstance(cwd);
    const diffStat = await git.raw([
      "diff",
      "--stat",
      `${info.originalBranch}...${info.branchName}`,
    ]);
    if (diffStat.trim()) {
      parts.push(
        `📊 **Cambios acumulados:**\n\`\`\`\n${diffStat.trim()}\n\`\`\``,
      );
    }
  } catch {
    /* non-fatal — branch may not have diverged */
  }

  // Branch drift: how far behind the original branch
  try {
    const git = createGitInstance(cwd);
    const behind = await git.raw([
      "rev-list",
      "--count",
      `${info.branchName}..${info.originalBranch}`,
    ]);
    const behindNum = parseInt(behind.trim(), 10);
    if (behindNum > 0) {
      const urgency = behindNum > 10 ? "⚠️" : "📏";
      parts.push(
        `${urgency} **Branch drift:** ${behindNum} commit(s) detrás de \`${info.originalBranch}\`` +
          (behindNum > 10
            ? " — considera finalizar pronto para evitar conflictos."
            : ""),
      );
    }
  } catch {
    /* non-fatal */
  }

  // Static fork context
  parts.push(
    `🔱 **Fork**: \`${info.forkPath}\` | Branch: \`${info.branchName}\` | Strategy: ${info.cloneStrategy}`,
  );

  return parts.length > 0 ? `\n${parts.join("\n")}\n` : "";
}

/**
 * Generate a summary of known fork limitations for LLM context.
 */
export function getForkLimitations(): string {
  return [
    "## Fork Isolation — What You Should Know",
    "- The fork is a separate git clone of the user's repo",
    "- node_modules is symlinked from the original repo (junction on Windows)",
    "- Do NOT run `npm install` in the fork — use the existing node_modules",
    "- Do NOT push from the fork — pushurl is blocked for safety",
    "- When done, changes are absorbed via `git fetch` + `git merge`",
    "- If you need to see original repo state, read from the `repoRoot` path",
  ].join("\n");
}

// ─── Known Issues ───────────────────────────────────────────────────────────

/**
 * Generate hints about known fork issues for LLM awareness.
 * Helps the agent avoid common pitfalls.
 */
export function getKnownForkIssuesHint(
  info: ForkIsolationInfo | undefined,
): string {
  if (!info) return "";
  const hints: string[] = [];

  if (info.cloneStrategy === "shared") {
    hints.push(
      "⚠️ This fork uses --shared clone (git alternates). " +
        "Do NOT run `git gc` or `git repack` — it could break object references.",
    );
  }

  if (process.platform === "win32") {
    hints.push(
      "⚠️ Windows: If file operations fail with EPERM/EBUSY, " +
        "a background process may be locking files. Wait and retry.",
    );
  }

  return hints.length > 0 ? hints.join("\n") : "";
}

/**
 * Validate that a fork directory ID would result in a safe path length.
 * Returns true if the resulting path is under the OS limit.
 */
export function validateForkPathLength(
  repoRoot: string,
  forkId: string,
): boolean {
  const estimatedPath = getForkPath(repoRoot, forkId);
  // Windows MAX_PATH is 260 chars; leave room for files inside the fork
  const maxSafe = process.platform === "win32" ? 200 : 4000;
  return estimatedPath.length < maxSafe;
}
