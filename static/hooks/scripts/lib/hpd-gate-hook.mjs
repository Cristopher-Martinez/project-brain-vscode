/**
 * T3.7 — HPD Gate (Anti Happy Path Gate)
 *
 * Detects superficial test suites before allowing:
 *   - T4 mutation activation
 *   - Enforce mode in production
 *
 * Position in DAG: T0 → T1 → T2 → T3 → T3.7 (HPD) → T4
 *
 * Scores test depth (0–100) via 6 metrics:
 *   M1: Negative test ratio        (20%)
 *   M2: Boundary coverage density   (15%)
 *   M3: Assertion strength          (20%)
 *   M4: Branch sensitivity          (20%)
 *   M5: Error path presence         (15%)
 *   M6: Side-effect assertions      (10%)
 */

import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

// ──────── Test File Discovery ────────

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /\.adversarial-test\./,
  /\.test\.mjs$/,
  /\.spec\.mjs$/,
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
]);

/**
 * Recursively find test files in a directory.
 * @param {string} dir
 * @param {string} root
 * @returns {{ path: string, content: string }[]}
 */
function findTestFiles(dir, root = dir) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findTestFiles(fullPath, root));
      } else if (entry.isFile()) {
        const relPath = relative(root, fullPath);
        const isTest = TEST_PATTERNS.some((p) => p.test(relPath));
        if (isTest) {
          try {
            const content = readFileSync(fullPath, "utf8");
            results.push({ path: relPath, content });
          } catch {}
        }
      }
    }
  } catch {}
  return results;
}

// ──────── Test Block Extraction ────────

/**
 * Extract individual test blocks from file content.
 * Supports: it(), test(), scenario(), describe() nesting.
 * Returns array of { name, body } objects.
 */
function extractTestBlocks(content) {
  const blocks = [];
  // Match it("...", ...) or test("...", ...) or scenario("...", ...)
  const testRegex = /\b(?:it|test|scenario)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = testRegex.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    // Find the function body — naive brace counting
    let braceDepth = 0;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === "{") {
        if (bodyStart === -1) bodyStart = i;
        braceDepth++;
      } else if (content[i] === "}") {
        braceDepth--;
        if (braceDepth === 0 && bodyStart !== -1) {
          bodyEnd = i;
          break;
        }
      }
    }
    if (bodyStart !== -1 && bodyEnd !== -1) {
      blocks.push({ name, body: content.substring(bodyStart, bodyEnd + 1) });
    }
  }
  return blocks;
}

// ──────── M1: Negative Test Ratio ────────

const NEGATIVE_PATTERNS = [
  /\.toThrow/i,
  /\.rejects/i,
  /expect\([^)]*\)\.not\./i,
  /toBeFalsy/i,
  /toBe\(\s*false\s*\)/i,
  /assert\s*\(\s*!/,
  /assert\s*\(\s*[^,]*===\s*false/,
  /pass\s*[:=]\s*false/i,
  /blocking\s*[:=]\s*true/i,
  /\.catch\s*\(/,
  /FAIL/,
  /should\s+(not|fail|block|reject|throw)/i,
  /must\s+(not|fail|block|reject|throw)/i,
];

function computeM1(testBlocks) {
  if (testBlocks.length === 0)
    return { score: 0, detail: "No test blocks found" };
  let negativeCount = 0;
  for (const block of testBlocks) {
    const isNegative = NEGATIVE_PATTERNS.some((p) => p.test(block.body));
    if (isNegative) negativeCount++;
  }
  const ratio = negativeCount / testBlocks.length;
  const score = Math.min(100, Math.round((ratio / 0.2) * 100)); // 20% = 100
  return {
    score,
    ratio: Math.round(ratio * 100),
    negativeCount,
    total: testBlocks.length,
    detail: `${negativeCount}/${testBlocks.length} tests have negative paths (${Math.round(ratio * 100)}%)`,
  };
}

// ──────── M2: Boundary Coverage Density ────────

const BOUNDARY_PATTERNS = [
  { name: "zero", pattern: /(?:=\s*0[^.]|,\s*0[^.]|:\s*0[^.]|\(\s*0[^.])/g },
  { name: "null", pattern: /null/g },
  { name: "undefined", pattern: /undefined/g },
  { name: "empty-string", pattern: /["']\s*["']/g },
  { name: "empty-array", pattern: /\[\s*\]/g },
  {
    name: "exact-threshold",
    pattern: /(?:exact|boundary|threshold|limit|edge)/gi,
  },
  { name: "just-below", pattern: /(?:below|under|less|minus|antes)/gi },
  {
    name: "extreme",
    pattern: /(?:MAX_|MIN_|Infinity|Number\.|100\s*%|0\s*%)/g,
  },
];

function computeM2(testBlocks) {
  if (testBlocks.length === 0) return { score: 0, detail: "No test blocks" };
  const allContent = testBlocks.map((b) => b.body).join("\n");
  let found = 0;
  const present = [];
  for (const bp of BOUNDARY_PATTERNS) {
    if (bp.pattern.test(allContent)) {
      found++;
      present.push(bp.name);
    }
    bp.pattern.lastIndex = 0; // reset regex
  }
  const score = Math.round((found / BOUNDARY_PATTERNS.length) * 100);
  return {
    score,
    found,
    total: BOUNDARY_PATTERNS.length,
    present,
    detail: `${found}/${BOUNDARY_PATTERNS.length} boundary categories present: ${present.join(", ")}`,
  };
}

// ──────── M3: Assertion Strength ────────

const WEAK_ASSERTION_PATTERNS = [
  /expect\s*\(\s*true\s*\)/,
  /expect\s*\(\s*1\s*\)/,
  /toBeTruthy\s*\(\s*\)/,
  /toBeDefined\s*\(\s*\)/,
  /expect\s*\(\s*result\s*\)\s*\.toBeTruthy/,
];

const STRONG_ASSERTION_PATTERNS = [
  // ── Jest/Vitest core ──
  /assert\s*\([^,]+,[^)]+\)/, // assert(condition, message)
  /\.toEqual\s*\(/,
  /\.toBe\s*\(\s*(?!true\s*\))/,
  /\.toContain/,
  /\.toMatch/,
  /\.toHaveBeenCalled/, // also matches toHaveBeenCalledWith/Times
  /\.toHaveProperty/,
  /\.toStrictEqual/,
  /\.toHaveLength/,
  /expect\([^)]+\)\.(not\.)?to/,
  /\.toThrow/, // .toThrow(), .toThrowError()
  /\.rejects\./, // expect(...).rejects.toX
  /\.resolves\./, // expect(...).resolves.toX
  /\.toBeNull/,
  /\.toBeFalsy/,
  /\.toBeUndefined/,
  /\.toBeGreater/, // toBeGreaterThan, toBeGreaterThanOrEqual
  /\.toBeLess/, // toBeLessThan, toBeLessThanOrEqual
  /\.toBeInstanceOf/,
  /\.toHaveReturnedWith/,
  /\.toBeCloseTo/,
  // ── Node.js assert module ──
  /assert\.\w+\s*\(/, // assert.ok(), assert.equal(), assert.deepEqual()
  /assert\.strict/, // assert.strictEqual, assert.strict.equal
  /strictEqual\s*\(/, // standalone strictEqual()
  /deepStrictEqual\s*\(/,
  /notEqual\s*\(/,
  /doesNotThrow\s*\(/,
  /throws\s*\(/, // assert.throws()
  // ── Chai / should.js ──
  /\.include\s*\(/, // .include(), .to.include()
  /should\.\w+/, // should.equal, should.be
  /\.to\.be\.\w/, // chai .to.be.true, .to.be.a
  /\.to\.have\.\w/, // chai .to.have.property
  /\.to\.equal/, // chai .to.equal
  /\.to\.deep\./, // chai .to.deep.equal
  /\.eql\s*\(/, // chai deep equal
  // ── Sinon ──
  /\.calledWith\s*\(/, // sinon calledWith
  /\.calledOnce\b/, // sinon calledOnce
  /\.notCalled\b/, // sinon notCalled
  // ── HTTP / supertest ──
  /\.expect\s*\(\s*\d{3}\s*\)/, // supertest .expect(200)
];

function computeM3(testBlocks) {
  if (testBlocks.length === 0) return { score: 0, detail: "No test blocks" };
  let strongCount = 0;
  let weakCount = 0;
  let noAssertionCount = 0;
  for (const block of testBlocks) {
    const hasStrong = STRONG_ASSERTION_PATTERNS.some((p) => p.test(block.body));
    const hasWeak = WEAK_ASSERTION_PATTERNS.some((p) => p.test(block.body));
    if (hasStrong) strongCount++;
    else if (hasWeak) weakCount++;
    else noAssertionCount++;
  }
  const semanticRatio = strongCount / testBlocks.length;
  const score = Math.min(100, Math.round((semanticRatio / 0.8) * 100)); // 80% = 100
  return {
    score,
    strongCount,
    weakCount,
    noAssertionCount,
    total: testBlocks.length,
    detail: `${strongCount} strong, ${weakCount} weak, ${noAssertionCount} no-assertion (${Math.round(semanticRatio * 100)}% semantic)`,
  };
}

// ──────── M4: Branch Sensitivity ────────

function computeM4(testBlocks, coverageData) {
  // Approximate from test content: look for dual-condition testing patterns
  if (testBlocks.length === 0) return { score: 0, detail: "No test blocks" };

  let dualConditionTests = 0;
  const allContent = testBlocks.map((b) => b.body).join("\n");

  // Detect patterns indicating both sides of a condition are tested
  const dualPatterns = [
    // Domain-specific toggles
    /enabled.*(?:true|false).*enabled.*(?:true|false)/s,
    /mode.*(?:report|enforce).*mode.*(?:report|enforce)/s,
    /pass.*(?:true|false).*pass.*(?:true|false)/s,
    /blocking.*(?:true|false).*blocking.*(?:true|false)/s,
    // Generic positive/negative test pairs in names
    /(?:should|does|can)\s+\w+[\s\S]{0,2000}(?:should|does|can)\s+not\s+\w+/,
    // Valid + invalid pattern
    /(?:valid|correct|success)[\s\S]{0,3000}(?:invalid|incorrect|fail|error)/i,
    // If-else branch testing (both branches in same describe)
    /(?:when|if)\s+\w+[\s\S]{0,2000}(?:when|if)\s+(?:not|no|without)\s+\w+/i,
    // Null/undefined + defined pairing
    /(?:null|undefined|missing)[\s\S]{0,2000}(?:defined|exists|present|provided)/i,
    // Empty + non-empty pairing
    /(?:empty|no\s+\w+)[\s\S]{0,2000}(?:with|has|contains|non-empty)/i,
    // Boundary pairing (above/below threshold)
    /(?:above|over|exceeds|greater)[\s\S]{0,2000}(?:below|under|less|within)/i,
  ];

  let dualCount = 0;
  for (const dp of dualPatterns) {
    if (dp.test(allContent)) dualCount++;
  }

  // Check coverage branch data if available
  let branchScore = 0;
  if (coverageData?.details) {
    const filesWithUncovered = coverageData.details.filter(
      (d) => d.uncoveredBranches?.length > 0,
    );
    const totalFiles = coverageData.details.length || 1;
    const coveredRatio = 1 - filesWithUncovered.length / totalFiles;
    branchScore = Math.round(coveredRatio * 50); // max 50 from coverage
  }

  const patternScore = Math.round(
    (dualCount / Math.max(dualPatterns.length, 1)) * 50,
  );
  const score = Math.min(100, branchScore + patternScore);

  return {
    score,
    dualConditionPatterns: dualCount,
    detail: `${dualCount} dual-condition patterns detected, branch coverage score: ${branchScore}`,
  };
}

// ──────── M5: Error Path Presence ────────

const ERROR_PATH_PATTERNS = [
  /\.toThrow/,
  /\.rejects\.toThrow/,
  /try\s*\{[\s\S]*\}\s*catch/,
  /expect\([^)]*error/i,
  /\.catch\s*\(/,
  /onError|onerror|handleError/i,
  /reject\s*\(/,
  /crashed.*(?:true|false)/i,
  /should.*(?:not.*crash|throw|error)/i,
  /graceful/i,
  /malformed|invalid|corrupt/i,
];

function computeM5(testBlocks) {
  if (testBlocks.length === 0) return { score: 0, detail: "No test blocks" };
  const allContent = testBlocks.map((b) => b.body).join("\n");
  let matchCount = 0;
  const present = [];
  for (let i = 0; i < ERROR_PATH_PATTERNS.length; i++) {
    if (ERROR_PATH_PATTERNS[i].test(allContent)) {
      matchCount++;
      present.push(i);
    }
  }
  const ratio = matchCount / ERROR_PATH_PATTERNS.length;
  const score = Math.min(100, Math.round(ratio * 100 * 2.5)); // diverse coverage = higher
  return {
    score,
    matchCount,
    totalPatterns: ERROR_PATH_PATTERNS.length,
    detail: `${matchCount}/${ERROR_PATH_PATTERNS.length} error-path patterns present`,
  };
}

// ──────── M6: Side-Effect Assertions ────────

const SIDE_EFFECT_PATTERNS = [
  /jest\.fn\s*\(/,
  /jest\.spyOn/,
  /sinon\.spy/,
  /sinon\.stub/,
  /\.toHaveBeenCalled/,
  /\.toHaveBeenCalledTimes/,
  /\.toHaveBeenCalledWith/,
  /mock\s*\(/i,
  /existsSync\s*\(/, // FS state validation
  /readFileSync\s*\(/, // File content validation
  /writeFileSync.*assert|assert.*writeFileSync/s,
  /JSON\.parse\s*\(\s*readFileSync/, // Read-back validation
];

function computeM6(testBlocks) {
  if (testBlocks.length === 0) return { score: 0, detail: "No test blocks" };
  const allContent = testBlocks.map((b) => b.body).join("\n");
  let matchCount = 0;
  const present = [];
  for (let i = 0; i < SIDE_EFFECT_PATTERNS.length; i++) {
    if (SIDE_EFFECT_PATTERNS[i].test(allContent)) {
      matchCount++;
      present.push(i);
    }
  }
  const ratio = matchCount / SIDE_EFFECT_PATTERNS.length;
  const score = Math.min(100, Math.round(ratio * 100 * 2));
  return {
    score,
    matchCount,
    totalPatterns: SIDE_EFFECT_PATTERNS.length,
    detail: `${matchCount}/${SIDE_EFFECT_PATTERNS.length} side-effect patterns present`,
  };
}

// ──────── Score Computation ────────

const WEIGHTS = {
  M1: 0.2,
  M2: 0.15,
  M3: 0.2,
  M4: 0.2,
  M5: 0.15,
  M6: 0.1,
};

function computeHPDScore(metrics) {
  const weighted =
    metrics.M1.score * WEIGHTS.M1 +
    metrics.M2.score * WEIGHTS.M2 +
    metrics.M3.score * WEIGHTS.M3 +
    metrics.M4.score * WEIGHTS.M4 +
    metrics.M5.score * WEIGHTS.M5 +
    metrics.M6.score * WEIGHTS.M6;
  return Math.round(weighted);
}

function classify(score) {
  if (score >= 75) return "Robust";
  if (score >= 60) return "Needs reinforcement";
  return "Happy-path dominant";
}

// ──────── Hard Rules (Instant Block) ────────

function checkHardRules(metrics) {
  const violations = [];
  if (metrics.M1.negativeCount === 0) {
    violations.push("0 tests negativos en módulo core");
  }
  if (metrics.M2.found === 0) {
    violations.push("0 boundary tests en módulo con condicional crítico");
  }
  if (metrics.M3.total > 0) {
    const noAssertRatio = metrics.M3.noAssertionCount / metrics.M3.total;
    if (noAssertRatio >= 0.2) {
      violations.push(
        `${Math.round(noAssertRatio * 100)}% tests sin assertions significativas (>= 20%)`,
      );
    }
  }
  if (metrics.M6.matchCount === 0 && metrics.M3.total > 0) {
    violations.push(
      "Módulo con dependencias externas sin verificación de interacción",
    );
  }
  return violations;
}

// ──────── HPD-Reflect Questions ────────

function generateReflectQuestions(metrics, score) {
  if (score >= 75) return [];
  const questions = [
    "¿Qué comportamiento incorrecto detectan estos tests?",
    "¿Qué mutación sobreviviría hoy?",
    "¿Qué test te da más miedo romper?",
  ];
  if (metrics.M1.score < 50) {
    questions.push(
      "¿Por qué hay tan pocos tests negativos? ¿El módulo nunca falla?",
    );
  }
  if (metrics.M2.score < 50) {
    questions.push("¿Estás testeando los valores límite de cada condicional?");
  }
  return questions;
}

// ──────── Main Gate ────────

/**
 * Run the HPD Gate analysis.
 *
 * @param {string} cwd - Project root
 * @param {{ enabled: boolean, mode: string, minScoreEnforce?: number, minScoreT4?: number }} config
 * @param {{ editedFiles?: string[], coverageData?: object, requestT4?: boolean }} opts
 * @returns {{ pass: boolean, blocking: boolean, score: number, classification: string, checks: object[], metrics: object, report: string }}
 */
export function runHPDGateHook(cwd, config = {}, opts = {}) {
  if (!config?.enabled) {
    return {
      pass: true,
      blocking: false,
      score: 100,
      classification: "Robust",
      checks: [],
      metrics: {},
      report: "",
    };
  }

  const isEnforce = config.mode === "enforce";
  const minScoreEnforce = config.minScoreEnforce ?? 50;
  const minScoreT4 = config.minScoreT4 ?? 65;

  // ── Should HPD run? Only if src/ or tests modified, or T4 requested
  if (!opts.requestT4) {
    const hasRelevantChanges = opts.editedFiles?.some(
      (f) => f.includes("src/") || f.includes("test") || f.includes("spec"),
    );
    if (!hasRelevantChanges) {
      return {
        pass: true,
        blocking: false,
        score: -1,
        classification: "Skipped",
        checks: [],
        metrics: {},
        report: "HPD skipped — no relevant changes",
      };
    }
  }

  // ── Discover test files
  const testFiles = findTestFiles(cwd);
  if (testFiles.length === 0) {
    const noTestsBlocking = isEnforce;
    return {
      pass: !noTestsBlocking,
      blocking: noTestsBlocking,
      score: 0,
      classification: "Happy-path dominant",
      checks: [
        {
          name: "hpd-no-tests",
          pass: false,
          blocking: noTestsBlocking,
          message: "No test files found in project",
        },
      ],
      metrics: {},
      report: "HPD: No test files discovered",
    };
  }

  // ── Extract test blocks
  const allBlocks = [];
  for (const tf of testFiles) {
    allBlocks.push(...extractTestBlocks(tf.content));
  }

  // ── Compute metrics
  const metrics = {
    M1: computeM1(allBlocks),
    M2: computeM2(allBlocks),
    M3: computeM3(allBlocks),
    M4: computeM4(allBlocks, opts.coverageData),
    M5: computeM5(allBlocks),
    M6: computeM6(allBlocks),
  };

  const score = computeHPDScore(metrics);
  const classification = classify(score);
  const hardViolations = checkHardRules(metrics);
  const reflectQuestions = generateReflectQuestions(metrics, score);

  // ── Build checks
  const checks = [];

  // Hard violations → instant block in enforce
  if (hardViolations.length > 0) {
    checks.push({
      name: "hpd-hard-violation",
      pass: false,
      blocking: isEnforce,
      message: `Hard rules violated: ${hardViolations.join("; ")}`,
    });
  }

  // Score check
  const scorePass = isEnforce ? score >= minScoreEnforce : true;
  checks.push({
    name: "hpd-score",
    pass: scorePass,
    blocking: isEnforce && !scorePass,
    message: `HPD Score: ${score}/100 (${classification})`,
  });

  // T4 readiness
  if (opts.requestT4) {
    const t4Ready = score >= minScoreT4;
    checks.push({
      name: "hpd-t4-ready",
      pass: t4Ready,
      blocking: !t4Ready,
      message: t4Ready
        ? `T4 habilitado (score ${score} >= ${minScoreT4})`
        : `T4 bloqueado (score ${score} < ${minScoreT4})`,
    });
  }

  // Warning zone
  if (isEnforce && score >= minScoreEnforce && score < 60) {
    checks.push({
      name: "hpd-warning",
      pass: true,
      blocking: false,
      message: `⚠️ HPD en zona de warning (score ${score}, 50-60)`,
    });
  }

  // Reflect injection
  if (reflectQuestions.length > 0) {
    checks.push({
      name: "hpd-reflect",
      pass: true,
      blocking: false,
      message: `Reflexión obligatoria:\n${reflectQuestions.map((q) => `  - ${q}`).join("\n")}`,
    });
  }

  const pass = checks.every((c) => c.pass || !c.blocking);
  const blocking = checks.some((c) => c.blocking);

  // ── Build report
  const reportLines = [
    `HPD Score: ${score}/100 — ${classification}`,
    `Test files: ${testFiles.length}, Test blocks: ${allBlocks.length}`,
    `M1 (Negative ratio): ${metrics.M1.score}/100 — ${metrics.M1.detail}`,
    `M2 (Boundary density): ${metrics.M2.score}/100 — ${metrics.M2.detail}`,
    `M3 (Assertion strength): ${metrics.M3.score}/100 — ${metrics.M3.detail}`,
    `M4 (Branch sensitivity): ${metrics.M4.score}/100 — ${metrics.M4.detail}`,
    `M5 (Error paths): ${metrics.M5.score}/100 — ${metrics.M5.detail}`,
    `M6 (Side-effects): ${metrics.M6.score}/100 — ${metrics.M6.detail}`,
  ];
  if (hardViolations.length > 0) {
    reportLines.push(`⛔ Hard violations: ${hardViolations.join("; ")}`);
  }

  return {
    pass,
    blocking,
    score,
    classification,
    checks,
    metrics,
    report: reportLines.join("\n"),
  };
}

// ── Test-only exports for adversarial testing ──
export const _testInternals = {
  classify,
  checkHardRules,
  computeHPDScore,
  findTestFiles,
  extractTestBlocks,
  STRONG_ASSERTION_PATTERNS,
  WEAK_ASSERTION_PATTERNS,
};
