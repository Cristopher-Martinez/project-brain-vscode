/**
 * Reactive Recall Parser — constants, text processing, and troubleshooting parser.
 *
 * Extracted from reactive-recall.ts to respect the 400-line limit.
 * Contains: PROBLEM_INDICATORS, STOP_WORDS, tokenize, calculateMatchScore,
 * extractSearchableText, parseTroubleshootingEntries.
 */

import type { TroubleshootEntry } from "./reactive-recall";

// ─── Problem Detection ──────────────────────────────────────────────────────

/** Words that signal the user might be encountering an issue. */
export const PROBLEM_INDICATORS = new Set([
  "error",
  "fail",
  "failed",
  "failure",
  "bug",
  "broken",
  "crash",
  "exception",
  "throw",
  "undefined",
  "null",
  "cannot",
  "unable",
  "wrong",
  "issue",
  "problem",
  "fix",
  "debug",
  "troubleshoot",
  "missing",
  "invalid",
  "timeout",
  "hang",
  "stuck",
  "slow",
  "enoent",
  "eacces",
  "eperm",
  "segfault",
  "sigsegv",
  "oom",
  "compile",
  "compilation",
  "tsc",
  "build",
  "deploy",
  "import",
  "require",
  "module",
  "dependency",
]);

// ─── Stop Words ─────────────────────────────────────────────────────────────

/** Common words to exclude from keyword matching. */
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "this",
  "that",
  "it",
  "its",
  "and",
  "or",
  "but",
  "not",
  "no",
  "if",
  "then",
  "else",
  "when",
  "while",
  "what",
  "which",
  "who",
  "how",
  "why",
  "where",
  "all",
  "each",
  "every",
  "any",
  "some",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "you",
  "we",
  "he",
  "she",
  "they",
  "me",
  "him",
  "us",
  "them",
]);

// ─── Text Processing ────────────────────────────────────────────────────────

export function extractSearchableText(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string" && val.length > 0 && key !== "sessionId") {
      parts.push(val);
    }
  }
  return parts.join(" ").trim();
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .filter((v, i, arr) => arr.indexOf(v) === i); // dedupe
}

export function calculateMatchScore(
  inputKeywords: string[],
  entryKeywords: string[],
): number {
  let score = 0;
  for (const word of inputKeywords) {
    for (const keyword of entryKeywords) {
      if (keyword === word) {
        score += 2; // exact match
      } else if (keyword.includes(word) || word.includes(keyword)) {
        score += 1; // partial match
      }
    }
  }
  return score;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/** Parse 05_TROUBLESHOOTING.md into lightweight index entries. */
export function parseTroubleshootingEntries(
  content: string,
): TroubleshootEntry[] {
  const entries: TroubleshootEntry[] = [];
  const lines = content.split("\n");
  let current: Partial<TroubleshootEntry> | null = null;
  let inSolution = false;
  let solutionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New H2 entry
    if (
      line.startsWith("## ") &&
      !line.startsWith("## How to add") &&
      !line.startsWith("## Entries")
    ) {
      // Save previous entry
      if (current?.title) {
        current.solutionPreview = formatSolutionPreview(solutionLines);
        entries.push(current as TroubleshootEntry);
      }

      const title = line.replace(/^## /, "").trim();
      current = {
        title,
        keywords: extractKeywordsFromTitle(title),
        solutionPreview: "",
        severity: "medium",
        lineNumber: i + 1,
      };
      inSolution = false;
      solutionLines = [];
      continue;
    }

    if (!current) continue;

    // Parse tags line
    if (line.includes("**Tags**:")) {
      const tagText = line.replace(/.*\*\*Tags\*\*:\s*/, "");
      const tags = tagText
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      current.keywords = [...(current.keywords ?? []), ...tags];
    }

    // Parse severity
    if (line.includes("**Severity**:")) {
      const sev = line
        .replace(/.*\*\*Severity\*\*:\s*/, "")
        .trim()
        .split(/\s/)[0];
      current.severity = sev || "medium";
    }

    // Track solution section
    if (line.startsWith("### Solution") || line.startsWith("### Fix")) {
      inSolution = true;
      continue;
    }
    if (line.startsWith("### ") && inSolution) {
      inSolution = false;
    }
    if (inSolution) {
      solutionLines.push(line);
    }
  }

  // Don't forget last entry
  if (current?.title) {
    current.solutionPreview = formatSolutionPreview(solutionLines);
    entries.push(current as TroubleshootEntry);
  }

  return entries;
}

function formatSolutionPreview(solutionLines: string[]): string {
  return solutionLines
    .filter((l) => l.trim().length > 0 && !l.startsWith("```"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 200);
}

function extractKeywordsFromTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, " ")
    .split(/[\s\-_.]+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));
}
