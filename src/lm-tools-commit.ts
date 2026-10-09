/**
 * lm-tools-commit.ts — commitCheckpoint sub-tool for smart commits.
 *
 * Uses commit-message-builder for rich bitacora-style messages,
 * and commit-session-ops for state/tags/squash.
 *
 * Features:
 * - Rich multi-line conventional commits (time-travel checkpoints)
 * - Commit counter per session (#2)
 * - Checkpoint tagging (#3)
 * - Auto-description fallback (#4)
 * - Previous-hash linking (#6)
 * - Branch protection (#7)
 * - Squash digest on demand (#5)
 */

import { execFileSync } from "child_process";
import * as vscode from "vscode";

import {
  buildCommitMessage,
  getCurrentBranch,
  getDiffStat,
  isProtectedBranch,
  validateCommitMessage,
} from "./commit-message-builder";
import type { CommitState } from "./commit-session-ops";
import {
  appendChangelog,
  buildSquashDigest,
  createCheckpointTag,
  readCommitState,
  writeCommitState,
} from "./commit-session-ops";
import { triggerClassificationAsync } from "./test-classifier";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

interface CommitCheckpointInput {
  sessionId: string;
  message?: string;
  scope?: string;
  description?: string;
}

// ═══════════════════════════════════════════════════════
// Git helpers
// ═══════════════════════════════════════════════════════

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}

function getUncommittedFiles(cwd: string): string[] {
  try {
    const out = gitExec(["status", "--short"], cwd);
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// Paths to stage (whitelist — skip transient state)
// ═══════════════════════════════════════════════════════

const ADD_PATHS = [
  "src/",
  "server/",
  ".github/",
  "static/",
  "webview-ui/",
  "package.json",
  "tsconfig.json",
];

// ═══════════════════════════════════════════════════════
// Tool implementation
// ═══════════════════════════════════════════════════════

export class CommitCheckpointTool implements vscode.LanguageModelTool<CommitCheckpointInput> {
  constructor(private logFn: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CommitCheckpointInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId, message, scope, description } = options.input;

    if (!sessionId) {
      return this.result("Missing sessionId parameter.");
    }

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      // 1. Check for uncommitted changes
      const uncommitted = getUncommittedFiles(cwd);
      const codeFiles = uncommitted.filter(
        (l) =>
          !l.includes(".brain-loops/") &&
          !l.includes("docs/memory/sessions/") &&
          !l.includes(".project-brain/memory/sessions/") &&
          !l.includes(".project-brain/"),
      );

      if (codeFiles.length === 0) {
        return this.result(
          "No code changes to commit. Only transient state files detected.",
        );
      }

      // 2. Read current state for counter + linking (#2, #6)
      const prevState = readCommitState(cwd, sessionId);
      const commitNumber = (prevState?.commitCount ?? 0) + 1;
      const previousHash = prevState?.lastCommitHash;

      // 2b. Trigger AI test classification (fire-and-forget — populates cache for hooks)
      triggerClassificationAsync(codeFiles, cwd).catch(() => {
        // Non-blocking: classification failure should never block commits
      });

      // 3. Branch protection warning (#7)
      const branchWarn = isProtectedBranch(cwd)
        ? "WARNING: Committing to protected branch!\n"
        : "";

      // 4. Generate rich commit message
      const rawMsg =
        message ||
        buildCommitMessage({
          files: codeFiles,
          cwd,
          scope,
          description,
          sessionId,
          commitNumber,
          previousHash,
        });

      // 5. Validate conventional commit format
      const { corrected: commitMsg } = validateCommitMessage(rawMsg);

      const branch = getCurrentBranch(cwd);

      // 5. Stage whitelisted paths
      for (const addPath of ADD_PATHS) {
        try {
          gitExec(["add", addPath], cwd);
        } catch {
          // Path might not exist
        }
      }

      // 6. Commit
      try {
        gitExec(["commit", "-m", commitMsg], cwd);
      } catch (commitErr) {
        const errMsg = String(commitErr);
        if (errMsg.includes("nothing to commit")) {
          return this.result("Nothing to commit after staging.");
        }
        throw commitErr;
      }

      // 7. Get the new commit hash
      let commitHash = "";
      try {
        commitHash = gitExec(["rev-parse", "--short", "HEAD"], cwd);
      } catch {
        commitHash = "(unknown)";
      }

      // 8. Create checkpoint tag (#3)
      const tag = createCheckpointTag(cwd, sessionId, commitNumber);
      const tagInfo = tag ? `Tag: ${tag}` : "Tag: (skipped)";

      // 10. Update commit state
      this.persistState(cwd, sessionId, commitNumber, commitHash);

      // 11. Append to CHANGELOG.md
      appendChangelog(cwd, commitHash, commitMsg);

      // 12. Diff stat for result
      const diffStat = getDiffStat(cwd);

      this.logFn(
        `[CommitCheckpoint] #${commitNumber} ${commitHash} on ${branch}`,
      );

      return this.result(
        `${branchWarn}` +
          `Commit exitoso:\n` +
          `  Hash: ${commitHash}\n` +
          `  Branch: ${branch}\n` +
          `  Checkpoint: #${commitNumber}\n` +
          `  ${tagInfo}\n` +
          `  Files: ${codeFiles.length}\n` +
          (previousHash ? `  Previous: ${previousHash}\n` : "") +
          `\nDiff stat:\n${diffStat}`,
      );
    } catch (err) {
      this.logFn(`[CommitCheckpoint] Error: ${err}`);
      return this.result(`Error durante commit: ${err}`);
    }
  }

  /** Persist updated commit state after a successful commit. */
  private persistState(
    cwd: string,
    sessionId: string,
    commitNumber: number,
    commitHash: string,
  ): void {
    const newState: CommitState = {
      editedSinceCommit: [],
      lastCommitTs: Date.now(),
      lastSuggestionTs: null,
      commitCount: commitNumber,
      suppressUntilFeedback: false,
      lastCommitHash: commitHash,
    };
    writeCommitState(cwd, sessionId, newState);
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}

// ═══════════════════════════════════════════════════════
// Squash Digest Tool (#5)
// ═══════════════════════════════════════════════════════

interface SquashDigestInput {
  sessionId: string;
}

/**
 * Generate a squash digest of all commits from a loop session.
 * Useful at session end for PR summaries.
 */
export class SquashDigestTool implements vscode.LanguageModelTool<SquashDigestInput> {
  constructor(private logFn: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SquashDigestInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId } = options.input;

    if (!sessionId) {
      return this.result("Missing sessionId parameter.");
    }

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      const digest = buildSquashDigest(cwd, sessionId);
      this.logFn(`[SquashDigest] Generated for session ${sessionId}`);
      return this.result(digest);
    } catch (err) {
      this.logFn(`[SquashDigest] Error: ${err}`);
      return this.result(`Error generating squash digest: ${err}`);
    }
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}
