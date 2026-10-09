/**
 * code-discipline.mjs — Code discipline verification layer.
 * "Police at the door" — detects code patterns in edited files that
 * require explicit verification before shipping. Injects mandatory
 * self-audit prompts when risky patterns are found.
 * Three detection categories:
 * 1. FORMAT CONTRACTS — regex/parser in new code → verify matches data source
 * 2. STATE MACHINE COVERAGE — cleanup/teardown → verify all exit paths covered
 * 3. CROSS-MODULE CONSISTENCY — allowlists/filters → verify downstream processors match
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, basename as pathBasename, sep } from "path";
import { getLoopsDir } from "./brain-paths.mjs";
import { analyzeWithAST, isASTAvailable } from "./ast-discipline.mjs";

// ═══ Pattern detectors (regex fallback when AST unavailable) ═════

/** Patterns that indicate a regex consumer (parser) */
const REGEX_CONSUMER_PATTERNS = [
  /new RegExp\(/,
  /\.exec\(/,
  /\.match\(/,
  /\.matchAll\(/,
  /\.replace\([^,]+,/,
  /\/[^/]+\/[gimsuy]*\.test\(/,
];

/** Patterns that indicate a data producer (formatter/serializer) */
const FORMAT_PRODUCER_PATTERNS = [
  /\.join\(\s*["'`]\\n["'`]\s*\)/, // array.join("\n")
  /`[^`]*\$\{[^}]+\}[^`]*`/, // template literals with interpolation
  /JSON\.stringify\(/,
];

/** Patterns that indicate cleanup/teardown logic */
const CLEANUP_PATTERNS = [
  /\.rmSync\(/,
  /\.unlinkSync\(/,
  /\.delete\(/,
  /cleanup|teardown|dispose|destroy/i,
  /clearTimeout|clearInterval/,
];

/** Patterns that indicate a state machine with exit paths */
const STATE_EXIT_PATTERNS = [
  /resolve\(["'`]__\w+__["'`]\)/, // resolve("__TIMEOUT__") etc.
  /case\s+["'`].*end|close|stop|timeout/i,
  /signal|terminate|shutdown/i,
];

/** Patterns that indicate allowlist/filter definitions */
const ALLOWLIST_PATTERNS = [
  /MIME_MAP|mimeMap|mime_map/,
  /^image\//,
  /isValid|isAllowed|isSupported|isImageType/i,
  /new Set\(\[/,
  /ALLOWED_|SUPPORTED_|ACCEPTED_/,
];

// ═══ Analysis engine ═════════════════════════════════════════════

/**
 * Analyze edited content for patterns that need verification.
 * Returns an array of discipline warnings to inject.
 * @param {string} content - The FULL file content after the edit
 * @param {string} newCode - The newString content (what changed)
 * @param {string} filePath - Absolute path to the edited file
 * @returns {string[]} Array of warning strings
 */
export function analyzeForDiscipline(content, newCode, filePath) {
  // Try AST-powered analysis first (more accurate, fewer false positives)
  if (isASTAvailable()) {
    const astResult = analyzeWithAST(content, newCode, filePath);
    if (astResult.warnings.length > 0) {
      // Prefix AST warnings to distinguish from regex fallback
      return astResult.warnings;
    }
  }

  // Fallback: regex-based heuristic analysis
  const warnings = [];
  const basename = (filePath || "").split(/[/\\]/).pop() || "";

  // Only analyze TypeScript/JavaScript files
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(basename)) return warnings;

  // ── 1. Format Contract Check ──
  const hasNewRegex = REGEX_CONSUMER_PATTERNS.some((p) => p.test(newCode));
  const hasNewFormat = FORMAT_PRODUCER_PATTERNS.some((p) => p.test(newCode));

  if (hasNewRegex) {
    warnings.push(
      `🔍 FORMAT CONTRACT: New regex/parser detected in ${basename}. ` +
        `VERIFY: Does this regex match the EXACT format produced by the data source? ` +
        `Test with a real example from the producer before shipping.`,
    );
  }

  if (hasNewFormat && hasNewRegex) {
    warnings.push(
      `⚠️ DUAL CONTRACT: ${basename} has BOTH a formatter and a parser. ` +
        `VERIFY: The format string and the regex are synchronized. ` +
        `If they're in different functions, add a comment linking them.`,
    );
  }

  // ── 2. State Machine Coverage Check ──
  const hasCleanup = CLEANUP_PATTERNS.some((p) => p.test(newCode));

  if (hasCleanup) {
    const hasStateExit = STATE_EXIT_PATTERNS.some((p) => p.test(content));
    if (hasStateExit) {
      warnings.push(
        `🧹 CLEANUP COVERAGE: New cleanup/teardown in ${basename} which has state machine exits. ` +
          `VERIFY: ALL exit paths (end, timeout, error, discard, hibernate) call this cleanup. ` +
          `List them explicitly.`,
      );
    }
  }

  // ── 3. Cross-Module Consistency Check ──
  const hasAllowlist = ALLOWLIST_PATTERNS.some((p) => p.test(newCode));
  if (hasAllowlist) {
    warnings.push(
      `📋 ALLOWLIST SYNC: Filter/allowlist modified in ${basename}. ` +
        `VERIFY: Upstream producers only emit values in this list, ` +
        `AND downstream consumers handle all values in this list.`,
    );
  }

  // ── 4. Import Existence Guard ──
  const importRegex =
    /(?:import\s+.*?from\s+['"](\.[^'"]+)['"]|require\(['"](\.[^'"]+)['"]\))/g;
  let importMatch;
  while ((importMatch = importRegex.exec(newCode)) !== null) {
    const importPath = importMatch[1] || importMatch[2];
    if (!importPath || !importPath.startsWith(".")) continue;
    const dir = dirname(filePath);
    const resolved = join(dir, importPath);
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".d.ts", ""];
    const found =
      extensions.some((ext) => existsSync(resolved + ext)) ||
      existsSync(resolved);
    if (!found) {
      warnings.push(
        `❌ IMPORT NOT FOUND: "${importPath}" in ${basename} does not resolve to any file.`,
      );
    }
  }

  // ── 5. Dependency Direction Guard ──
  // Only applies to files in src/ that are NOT tools (lm-tools-*)
  const parts = filePath.split(sep);
  const srcIdx = parts.indexOf("src");
  if (srcIdx >= 0 && !basename.startsWith("lm-tools-")) {
    const toolImportRegex =
      /(?:import|require).*['"]\.\/lm-tools-(?!shared)[^'"]*['"]/g;
    if (toolImportRegex.test(newCode)) {
      warnings.push(
        `⚠️ DEPENDENCY VIOLATION: Core file ${basename} imports from tools layer (lm-tools-*). ` +
          `Flow must be: tools → shared → core. Never import upstream.`,
      );
    }
  }

  // ── 6. Stale Comment Detection ──
  // Compare function signatures between old content and new code
  const funcSigRegex = /function\s+(\w+)\s*\(([^)]*)\)/g;
  let sigMatch;
  while ((sigMatch = funcSigRegex.exec(newCode)) !== null) {
    const funcName = sigMatch[1];
    const newParams = sigMatch[2].trim();
    // Find the same function in old content
    const oldFuncRegex = new RegExp(`function\\s+${funcName}\\s*\\(([^)]*)\\)`);
    const oldMatch = content.match(oldFuncRegex);
    if (oldMatch) {
      const oldParams = oldMatch[1].trim();
      if (oldParams !== newParams) {
        // Parameters changed — check if JSDoc exists in old content
        const jsdocRegex = new RegExp(
          `/\\*\\*[^*]*\\*.*?function\\s+${funcName}`,
          "s",
        );
        if (jsdocRegex.test(content)) {
          warnings.push(
            `📝 STALE COMMENT: Function ${funcName}() signature changed ` +
              `(${oldParams} → ${newParams}) but JSDoc may be stale. Update the docs.`,
          );
        }
      }
    }
  }

  return warnings;
}

// ═══ Test-Edit Correlation ═══════════════════════════════════════

/** Extensions that represent testable code files. */
const TESTABLE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Files exempt from test-edit correlation checks. */
const TEST_EXEMPT_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /tsconfig/,
  /\.json$/,
  /types\.ts$/,
  /constants\.ts$/,
  /index\.ts$/,
  /\.d\.ts$/,
  /\.md$/,
  // Non-code files that should never require tests
  /\.env/,
  /\.ya?ml$/,
  /\.toml$/,
  /\.cfg$/,
  /\.ini$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.ico$/,
  /\.webp$/,
  /\.css$/,
  /\.scss$/,
  /\.less$/,
  /\.html$/,
  /\.xml$/,
  /\.txt$/,
  /\.lock$/,
  /\.log$/,
  /\.sh$/,
  /\.bat$/,
  /\.ps1$/,
  /^Dockerfile/,
  /^docker-compose/,
  /^\.gitignore$/,
  /^\.eslint/,
  /^\.prettier/,
  /^\.vscode/,
  /^\.github/,
  /^LICENSE/,
  /^Makefile$/,
];

/**
 * Read AI test classification cache from disk.
 * Written by src/test-classifier.ts via ModelRouter delegation.
 * @param {string} cwd - Project root
 * @param {string[]} files - File basenames to check
 * @returns {{ testable: Set<string>, excluded: Map<string, string> } | null}
 */
function readAIClassificationCache(cwd, files) {
  try {
    const cachePath = join(getLoopsDir(cwd), "test-classification.json");
    if (!existsSync(cachePath)) return null;

    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const sortedKey = files
      .map((f) => pathBasename(f))
      .sort()
      .join("|");
    const entry = cache[sortedKey];
    if (!entry) return null;

    // Cache TTL: 30 minutes
    if (Date.now() - entry.timestamp > 30 * 60 * 1000) return null;

    const testable = new Set(
      (entry.testable || []).map((f) => pathBasename(f)),
    );
    const excluded = new Map(
      (entry.excluded || []).map((e) => [pathBasename(e.file), e.reason]),
    );
    return { testable, excluded };
  } catch {
    return null;
  }
}

/**
 * Check test-edit correlation for a set of edited files.
 * Uses AI classification cache when available, falls back to regex heuristics.
 * Returns warnings for files edited without corresponding test updates.
 * @param {string[]} editedFiles - List of edited file basenames/paths
 * @param {string} cwd - Project root
 * @returns {string[]} Array of warning strings
 */
export function checkTestEditCorrelation(editedFiles, cwd) {
  const warnings = [];
  const editedSet = new Set(editedFiles.map((f) => pathBasename(f)));

  // Try AI classification cache first
  const aiCache = readAIClassificationCache(cwd, editedFiles);

  // Build workspace file index once — dynamic discovery for any project structure
  const SKIP_DIRS = new Set([
    "node_modules", "dist", ".git", ".project-brain", ".brain-loops", "coverage",
    "build", ".next", ".nuxt", ".output", "vendor", "__pycache__",
  ]);
  const workspaceFiles = new Set();
  function walkDir(dir, depth) {
    if (depth > 5) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) workspaceFiles.add(entry.name);
        else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          walkDir(join(dir, entry.name), depth + 1);
        }
      }
    } catch { /* ignore permission errors */ }
  }
  walkDir(cwd, 0);

  for (const file of editedFiles) {
    const base = pathBasename(file);

    // AI cache path: if AI says "excluded", skip immediately
    if (aiCache) {
      if (aiCache.excluded.has(base)) continue;
      // If AI says file is NOT in testable set, also skip
      if (!aiCache.testable.has(base)) continue;
    }

    // Regex fallback: skip exempt files
    if (TEST_EXEMPT_PATTERNS.some((p) => p.test(base))) continue;

    // Skip non-code files — only testable code extensions should be checked
    if (!TESTABLE_EXTENSIONS.test(base)) continue;

    // Derive possible test file names
    const stem = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    const testVariants = [
      `${stem}.test.ts`,
      `${stem}.test.tsx`,
      `${stem}.test.js`,
      `${stem}.test.jsx`,
      `${stem}.test.mjs`,
      `${stem}.test.cjs`,
      `${stem}.spec.ts`,
      `${stem}.spec.tsx`,
      `${stem}.spec.js`,
      `${stem}.spec.jsx`,
      `${stem}.spec.mjs`,
      `${stem}.spec.cjs`,
    ];

    // Check if any test variant was co-edited
    const testCoEdited = testVariants.some((tv) => editedSet.has(tv));
    if (testCoEdited) continue;

    // Check if any test file exists anywhere in the workspace
    const testExists = testVariants.some((tv) => workspaceFiles.has(tv));

    if (testExists) {
      warnings.push(
        `⚠️ TEST DRIFT: ${base} was edited but its test file was not updated.`,
      );
    } else {
      warnings.push(`❌ TEST MISSING: ${base} has no corresponding test file.`);
    }
  }
  return warnings;
}

// ═══ Contract registry (session-persistent) ═════════════════════

/**
 * Clear contract tracker (call at session start).
 * @param {string} sessionsDir
 */
export function clearContracts(sessionsDir) {
  const contractFile = join(sessionsDir, "code-contracts.json");
  try {
    if (existsSync(contractFile)) {
      writeFileSync(contractFile, "[]");
    }
  } catch {}
}
