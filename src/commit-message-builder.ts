/**
 * commit-message-builder.ts — Rich commit message generation.
 *
 * Generates bitacora-style conventional commit messages that serve
 * as living documentation checkpoints (time-travel quality).
 *
 * Features:
 * - Multi-line body with file categories
 * - Diff-stat integration
 * - Auto-description fallback from git diff analysis
 * - Commit counter per session
 * - Previous-checkpoint linking
 * - Branch protection warnings
 * - Squash digest for session-end summary
 */

import { execFileSync } from "child_process";

// Re-export session-level operations from their own module
export {
  buildSquashDigest,
  createCheckpointTag,
  readCommitState,
  writeCommitState,
} from "./commit-session-ops";
export type { CommitState } from "./commit-session-ops";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface CommitMessageOptions {
  files: string[];
  cwd: string;
  scope?: string;
  description?: string;
  sessionId?: string;
  commitNumber?: number;
  previousHash?: string;
}

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const CATEGORY_LABELS: Record<string, string> = {
  feat: "New features",
  fix: "Bug fixes",
  refactor: "Refactors",
  docs: "Documentation",
  chore: "Chores/infra",
  style: "Style/format",
};

const PROTECTED_BRANCHES = ["main", "master", "release"];

// ═══════════════════════════════════════════════════════
// Git helpers (local to this module)
// ═══════════════════════════════════════════════════════

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}

/** Get diff --stat for staged + unstaged changes. */
export function getDiffStat(cwd: string): string {
  try {
    const staged = git(["diff", "--cached", "--stat"], cwd);
    const unstaged = git(["diff", "--stat"], cwd);
    const parts = [staged, unstaged].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : "(no diff available)";
  } catch {
    return "(no diff available)";
  }
}

/** Get concise diff summary for auto-description fallback. */
function getDiffOneliner(cwd: string): string {
  try {
    const shortstat = git(["diff", "--cached", "--shortstat"], cwd);
    if (shortstat) return shortstat;
    return git(["diff", "--shortstat"], cwd) || "";
  } catch {
    return "";
  }
}

/** Get current branch name. */
export function getCurrentBranch(cwd: string): string {
  try {
    return git(["branch", "--show-current"], cwd);
  } catch {
    return "unknown";
  }
}

/** Check if current branch is protected. */
export function isProtectedBranch(cwd: string): boolean {
  const branch = getCurrentBranch(cwd);
  return PROTECTED_BRANCHES.includes(branch.toLowerCase());
}

// ═══════════════════════════════════════════════════════
// File classification
// ═══════════════════════════════════════════════════════

/** Classify git status lines into conventional commit categories. */
export function classifyFiles(
  files: string[],
): Record<string, string[]> {
  const cats: Record<string, string[]> = {
    feat: [], fix: [], refactor: [], docs: [], chore: [], style: [],
  };

  for (const line of files) {
    const file = line.substring(3).trim().split(" -> ").pop() || "";
    const lower = file.toLowerCase();

    if (lower.includes("docs/") || lower.endsWith(".md")) {
      cats.docs.push(file);
    } else if (
      lower.includes("hooks/") || lower.includes("static/hooks/")
    ) {
      cats.chore.push(file);
    } else if (lower.startsWith("src/")) {
      const status = line.substring(0, 2).trim();
      const cat = status === "A" || status === "??" ? "feat" : "refactor";
      cats[cat].push(file);
    } else if (lower.includes("test") || lower.includes("spec")) {
      cats.chore.push(file);
    } else {
      cats.chore.push(file);
    }
  }
  return cats;
}

/** Pick the dominant commit type from classified categories. */
export function pickDominantType(
  cats: Record<string, string[]>,
): string {
  let dominant = "chore";
  let max = 0;
  for (const [cat, arr] of Object.entries(cats)) {
    if (arr.length > max) {
      max = arr.length;
      dominant = cat;
    }
  }
  return dominant;
}

/** Infer scope from changed file paths. */
export function inferScope(files: string[]): string {
  const dirs = new Set<string>();
  for (const line of files) {
    const file = line.substring(3).trim();
    const parts = file.split(/[/\\]/);
    if (parts.length >= 2) {
      dirs.add(parts[0]);
    }
  }
  if (dirs.size === 1) return [...dirs][0];
  if (dirs.size <= 3) return [...dirs].join("+");
  return `${files.length}-files`;
}

// ═══════════════════════════════════════════════════════
// Auto-description fallback (#4)
// ═══════════════════════════════════════════════════════

/**
 * Generate a heuristic description from git diff when none is provided.
 * Reads cached diff to summarize actual code changes.
 */
function generateAutoDescription(
  cwd: string,
  files: string[],
): string {
  const stat = getDiffOneliner(cwd);
  const cats = classifyFiles(files);

  const parts: string[] = [];

  // Summarize by category
  for (const [cat, catFiles] of Object.entries(cats)) {
    if (catFiles.length === 0) continue;
    const label = CATEGORY_LABELS[cat] || cat;
    const names = catFiles
      .slice(0, 3)
      .map((f) => f.split(/[/\\]/).pop())
      .join(", ");
    const suffix = catFiles.length > 3
      ? ` (+${catFiles.length - 3} more)`
      : "";
    parts.push(`${label}: ${names}${suffix}`);
  }

  const desc = parts.join(". ") + ".";
  return stat ? `${desc}\n${stat}` : desc;
}

// ═══════════════════════════════════════════════════════
// Main message builder (#1, #2, #4, #6, #7)
// ═══════════════════════════════════════════════════════

/**
 * Build a rich, multi-line conventional commit message.
 * This is the heart of the bitacora system.
 */
export function buildCommitMessage(opts: CommitMessageOptions): string {
  const {
    files, cwd, scope, description, sessionId,
    commitNumber, previousHash,
  } = opts;

  if (files.length === 0) return "chore: empty commit checkpoint";

  const cats = classifyFiles(files);
  const pathDominant = pickDominantType(cats);
  const diffType = inferTypeFromDiff(cwd);
  const dominant = diffType || pathDominant;
  const resolvedScope = scope || inferScope(files);

  // --- Subject line (max 72 chars) ---
  const counterTag = commitNumber ? ` #${commitNumber}` : "";
  const subject =
    `${dominant}(${resolvedScope}): checkpoint${counterTag} (${files.length} files)`;

  // --- Branch protection warning (#7) ---
  const branchWarning = isProtectedBranch(cwd)
    ? "WARNING: Committing to protected branch!\n\n"
    : "";

  // --- Body ---
  const bodyLines: string[] = [];

  if (branchWarning) {
    bodyLines.push(branchWarning);
  }

  // Description or auto-generated fallback (#4)
  const bodyDesc = description || generateAutoDescription(cwd, files);
  bodyLines.push(bodyDesc, "");

  // File breakdown by category
  for (const [cat, catFiles] of Object.entries(cats)) {
    if (catFiles.length === 0) continue;
    bodyLines.push(
      `### ${CATEGORY_LABELS[cat] || cat} (${catFiles.length}):`,
    );
    for (const f of catFiles.slice(0, 15)) {
      bodyLines.push(`  - ${f}`);
    }
    if (catFiles.length > 15) {
      bodyLines.push(`  - ... and ${catFiles.length - 15} more`);
    }
    bodyLines.push("");
  }

  // Diff stat (#1)
  const diffStat = getDiffStat(cwd);
  if (diffStat && diffStat !== "(no diff available)") {
    bodyLines.push("Diff:", diffStat, "");
  }

  // --- Footer: session metadata (#2, #6) ---
  const ts = new Date().toISOString();
  bodyLines.push("---");
  bodyLines.push(`Timestamp: ${ts}`);
  bodyLines.push(`Files: ${files.length}`);

  if (commitNumber) {
    bodyLines.push(`Checkpoint: #${commitNumber}`);
  }
  if (sessionId) {
    bodyLines.push(`Loop-Session: ${sessionId}`);
  }
  if (previousHash) {
    bodyLines.push(`Previous-Checkpoint: ${previousHash}`);
  }

  return `${subject}\n\n${bodyLines.join("\n")}`;
}

// ═══════════════════════════════════════════════════════
// Semantic commit validation (#2)
// ═══════════════════════════════════════════════════════

const CONVENTIONAL_RE =
  /^(feat|fix|refactor|docs|chore|style|perf|test|build|ci|revert)(\(.+\))?!?:\s.+/;

/**
 * Validate a commit message follows conventional commits format.
 * Returns corrected message if invalid, or original if valid.
 */
export function validateCommitMessage(msg: string): {
  valid: boolean;
  corrected: string;
} {
  const subject = msg.split("\n")[0];
  if (CONVENTIONAL_RE.test(subject)) {
    return { valid: true, corrected: msg };
  }

  // Auto-correct: wrap in chore(misc) if totally freeform
  const cleanSubject = subject
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  const corrected = msg.replace(
    subject,
    `chore(misc): ${cleanSubject}`,
  );
  return { valid: false, corrected };
}

// ═══════════════════════════════════════════════════════
// Diff-aware smart type classification (#4)
// ═══════════════════════════════════════════════════════

/**
 * Analyze actual diff content to refine the commit type.
 * Returns a more accurate type than path-based heuristics alone.
 */
export function inferTypeFromDiff(cwd: string): string | null {
  try {
    const diff = git(["diff", "--cached", "-U0", "--no-color"], cwd);
    if (!diff) return null;

    const lines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const content = added.join("\n").toLowerCase();

    // Fix signals: error handling, catch blocks, bug-related keywords
    const fixSignals = (content.match(
      /\b(fix|bug|error|catch|throw|reject|fallback|workaround|patch)\b/g,
    ) || []).length;

    // Feat signals: new classes, interfaces, exports
    const featSignals = (content.match(
      /\b(class\s|interface\s|export\s+(class|function|const)|implements\s)\b/g,
    ) || []).length;

    // Refactor signals: rename, extract, simplify
    const refactorSignals = (content.match(
      /\b(rename|extract|simplif|reorganiz|clean|deprecat)\b/g,
    ) || []).length;

    const max = Math.max(fixSignals, featSignals, refactorSignals);
    if (max < 3) return null; // Not enough signal

    if (fixSignals === max) return "fix";
    if (featSignals === max) return "feat";
    if (refactorSignals === max) return "refactor";
    return null;
  } catch {
    return null;
  }
}

