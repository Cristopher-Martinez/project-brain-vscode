/**
 * ast-discipline.mjs — AST-powered code discipline verification.
 * Upgrades regex heuristics from code-discipline.mjs with actual AST analysis
 * via oxc-parser (Rust-native, <5ms per file). Falls back gracefully if
 * oxc-parser is unavailable.
 * Also integrates safe-regex2 to detect catastrophic regex patterns.
 */

let parseSync = null;
let Visitor = null;
let isSafeRegex = null;

// Dynamic imports — fail gracefully if deps not installed
try {
  const oxc = await import("oxc-parser");
  parseSync = oxc.parseSync;
  Visitor = oxc.Visitor;
} catch {
  /* oxc-parser not available — fallback to regex heuristics */
}

try {
  const safeRegex = await import("safe-regex2");
  isSafeRegex = safeRegex.default || safeRegex;
} catch {
  /* safe-regex2 not available */
}

/**
 * Determine file extension for oxc-parser.
 * @param {string} filePath
 * @returns {string}
 */
function getFilename(filePath) {
  const ext = (filePath || "").split(".").pop() || "ts";
  const map = {
    ts: "test.ts",
    tsx: "test.tsx",
    js: "test.js",
    jsx: "test.jsx",
    mjs: "test.mjs",
  };
  return map[ext] || "test.ts";
}

/**
 * Analyze code using AST for discipline patterns.
 * Returns structured findings with exact node locations.
 * @param {string} content - Full file content
 * @param {string} newCode - The changed portion (newString)
 * @param {string} filePath - Absolute path
 * @returns {{ warnings: string[], regexLiterals: string[], unsafeRegex: string[] }}
 */
export function analyzeWithAST(content, newCode, filePath) {
  const result = { warnings: [], regexLiterals: [], unsafeRegex: [] };
  const basename = (filePath || "").split(/[/\\]/).pop() || "";

  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(basename)) return result;
  if (!parseSync) return result; // graceful fallback

  try {
    const filename = getFilename(filePath);
    const parsed = parseSync(filename, content);

    if (parsed.errors && parsed.errors.length > 0) {
      // Don't analyze files with parse errors
      return result;
    }

    // Track what we find in the full file
    const findings = {
      regexLiterals: [],
      newRegExpCalls: [],
      cleanupCalls: [],
      allowlistPatterns: [],
      stateExits: [],
      templateLiterals: [],
    };

    // Use Visitor to walk the AST
    const visitor = new Visitor({
      // Detect regex literals (ESTree: Literal with .regex property)
      Literal(node) {
        if (node.regex) {
          findings.regexLiterals.push({
            pattern: node.regex.pattern || "",
            flags: node.regex.flags || "",
            start: node.start,
            end: node.end,
          });
        }
      },

      // Detect `new RegExp(...)` calls
      NewExpression(node) {
        if (
          node.callee?.type === "Identifier" &&
          node.callee.name === "RegExp"
        ) {
          const patternArg = node.arguments?.[0];
          const pattern =
            patternArg?.type === "StringLiteral"
              ? patternArg.value
              : "<dynamic>";
          findings.newRegExpCalls.push({
            pattern,
            start: node.start,
            end: node.end,
          });
        }
      },

      // Detect method calls that indicate cleanup/teardown or state exits
      CallExpression(node) {
        const callee = node.callee;
        let methodName = "";

        if (
          callee?.type === "MemberExpression" &&
          callee.property?.type === "Identifier"
        ) {
          methodName = callee.property.name;
        } else if (callee?.type === "Identifier") {
          methodName = callee.name;
        }

        const cleanupMethods = [
          "rmSync",
          "unlinkSync",
          "delete",
          "cleanup",
          "teardown",
          "dispose",
          "destroy",
          "clearTimeout",
          "clearInterval",
        ];
        if (
          cleanupMethods.some((m) =>
            methodName.toLowerCase().includes(m.toLowerCase()),
          )
        ) {
          findings.cleanupCalls.push({ method: methodName, start: node.start });
        }

        // Detect resolve("__TIMEOUT__") etc.
        if (
          methodName === "resolve" &&
          node.arguments?.[0]?.type === "StringLiteral"
        ) {
          const val = node.arguments[0].value;
          if (/^__\w+__$/.test(val)) {
            findings.stateExits.push({ signal: val, start: node.start });
          }
        }
      },

      // Detect allowlist/filter patterns (Set, Map, object with MIME/allowed/supported)
      VariableDeclarator(node) {
        const name = node.id?.type === "Identifier" ? node.id.name : "";
        const isAllowlist =
          /MIME|mime|ALLOWED|SUPPORTED|ACCEPTED|isValid|isAllowed|isSupported|isImageType/i.test(
            name,
          );
        if (isAllowlist) {
          findings.allowlistPatterns.push({ name, start: node.start });
        }
      },
    });

    visitor.visit(parsed.program);

    // Now check if the NEW CODE contains these patterns
    const newCodeStart = content.indexOf(newCode);
    const newCodeEnd = newCodeStart >= 0 ? newCodeStart + newCode.length : -1;

    const isInNewCode = (start) => {
      if (newCodeStart < 0) return true; // can't determine, assume yes
      return start >= newCodeStart && start <= newCodeEnd;
    };

    // ── 1. FORMAT CONTRACTS — regex in new code ──
    const newRegexes = [
      ...findings.regexLiterals.filter((r) => isInNewCode(r.start)),
      ...findings.newRegExpCalls.filter((r) => isInNewCode(r.start)),
    ];

    if (newRegexes.length > 0) {
      result.regexLiterals = newRegexes.map((r) => r.pattern);
      result.warnings.push(
        `🔍 AST FORMAT CONTRACT: ${newRegexes.length} regex pattern(s) detected in new code of ${basename}. ` +
          `Patterns: [${newRegexes.map((r) => `/${r.pattern}/`).join(", ")}]. ` +
          `VERIFY: Each regex matches the EXACT format produced by its data source.`,
      );

      // Check for unsafe regex with safe-regex2
      if (isSafeRegex) {
        for (const r of newRegexes) {
          try {
            const pattern = r.pattern || "";
            if (pattern && !isSafeRegex(pattern)) {
              result.unsafeRegex.push(pattern);
              result.warnings.push(
                `⚠️ UNSAFE REGEX: Pattern /${pattern}/ may cause catastrophic backtracking (ReDoS). ` +
                  `Rewrite with non-greedy quantifiers or atomic groups.`,
              );
            }
          } catch {}
        }
      }
    }

    // ── 2. CLEANUP COVERAGE ──
    const newCleanup = findings.cleanupCalls.filter((c) =>
      isInNewCode(c.start),
    );
    if (newCleanup.length > 0 && findings.stateExits.length > 0) {
      const exits = findings.stateExits.map((e) => e.signal).join(", ");
      result.warnings.push(
        `🧹 AST CLEANUP COVERAGE: New cleanup calls [${newCleanup.map((c) => c.method).join(", ")}] in ${basename} ` +
          `which has ${findings.stateExits.length} state exit(s): [${exits}]. ` +
          `VERIFY: ALL exit paths invoke this cleanup.`,
      );
    }

    // ── 3. ALLOWLIST SYNC ──
    const newAllowlists = findings.allowlistPatterns.filter((a) =>
      isInNewCode(a.start),
    );
    if (newAllowlists.length > 0) {
      result.warnings.push(
        `📋 AST ALLOWLIST: Modified [${newAllowlists.map((a) => a.name).join(", ")}] in ${basename}. ` +
          `VERIFY: Upstream producers only emit values in this list, AND downstream consumers handle ALL values.`,
      );
    }

    // ── 4. DUAL CONTRACT (formatter + parser in new code) ──
    const hasFormatter = findings.templateLiterals.some((t) =>
      isInNewCode(t.start),
    );
    if (hasFormatter && newRegexes.length > 0) {
      result.warnings.push(
        `⚠️ AST DUAL CONTRACT: ${basename} contains BOTH a formatter and a parser in the same change. ` +
          `VERIFY: The template literal format and the regex are perfectly synchronized.`,
      );
    }
  } catch (err) {
    // AST parsing failed — non-fatal, fallback will be used
    result.warnings.push(
      `⚠️ AST analysis skipped for ${basename}: ${err.message}`,
    );
  }

  return result;
}

/**
 * Check if oxc-parser is available for AST analysis.
 * @returns {boolean}
 */
export function isASTAvailable() {
  return parseSync !== null;
}
