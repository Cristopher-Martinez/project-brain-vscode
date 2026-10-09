/**
 * invariant-gate.mjs — Hook-side invariant deletion protection.
 *
 * Runs in PostToolUse hooks (ESM). Checks git diff for @invariant tag
 * removals and warns/blocks accordingly.
 *
 * Cannot import TypeScript modules — reads INVARIANTS.md and git diff directly.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getLoopsDir } from "./brain-paths.mjs";

const INVARIANTS_FILE = "INVARIANTS.md";
const HISTORY_FILE = "invariant-history.json";

/**
 * Parse invariant IDs from INVARIANTS.md.
 * @param {string} cwd Workspace root
 * @returns {Set<string>} Set of invariant IDs
 */
export function readInvariantIds(cwd) {
  const filePath = join(cwd, INVARIANTS_FILE);
  if (!existsSync(filePath)) {
    return new Set();
  }
  const content = readFileSync(filePath, "utf-8");
  const ids = new Set();
  for (const line of content.split("\n")) {
    const match = line.match(/^- `([a-z0-9][a-z0-9_-]*)` —/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Detect invariant deletions by comparing committed INVARIANTS.md IDs vs current.
 * Uses ID-set comparison (immune to formatting/reordering changes).
 * @param {string} cwd Workspace root
 * @returns {{ deleted: string[], hasJustification: boolean }}
 */
export function detectInvariantDeletions(cwd) {
  const result = { deleted: [], hasJustification: false };

  try {
    // Check if INVARIANTS.md is tracked by git
    const tracked = execFileSync("git", ["ls-files", INVARIANTS_FILE], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!tracked) {
      return result;
    }

    // Get committed version of INVARIANTS.md
    let committedContent;
    try {
      committedContent = execFileSync(
        "git",
        ["show", `HEAD:${INVARIANTS_FILE}`],
        { cwd, encoding: "utf-8", timeout: 5000 },
      );
    } catch {
      return result; // File not in HEAD yet (first commit)
    }

    // Extract IDs from committed version
    const committedIds = new Set();
    for (const line of committedContent.split("\n")) {
      const match = line.match(/^- `([a-z0-9][a-z0-9_-]*)` —/);
      if (match) {
        committedIds.add(match[1]);
      }
    }

    // Extract IDs from current working tree version
    const currentIds = readInvariantIds(cwd);

    // Find IDs that were in committed but not in current
    for (const id of committedIds) {
      if (!currentIds.has(id)) {
        result.deleted.push(id);
      }
    }

    // Check if latest commit message has justification
    if (result.deleted.length > 0) {
      try {
        const commitMsg = execFileSync("git", ["log", "-1", "--format=%B"], {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        result.hasJustification =
          commitMsg.toLowerCase().includes("invariant") &&
          (commitMsg.includes("remove") ||
            commitMsg.includes("delete") ||
            commitMsg.includes("deprecate"));
      } catch {
        // Not critical
      }
    }
  } catch {
    // Git not available or not a git repo — skip
  }

  return result;
}

/**
 * Log invariant deletion to history file.
 * @param {string} cwd Workspace root
 * @param {string[]} deletedIds IDs that were deleted
 * @param {string} [justification] Optional justification
 */
export function logInvariantDeletion(cwd, deletedIds, justification) {
  const histPath = join(getLoopsDir(cwd), HISTORY_FILE);
  let history = [];

  try {
    if (existsSync(histPath)) {
      history = JSON.parse(readFileSync(histPath, "utf-8"));
    }
  } catch {
    history = [];
  }

  for (const id of deletedIds) {
    history.push({
      action: "deleted",
      invariantId: id,
      timestamp: new Date().toISOString(),
      justification: justification || "no justification provided",
    });
  }

  const dir = dirname(histPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(histPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Run invariant gate check. Returns a gate result.
 * @param {string} cwd Workspace root
 * @returns {{ pass: boolean, message: string, deletedIds: string[] }}
 */
export function checkInvariantGate(cwd) {
  const deletions = detectInvariantDeletions(cwd);

  if (deletions.deleted.length === 0) {
    return { pass: true, message: "", deletedIds: [] };
  }

  // Log the deletions
  logInvariantDeletion(cwd, deletions.deleted);

  if (deletions.hasJustification) {
    return {
      pass: true,
      message: `⚠️ Invariantes eliminadas con justificación: ${deletions.deleted.join(", ")}`,
      deletedIds: deletions.deleted,
    };
  }

  return {
    pass: false,
    message:
      `⛔ INVARIANT DELETION DETECTED: ${deletions.deleted.join(", ")}\n` +
      `Eliminar invariantes requiere justificación en el commit message.\n` +
      `Incluye "remove invariant" o "delete invariant" en tu próximo commit.`,
    deletedIds: deletions.deleted,
  };
}
