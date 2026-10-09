/**
 * commit-session-ops.ts — Session-level commit operations.
 *
 * Contains squash digest generation, checkpoint tagging,
 * and commit state persistence for loop sessions.
 */

import { execFileSync } from "child_process";
import { getLoopDir } from "./brain-paths";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface CommitState {
  editedSinceCommit: string[];
  lastCommitTs: number;
  lastSuggestionTs: number | null;
  commitCount: number;
  suppressUntilFeedback: boolean;
  lastCommitHash?: string;
  /** When true, commit-gate allows synthesis without requiring commits */
  commitBypass?: boolean;
}

// ═══════════════════════════════════════════════════════
// Git helper
// ═══════════════════════════════════════════════════════

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}

// ═══════════════════════════════════════════════════════
// Squash digest (#5)
// ═══════════════════════════════════════════════════════

/**
 * Generate a squash digest from all session commits.
 * Reads git log for commits containing the session ID,
 * extracts their messages, and builds a comprehensive summary.
 */
export function buildSquashDigest(cwd: string, sessionId: string): string {
  try {
    // Use record separator (\x1e) to avoid conflicts with | in commit subjects
    const SEP = "\x1e";
    const rawLog = git(
      ["log", "--all", "--grep", sessionId, `--format=%H${SEP}%s${SEP}%b|||`],
      cwd,
    );

    if (!rawLog) {
      return buildSquashFromRecent(cwd, sessionId);
    }

    const entries = rawLog
      .split("|||")
      .filter(Boolean)
      .map((entry) => {
        const [hash, subject, ...bodyParts] = entry.trim().split(SEP);
        return {
          hash: (hash || "").substring(0, 7),
          subject: subject || "",
          body: bodyParts.join(SEP),
        };
      })
      .filter((e) => e.subject);

    if (entries.length === 0) {
      return buildSquashFromRecent(cwd, sessionId);
    }

    const lines: string[] = [
      `# Session Squash Digest`,
      `Session: ${sessionId}`,
      `Commits: ${entries.length}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Checkpoint Timeline",
      "",
    ];

    for (const e of entries.reverse()) {
      lines.push(`### ${e.hash} — ${e.subject}`);
      if (e.body?.trim()) {
        const bodyPreview = e.body.trim().split("\n").slice(0, 5);
        lines.push(...bodyPreview.map((l) => `> ${l}`));
      }
      lines.push("");
    }

    // Summary stats
    const types = entries
      .map((e) => e.subject.match(/^(\w+)\(/)?.[1] || "unknown")
      .reduce(
        (acc, t) => {
          acc[t] = (acc[t] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

    lines.push("## Checkpoint Graph", "");
    lines.push(buildCheckpointGraph(entries), "");

    lines.push("## Summary");
    lines.push(
      `${entries.length} checkpoints: ` +
        Object.entries(types)
          .map(([t, n]) => `${n} ${t}`)
          .join(", "),
    );

    return lines.join("\n");
  } catch {
    return buildSquashFromRecent(cwd, sessionId);
  }
}

/** Fallback: build squash from recent N commits. */
function buildSquashFromRecent(cwd: string, sessionId: string): string {
  try {
    const log = git(["log", "--oneline", "-20"], cwd);
    return (
      `# Session Squash Digest (fallback)\n` +
      `Session: ${sessionId}\n` +
      `Generated: ${new Date().toISOString()}\n\n` +
      `## Recent commits:\n${log}`
    );
  } catch {
    return `No commits found for session ${sessionId}`;
  }
}

// ═══════════════════════════════════════════════════════
// Rollback tag (#3)
// ═══════════════════════════════════════════════════════

/**
 * Create a lightweight tag for the current commit.
 * Format: loop/{shortSessionId}/checkpoint-{N}
 */
export function createCheckpointTag(
  cwd: string,
  sessionId: string,
  commitNumber: number,
): string | null {
  try {
    const shortSession = sessionId.substring(0, 8);
    const tagName = `loop/${shortSession}/checkpoint-${commitNumber}`;
    git(["tag", tagName], cwd);
    return tagName;
  } catch {
    return null; // Tag might already exist
  }
}

// ═══════════════════════════════════════════════════════
// State management helpers
// ═══════════════════════════════════════════════════════

/** Read commit state from the loop session directory. */
export function readCommitState(
  cwd: string,
  sessionId: string,
): CommitState | null {
  try {
    const { join } = require("path");
    const { readFileSync, existsSync } = require("fs");
    const fp = join(getLoopDir(cwd, sessionId), "commit-state.json");
    if (!existsSync(fp)) return null;
    return JSON.parse(readFileSync(fp, "utf8")) as CommitState;
  } catch {
    return null;
  }
}

/** Write commit state to the loop session directory. */
export function writeCommitState(
  cwd: string,
  sessionId: string,
  state: CommitState,
): void {
  try {
    const { join } = require("path");
    const { writeFileSync, mkdirSync, existsSync } = require("fs");
    const dir = getLoopDir(cwd, sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      join(dir, "commit-state.json"),
      JSON.stringify(state, null, 2),
    );
  } catch {
    // Non-critical
  }
}

// ═══════════════════════════════════════════════════════
// Changelog auto-append (#1)
// ═══════════════════════════════════════════════════════

/**
 * Append a commit entry to .project-brain/memory/CHANGELOG.md.
 * Creates the file if it doesn't exist.
 */
export function appendChangelog(
  cwd: string,
  hash: string,
  commitMsg: string,
): void {
  try {
    const { join } = require("path");
    const { appendFileSync, existsSync, mkdirSync } = require("fs");
    const dir = join(cwd, "docs", "memory");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const fp = join(dir, "CHANGELOG.md");

    // Create header if file doesn't exist
    if (!existsSync(fp)) {
      appendFileSync(
        fp,
        "# Changelog (auto-generated)\n\n" +
          "This file is maintained automatically by commitCheckpoint.\n" +
          "Each entry represents a session checkpoint.\n\n---\n\n",
      );
    }

    const subject = commitMsg.split("\n")[0];
    const ts = new Date().toISOString().split("T")[0];
    const entry = `## [${hash}] ${subject}\n` + `**Date**: ${ts}\n\n`;

    appendFileSync(fp, entry);
  } catch {
    // Non-critical — don't break commits over changelog
  }
}

// ═══════════════════════════════════════════════════════
// Commit graph visualization (#5)
// ═══════════════════════════════════════════════════════

/**
 * Build an ASCII checkpoint chain for the squash digest.
 */
function buildCheckpointGraph(
  entries: Array<{ hash: string; subject: string }>,
): string {
  if (entries.length === 0) return "";

  const nodes = entries.map((e) => {
    const type = e.subject.match(/^(\w+)\(/)?.[1] || "?";
    return { label: e.hash, type };
  });

  const chain = nodes.map((n) => n.label).join(" -> ");
  const types = nodes
    .map((n) => `  (${n.type})`.padStart(n.label.length + 4))
    .join("    ");

  return `\`\`\`\n${chain}\n${types}\n\`\`\``;
}

// ─── Audit State I/O ──────────────────────────────────────────────

export interface AuditState {
  editedFiles: string[];
  auditRound: number;
  lastAuditTs: number | null;
  synthesisAttempts: number;
  urgentMessages: string[];
  auditBypass?: boolean;
}

export function readAuditState(
  cwd: string,
  sessionId: string,
): AuditState | null {
  try {
    const { join } = require("path");
    const { existsSync, readFileSync } = require("fs");
    const dir = join(getLoopDir(cwd, sessionId || "_default"));
    const fp = join(dir, "audit-state.json");
    if (!existsSync(fp)) return null;
    return JSON.parse(readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

export function writeAuditState(
  cwd: string,
  sessionId: string,
  state: AuditState,
): void {
  try {
    const { join } = require("path");
    const { existsSync, mkdirSync, writeFileSync } = require("fs");
    const dir = getLoopDir(cwd, sessionId || "_default");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fp = join(dir, "audit-state.json");
    writeFileSync(fp, JSON.stringify(state, null, 2));
  } catch {
    /* non-fatal */
  }
}
