/**
 * invariants-parser.ts — T1: Parse @invariant tags from test files.
 *
 * Scans test files looking for JSDoc-style @invariant declarations.
 * Supports JS/TS (@invariant), Python (@pytest.mark.invariant / # @invariant),
 * Go (// @invariant), and Rust (// @invariant).
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md — T1 spec
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { log, logWarn } from "./logger";
import { InvariantEntry } from "./test-pipeline-types";

// ——— Constants ————————————————————————————————————————————————

/** Default test directories to scan if none specified. */
const DEFAULT_TEST_DIRS = [
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "src",
];

/** File extensions considered as test files. */
const TEST_FILE_PATTERNS: Record<string, RegExp> = {
  js: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  python: /test_.*\.py$|.*_test\.py$/,
  go: /_test\.go$/,
  rust: /tests?\.rs$/,
};

/** Max file size to scan for invariants (100KB). */
const MAX_SCAN_SIZE = 100 * 1024;

/** Max files to scan to avoid performance issues. */
const MAX_FILES = 500;

// ——— File Discovery ———————————————————————————————————————————

/** Find test files under wsRoot. */
function findTestFiles(wsRoot: string): string[] {
  const results: string[] = [];
  const allPatterns = Object.values(TEST_FILE_PATTERNS);

  for (const dir of DEFAULT_TEST_DIRS) {
    const fullDir = join(wsRoot, dir);
    if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) {
      continue;
    }
    collectTestFiles(fullDir, wsRoot, allPatterns, results);
    if (results.length >= MAX_FILES) {
      break;
    }
  }

  return results.slice(0, MAX_FILES);
}

/** Recursively collect test files from a directory. */
function collectTestFiles(
  dir: string,
  wsRoot: string,
  patterns: RegExp[],
  results: string[],
  depth = 0,
): void {
  if (depth > 6 || results.length >= MAX_FILES) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") {
      continue;
    }

    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      collectTestFiles(full, wsRoot, patterns, results, depth + 1);
    } else if (stat.isFile() && patterns.some((p) => p.test(entry))) {
      results.push(relative(wsRoot, full).replace(/\\/g, "/"));
    }
  }
}

// ——— Parsing ——————————————————————————————————————————————————

/** Parse a single block-comment style invariant (JS/TS pattern). */
function parseJSDocInvariants(content: string, file: string): InvariantEntry[] {
  const entries: InvariantEntry[] = [];

  // Match JSDoc blocks: /** ... */
  const blockRegex = /\/\*\*[\s\S]*?\*\//g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(content)) !== null) {
    const block = blockMatch[0];

    // Find ALL @invariant tags in this block (supports multiple per block)
    const idRegex = /@invariant\s+([a-z0-9][a-z0-9_-]*)/g;
    let idMatch;
    const ids: string[] = [];
    while ((idMatch = idRegex.exec(block)) !== null) {
      ids.push(idMatch[1]);
    }
    if (ids.length === 0) {
      continue;
    }

    // Shared @description and @impact for all invariants in this block
    const descMatch = block.match(/@description\s+(.+)/);
    const impactMatch = block.match(/@impact\s+(.+)/);

    if (!impactMatch) {
      logWarn(
        `[Invariants] ${file}: @invariant ${ids.join(", ")} sin @impact — ignorada`,
      );
      continue;
    }

    // Find line number
    const beforeBlock = content.slice(0, blockMatch.index);
    const line = beforeBlock.split("\n").length;

    // Try to grab the test name from the next line after the block
    const afterBlock = content.slice(blockMatch.index + block.length);
    const testNameMatch = afterBlock.match(
      /^\s*(?:it|test|describe)\s*\(\s*['"`](.+?)['"`]/m,
    );

    for (const id of ids) {
      entries.push({
        id,
        description: descMatch?.[1]?.trim() ?? "",
        impact: impactMatch[1].trim(),
        file,
        line,
        testName: testNameMatch?.[1],
      });
    }
  }

  return entries;
}

/** Parse comment-style invariants (Python #, Go //, Rust //). */
function parseCommentInvariants(
  content: string,
  file: string,
): InvariantEntry[] {
  const entries: InvariantEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: # @invariant id  or  // @invariant id  or  @pytest.mark.invariant("id")
    const idMatch = line.match(
      /(?:#|\/\/)\s*@invariant\s+([a-z0-9][a-z0-9_-]*)|@pytest\.mark\.invariant\(\s*["']([a-z0-9][a-z0-9_-]*)["']\s*\)/,
    );
    if (!idMatch) {
      continue;
    }

    const id = idMatch[1] ?? idMatch[2];

    // Look ahead for @description and @impact in consecutive comment lines
    let description = "";
    let impact = "";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j];
      const descMatch = nextLine.match(/(?:#|\/\/)\s*@description\s+(.+)/);
      const impactMatch = nextLine.match(/(?:#|\/\/)\s*@impact\s+(.+)/);
      if (descMatch) {
        description = descMatch[1].trim();
      }
      if (impactMatch) {
        impact = impactMatch[1].trim();
      }
    }

    if (!impact) {
      logWarn(`[Invariants] ${file}: @invariant ${id} sin @impact — ignorada`);
      continue;
    }

    entries.push({
      id,
      description,
      impact,
      file,
      line: i + 1,
    });
  }

  return entries;
}

// ——— Public API ————————————————————————————————————————————————

/**
 * Parse all @invariant tags from test files in a workspace.
 *
 * @param wsRoot Workspace root path
 * @param invariantsPattern Pattern from the contract (e.g. "@invariant")
 * @returns Array of parsed invariant entries
 */
export function parseInvariants(
  wsRoot: string,
  invariantsPattern: string,
): InvariantEntry[] {
  const testFiles = findTestFiles(wsRoot);
  if (testFiles.length === 0) {
    log("[Invariants] No test files found");
    return [];
  }

  log(
    `[Invariants] Scanning ${testFiles.length} test files for ${invariantsPattern} tags`,
  );
  const allEntries: InvariantEntry[] = [];
  const seenIds = new Map<string, string>(); // id → first file

  for (const relFile of testFiles) {
    const absFile = join(wsRoot, relFile);
    let stat;
    try {
      stat = statSync(absFile);
    } catch {
      continue;
    }
    if (stat.size > MAX_SCAN_SIZE) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absFile, "utf-8");
    } catch {
      continue;
    }

    // Skip files without the invariant pattern (fast path)
    // Check for both the raw pattern and the keyword without @
    const patternKeyword = invariantsPattern.replace(/^@/, "");
    if (
      !content.includes(invariantsPattern) &&
      !content.includes(patternKeyword)
    ) {
      continue;
    }

    // Choose parser based on file extension
    const isJSTS = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(relFile);
    const entries = isJSTS
      ? parseJSDocInvariants(content, relFile)
      : parseCommentInvariants(content, relFile);

    // Dedup: warn if same id in multiple files
    for (const entry of entries) {
      const existing = seenIds.get(entry.id);
      if (existing && existing !== relFile) {
        // Same invariant in multiple files — track but don't reject
        log(
          `[Invariants] ${entry.id} also in ${existing} — multi-file coverage`,
        );
      }
      seenIds.set(entry.id, relFile);
      allEntries.push(entry);
    }
  }

  log(
    `[Invariants] Found ${allEntries.length} invariants in ${testFiles.length} files`,
  );
  return allEntries;
}

/**
 * Count unique invariant IDs. Used for anti-inflation check.
 * >50 unique IDs triggers a review warning.
 */
export function countUniqueInvariants(entries: InvariantEntry[]): number {
  return new Set(entries.map((e) => e.id)).size;
}

/**
 * Detect inflation: same invariant ID appearing in >5 different test files.
 * Returns IDs that are inflated.
 */
export function detectInflation(entries: InvariantEntry[]): string[] {
  const fileCounts = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!fileCounts.has(e.id)) {
      fileCounts.set(e.id, new Set());
    }
    fileCounts.get(e.id)!.add(e.file);
  }
  return [...fileCounts.entries()]
    .filter(([, files]) => files.size > 5)
    .map(([id]) => id);
}

/**
 * Detect impact inconsistency: same invariant ID with different @impact text
 * across files. Returns array of { id, impacts } for inconsistent invariants.
 */
export function detectImpactInconsistency(
  entries: InvariantEntry[],
): Array<{ id: string; impacts: string[] }> {
  const impactMap = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!impactMap.has(e.id)) {
      impactMap.set(e.id, new Set());
    }
    impactMap.get(e.id)!.add(e.impact);
  }
  return [...impactMap.entries()]
    .filter(([, impacts]) => impacts.size > 1)
    .map(([id, impacts]) => ({ id, impacts: [...impacts] }));
}

/**
 * Validate invariant quality. Rejects generic patterns.
 */
export function validateInvariantId(id: string): {
  valid: boolean;
  reason?: string;
} {
  const GENERIC_PATTERNS = [
    "input-not-null",
    "error-handled",
    "returns-value",
    "not-empty",
    "is-valid",
    "has-data",
  ];
  if (GENERIC_PATTERNS.includes(id)) {
    return { valid: false, reason: `"${id}" es demasiado genérica` };
  }
  if (id.length < 4) {
    return { valid: false, reason: `"${id}" es demasiado corta (min 4 chars)` };
  }
  return { valid: true };
}
