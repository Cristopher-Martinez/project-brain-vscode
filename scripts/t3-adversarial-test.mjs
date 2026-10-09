/**
 * T3.5 Self-Adversarial Validation — Functional tests for Fast Gate pipeline.
 * Tests: gaming, churn, staleness, mode behavior, core protection.
 *
 * Usage: node scripts/t3-adversarial-test.mjs
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// Import fast gate functions from built static (synced from .github/hooks)
const fgPath = join(
  ROOT,
  ".github",
  "hooks",
  "scripts",
  "lib",
  "fast-gate-hook.mjs",
);
const { runFastGateHook, resetFastGateConvergence } = await import(
  `file://${fgPath.replace(/\\/g, "/")}`
);

// Import HPD gate for adversarial testing
const hpdPath = join(
  ROOT,
  ".github",
  "hooks",
  "scripts",
  "lib",
  "hpd-gate-hook.mjs",
);
const { runHPDGateHook, _testInternals } = await import(
  `file://${hpdPath.replace(/\\/g, "/")}`
);
const { classify, checkHardRules, computeHPDScore } = _testInternals;

// ──────── Helpers ────────

let scenarioCount = 0;
let passCount = 0;
let failCount = 0;
const failures = [];

function tmpDir(name) {
  const d = join(ROOT, ".test-adversarial", name);
  mkdirSync(join(d, ".brain-loops"), { recursive: true });
  return d;
}

function cleanup(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}

function assert(condition, msg) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function writeLcov(cwd, files) {
  const dir = join(cwd, "coverage");
  mkdirSync(dir, { recursive: true });
  let lcov = "";
  for (const f of files) {
    lcov += `SF:${f.file}\n`;
    if (f.branches) {
      for (const b of f.branches) {
        lcov += `BRDA:${b.line},${b.block},${b.branch},${b.hits}\n`;
      }
    }
    lcov += `BRF:${f.branchTotal || 0}\n`;
    lcov += `BRH:${f.branchHit || 0}\n`;
    lcov += `end_of_record\n`;
  }
  writeFileSync(join(dir, "lcov.info"), lcov);
  return join(dir, "lcov.info");
}

function writeContract(cwd, overrides = {}) {
  const contract = {
    cachedAt: Date.now(),
    testCommand: "npx vitest",
    lintCommand: null,
    ...overrides,
  };
  mkdirSync(join(cwd, ".brain-loops"), { recursive: true });
  writeFileSync(
    join(cwd, ".brain-loops", "test-contract.json"),
    JSON.stringify(contract),
  );
}

function writePkgJson(cwd, content = {}) {
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "test", ...content }),
  );
}

function writeSourceFile(cwd, relPath, content = "// source") {
  const fp = join(cwd, relPath);
  const dir = dirname(fp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fp, content);
  return fp;
}

function scenario(name, fn) {
  scenarioCount++;
  const dir = tmpDir(`s${scenarioCount}-${name}`);
  try {
    console.log(`\n── [${scenarioCount}] ${name} ──`);
    fn(dir);
    passCount++;
    console.log(`  ✅ PASS`);
  } catch (err) {
    failCount++;
    failures.push({ scenario: name, error: err.message });
    console.log(`  ⛔ FAIL: ${err.message}`);
  } finally {
    cleanup(dir);
  }
}

const baseConfig = {
  enabled: true,
  mode: "report",
  branchThreshold: 70,
  maxConvergenceIterations: 3,
  lintEscalationStrikes: 3,
  requireCoverage: false,
};

// ──────── Scenario 1: Gaming Simulation ────────

scenario("Gaming — superficial coverage increase", (cwd) => {
  writePkgJson(cwd);

  // Step 1: Create LCOV with one uncovered branch (50% coverage)
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "auth.ts"),
      branchTotal: 4,
      branchHit: 2,
      branches: [
        { line: 42, block: 0, branch: 0, hits: 1 },
        { line: 42, block: 0, branch: 1, hits: 0 },
        { line: 67, block: 1, branch: 0, hits: 1 },
        { line: 67, block: 1, branch: 1, hits: 0 },
      ],
    },
  ]);
  writeContract(cwd);

  const result1 = runFastGateHook(cwd, { ...baseConfig, mode: "report" });
  assert(!result1.blocking, "Report mode should not block");
  const coverageCheck = result1.checks.find(
    (c) => c.name === "branch-coverage",
  );
  assert(
    coverageCheck && !coverageCheck.pass,
    "50% should be below 70% threshold",
  );

  // Step 2: Create better LCOV (75% coverage)
  resetFastGateConvergence(cwd);
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "auth.ts"),
      branchTotal: 4,
      branchHit: 3,
      branches: [
        { line: 42, block: 0, branch: 0, hits: 1 },
        { line: 42, block: 0, branch: 1, hits: 1 },
        { line: 67, block: 1, branch: 0, hits: 1 },
        { line: 67, block: 1, branch: 1, hits: 0 },
      ],
    },
  ]);

  const result2 = runFastGateHook(cwd, { ...baseConfig, mode: "report" });
  const coverageCheck2 = result2.checks.find(
    (c) => c.name === "branch-coverage",
  );
  assert(
    coverageCheck2 && coverageCheck2.pass,
    "75% should pass 70% threshold",
  );

  // Convergence should NOT have triggered
  const convergenceCheck = result2.checks.find(
    (c) => c.name === "convergence-limit",
  );
  assert(!convergenceCheck, "Convergence should NOT trigger when checks pass");

  // Verify branch granularity was in first result
  const detailCheck = result1.checks.find(
    (c) => c.name === "branch-coverage-detail",
  );
  assert(detailCheck, "Should have branch-coverage-detail check");
  assert(
    detailCheck.message.includes("branch-uncovered:"),
    "Should include granular branch IDs",
  );
});

// ──────── Scenario 2: Churn Simulation ────────

scenario("Churn — net-fail detection + convergence limit", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  const enforceConfig = { ...baseConfig, mode: "enforce", branchThreshold: 70 };

  // Iteration 1: 2 branches uncovered (50%)
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "a.ts"),
      branchTotal: 4,
      branchHit: 2,
      branches: [
        { line: 10, block: 0, branch: 0, hits: 1 },
        { line: 10, block: 0, branch: 1, hits: 0 },
        { line: 20, block: 1, branch: 0, hits: 1 },
        { line: 20, block: 1, branch: 1, hits: 0 },
      ],
    },
  ]);
  const r1 = runFastGateHook(cwd, enforceConfig);
  assert(r1.blocking, "Iteration 1: should block (50% < 70%)");

  // Iteration 2: Fix branch L10 but introduce new branch L30 (still 50%)
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "a.ts"),
      branchTotal: 4,
      branchHit: 2,
      branches: [
        { line: 10, block: 0, branch: 0, hits: 1 },
        { line: 10, block: 0, branch: 1, hits: 1 }, // fixed!
        { line: 20, block: 1, branch: 0, hits: 1 },
        { line: 30, block: 2, branch: 0, hits: 0 }, // new uncovered!
      ],
    },
  ]);
  const r2 = runFastGateHook(cwd, enforceConfig);
  assert(r2.blocking, "Iteration 2: should still block (50% < 70%)");

  // Iteration 3: Same situation (still 50%) → convergence should trigger
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "a.ts"),
      branchTotal: 4,
      branchHit: 2,
      branches: [
        { line: 10, block: 0, branch: 0, hits: 1 },
        { line: 10, block: 0, branch: 1, hits: 1 },
        { line: 30, block: 2, branch: 0, hits: 1 }, // fixed!
        { line: 40, block: 3, branch: 0, hits: 0 }, // new uncovered!
      ],
    },
  ]);
  const r3 = runFastGateHook(cwd, enforceConfig);
  const convergence = r3.checks.find((c) => c.name === "convergence-limit");
  assert(convergence, "Iteration 3: convergence-limit should trigger");
  assert(convergence.blocking, "convergence-limit should be blocking");
});

// ──────── Scenario 3: Coverage Stale ────────

scenario("Coverage stale — freshness detection", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  // Create coverage file
  const lcovPath = writeLcov(cwd, [
    {
      file: join(cwd, "src", "foo.ts"),
      branchTotal: 10,
      branchHit: 8,
      branches: [],
    },
  ]);

  // Set coverage mtime to 1 hour ago
  const oldTime = new Date(Date.now() - 3600 * 1000);
  utimesSync(lcovPath, oldTime, oldTime);

  // Create a source file that is NEWER than coverage
  const srcPath = writeSourceFile(
    cwd,
    "src/foo.ts",
    "// modified after coverage",
  );

  // Run with editedFiles
  resetFastGateConvergence(cwd);
  const result = runFastGateHook(
    cwd,
    { ...baseConfig, mode: "enforce" },
    {
      editedFiles: ["src/foo.ts"],
    },
  );

  const staleCheck = result.checks.find((c) => c.name === "coverage-stale");
  assert(staleCheck, "Should detect coverage-stale");
  assert(staleCheck.blocking, "coverage-stale should block in enforce mode");
  assert(staleCheck.message.includes("stale"), "Message should mention stale");
});

// ──────── Scenario 4: Report vs Enforce ────────

scenario("Report vs Enforce — mode behavior", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  // Create low coverage (40%)
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "low.ts"),
      branchTotal: 10,
      branchHit: 4,
      branches: [
        { line: 5, block: 0, branch: 0, hits: 0 },
        { line: 10, block: 1, branch: 0, hits: 0 },
      ],
    },
  ]);

  // Test REPORT mode
  resetFastGateConvergence(cwd);
  const reportResult = runFastGateHook(cwd, { ...baseConfig, mode: "report" });
  assert(!reportResult.blocking, "Report mode must NOT block");
  assert(reportResult.pass, "Report mode must pass (no blocking checks)");
  const reportCov = reportResult.checks.find(
    (c) => c.name === "branch-coverage",
  );
  assert(reportCov && !reportCov.pass, "Coverage check must fail (40% < 70%)");
  assert(
    !reportCov.blocking,
    "Coverage check must NOT be blocking in report mode",
  );

  // Test ENFORCE mode
  resetFastGateConvergence(cwd);
  const enforceResult = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
  });
  assert(enforceResult.blocking, "Enforce mode MUST block");
  assert(!enforceResult.pass, "Enforce mode must NOT pass");
  const enforceCov = enforceResult.checks.find(
    (c) => c.name === "branch-coverage",
  );
  assert(
    enforceCov && !enforceCov.pass,
    "Coverage check must fail (40% < 70%)",
  );
  assert(
    enforceCov.blocking,
    "Coverage check MUST be blocking in enforce mode",
  );
});

// ──────── Scenario 5: requireCoverage policy ────────

scenario("Missing coverage with requireCoverage policy", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd, { testCommand: "npx vitest" });
  // NO coverage file created

  // Test with requireCoverage: false (default)
  resetFastGateConvergence(cwd);
  const r1 = runFastGateHook(cwd, { ...baseConfig, requireCoverage: false });
  const missing1 = r1.checks.find((c) => c.name === "coverage-missing");
  assert(
    !missing1,
    "requireCoverage=false should NOT produce coverage-missing check",
  );

  // Test with requireCoverage: true
  resetFastGateConvergence(cwd);
  const r2 = runFastGateHook(cwd, { ...baseConfig, requireCoverage: true });
  const missing2 = r2.checks.find((c) => c.name === "coverage-missing");
  assert(
    missing2,
    "requireCoverage=true should produce coverage-missing check",
  );
  assert(!missing2.pass, "coverage-missing should fail");

  // In report mode, should NOT block
  assert(
    !missing2.blocking,
    "coverage-missing should NOT block in report mode",
  );

  // In enforce mode, should block
  resetFastGateConvergence(cwd);
  const r3 = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    requireCoverage: true,
  });
  const missing3 = r3.checks.find((c) => c.name === "coverage-missing");
  assert(
    missing3 && missing3.blocking,
    "coverage-missing should block in enforce mode",
  );
});

// ──────── Scenario 6: Package hash invalidation ────────

scenario("Contract invalidation on package.json change", (cwd) => {
  // Create contract with specific package hash
  const pkg1 = {
    name: "test-pkg",
    version: "1.0.0",
    dependencies: { lodash: "^4.0.0" },
  };
  writePkgJson(cwd, pkg1);

  // Create contract (will read current package.json hash)
  // We need to manually set packageHash since writeContract doesn't compute it
  const hash1 = createHash("sha256")
    .update(JSON.stringify({ name: "test", ...pkg1 }))
    .digest("hex")
    .slice(0, 16);
  writeContract(cwd, { packageHash: hash1 });

  // Write coverage — with valid contract, this should produce results
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "x.ts"),
      branchTotal: 10,
      branchHit: 9,
      branches: [],
    },
  ]);

  resetFastGateConvergence(cwd);
  const r1 = runFastGateHook(cwd, { ...baseConfig });
  const cov1 = r1.checks.find((c) => c.name === "branch-coverage");
  assert(cov1, "Should have coverage check with valid contract");

  // Now change package.json → hash should invalidate contract
  const pkg2 = {
    name: "test-pkg",
    version: "2.0.0",
    dependencies: { lodash: "^5.0.0" },
  };
  writePkgJson(cwd, pkg2);

  // Contract still has old hash → readContract should return null
  // This means no lintCommand available (contract stale)
  // Coverage still works (it reads files directly, not through contract)
  resetFastGateConvergence(cwd);
  const r2 = runFastGateHook(cwd, { ...baseConfig });
  // Contract is stale, so lintCommand would be null → no lint check
  // But coverage still works
  const cov2 = r2.checks.find((c) => c.name === "branch-coverage");
  assert(cov2, "Coverage should still work even with stale contract");

  // The key test: if requireCoverage is true AND contract is stale,
  // the contract check should NOT find a testCommand (contract returns null)
  resetFastGateConvergence(cwd);
  const r3 = runFastGateHook(cwd, { ...baseConfig, requireCoverage: true });
  const missing = r3.checks.find((c) => c.name === "coverage-missing");
  // Contract is null → no testCommand → requireCoverage check doesn't trigger
  assert(
    !missing,
    "coverage-missing should NOT trigger when contract is stale (no testCommand available)",
  );
});

// ════════ HPD-1 Gap Fixes: Boundary, Edge, Side-Effect, Mutation-Kill ════════

// ──────── Scenario 7: Exact Threshold Boundary ────────
scenario("Boundary-exact-threshold-mutation-kill", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  // 70% coverage = exactly at branchThreshold=70 → should PASS (>= not >)
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "edge.ts"),
      branchTotal: 10,
      branchHit: 7,
      branches: [],
    },
  ]);
  resetFastGateConvergence(cwd);
  const r = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    branchThreshold: 70,
  });
  const cov = r.checks.find((c) => c.name === "branch-coverage");
  assert(cov, "Should have branch-coverage check");
  assert(cov.pass, "70% === threshold 70% must PASS (>= boundary)");
  assert(!r.blocking, "Exact threshold must NOT block");

  // 69% → should FAIL (just below threshold — uses branchTotal:100 to avoid rounding)
  resetFastGateConvergence(cwd);
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "edge.ts"),
      branchTotal: 100,
      branchHit: 69,
      branches: [],
    },
  ]);
  const r2 = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    branchThreshold: 70,
  });
  const cov2 = r2.checks.find((c) => c.name === "branch-coverage");
  assert(cov2 && !cov2.pass, "69% must FAIL against 70% threshold");
  assert(r2.blocking, "Just below threshold must block in enforce");
});

// ──────── Scenario 8: Disabled Config — early return ────────
scenario("Disabled-config-early-return", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "x.ts"),
      branchTotal: 10,
      branchHit: 1,
      branches: [],
    },
  ]);

  // enabled: false → should short-circuit
  const r = runFastGateHook(cwd, { ...baseConfig, enabled: false });
  assert(r.pass === true, "Disabled gate must return pass=true");
  assert(r.blocking === false, "Disabled gate must NOT block");
  assert(
    !r.checks || r.checks.length === 0,
    "Disabled gate must have 0 checks",
  );
});

// ──────── Scenario 9: Edge Cases — empty/null/malformed ────────
scenario("Edge-cases-empty-no-coverage-no-contract", (cwd) => {
  writePkgJson(cwd);

  // No contract, no coverage → gate should still return a valid result
  resetFastGateConvergence(cwd);
  const r1 = runFastGateHook(cwd, { ...baseConfig, mode: "enforce" });
  assert(
    r1 !== null && r1 !== undefined,
    "Must return object even with no coverage/contract",
  );
  assert(typeof r1.pass === "boolean", "Must have boolean pass");

  // Empty editedFiles array → freshness check should not crash
  writeContract(cwd);
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "ok.ts"),
      branchTotal: 10,
      branchHit: 8,
      branches: [],
    },
  ]);
  resetFastGateConvergence(cwd);
  const r2 = runFastGateHook(
    cwd,
    { ...baseConfig, mode: "enforce" },
    { editedFiles: [] },
  );
  assert(r2 !== null, "Empty editedFiles must not crash");
  const stale = r2.checks.find((c) => c.name === "coverage-stale");
  assert(!stale, "Empty editedFiles should NOT produce coverage-stale");
});

// ──────── Scenario 10: Extreme Values — 0%, 100%, threshold extremes ────────
scenario("Extreme-values-0-100-threshold-extremes", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  // 0% coverage with threshold 70 → must fail
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "zero.ts"),
      branchTotal: 10,
      branchHit: 0,
      branches: [],
    },
  ]);
  resetFastGateConvergence(cwd);
  const r0 = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    branchThreshold: 70,
  });
  const cov0 = r0.checks.find((c) => c.name === "branch-coverage");
  assert(cov0 && !cov0.pass, "0% must fail 70% threshold");

  // 100% coverage → must pass any threshold
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "perfect.ts"),
      branchTotal: 10,
      branchHit: 10,
      branches: [],
    },
  ]);
  resetFastGateConvergence(cwd);
  const r100 = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    branchThreshold: 100,
  });
  const cov100 = r100.checks.find((c) => c.name === "branch-coverage");
  assert(cov100 && cov100.pass, "100% must pass even with threshold=100");

  // threshold=0 → everything passes
  resetFastGateConvergence(cwd);
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "zero.ts"),
      branchTotal: 10,
      branchHit: 0,
      branches: [],
    },
  ]);
  const rT0 = runFastGateHook(cwd, {
    ...baseConfig,
    mode: "enforce",
    branchThreshold: 0,
  });
  const covT0 = rT0.checks.find((c) => c.name === "branch-coverage");
  assert(
    covT0 && covT0.pass,
    "0% coverage must pass with threshold=0 (0 >= 0)",
  );
});

// ──────── Scenario 11: Side Effects — convergence persistence ────────
scenario("Side-effects-convergence-persistence", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);
  const convPath = join(cwd, ".brain-loops", "fast-gate-convergence.json");

  // Run with failing coverage → convergence file MUST be written
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "a.ts"),
      branchTotal: 10,
      branchHit: 2,
      branches: [],
    },
  ]);
  resetFastGateConvergence(cwd);
  runFastGateHook(cwd, { ...baseConfig, mode: "enforce" });
  assert(
    existsSync(convPath),
    "Convergence file must be written after failing check",
  );

  // Verify convergence content is valid JSON with expected shape
  const convData = JSON.parse(readFileSync(convPath, "utf8"));
  assert(
    typeof convData.iteration === "number",
    "Convergence must have numeric iteration",
  );
  assert(convData.iteration === 1, "First iteration should be 1");
  assert(
    typeof convData.startedAt === "string",
    "Convergence must have startedAt",
  );

  // Run with PASSING coverage → convergence-limit must NOT trigger
  writeLcov(cwd, [
    {
      file: join(cwd, "src", "a.ts"),
      branchTotal: 10,
      branchHit: 10,
      branches: [],
    },
  ]);
  const r2 = runFastGateHook(cwd, { ...baseConfig, mode: "enforce" });
  assert(r2.pass, "100% coverage must pass");
  const conv2 = r2.checks.find((c) => c.name === "convergence-limit");
  assert(!conv2, "Convergence-limit must NOT trigger when all checks pass");
});

// ──────── Scenario 12: Malformed LCOV — graceful degradation ────────
scenario("Malformed-LCOV-graceful-degradation", (cwd) => {
  writePkgJson(cwd);
  writeContract(cwd);

  // Write garbage as LCOV
  const dir = join(cwd, "coverage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lcov.info"),
    "THIS_IS_NOT_VALID_LCOV\nRANDOM GARBAGE\n",
  );

  resetFastGateConvergence(cwd);
  let crashed = false;
  try {
    const r = runFastGateHook(cwd, { ...baseConfig, mode: "enforce" });
    assert(
      r !== null && r !== undefined,
      "Must return result even with malformed LCOV",
    );
  } catch (err) {
    crashed = true;
  }
  assert(!crashed, "Malformed LCOV must NOT crash the gate");
});

// ════════ IDP-1: HPD Gate Adversarial Tests ════════

// S13 — Hard-rule inversion: HPD must block when 0 negative tests exist
scenario("HPD-hard-rule-zero-negative-blocks", (cwd) => {
  // Create a test file with ONLY positive assertions, zero negative patterns
  const testDir = join(cwd, "src", "test");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "happy.test.ts"), [
    'it("returns valid data", () => {',
    '  const result = getData();',
    '  expect(result).toEqual({ ok: true });',
    '});',
    'it("computes correctly", () => {',
    '  expect(compute(2, 3)).toBe(5);',
    '});',
    'it("formats output", () => {',
    '  expect(format("hello")).toContain("HELLO");',
    '});',
  ].join("\n"));

  const hpdResult = runHPDGateHook(cwd, {
    enabled: true,
    mode: "enforce",
    minScoreEnforce: 50,
    minScoreT4: 65,
  }, { editedFiles: ["src/test/happy.test.ts"] });

  // Must detect hard rule violation: 0 negative tests
  assert(
    hpdResult.metrics?.M1?.negativeCount === 0,
    `Expected 0 negative tests, got ${hpdResult.metrics?.M1?.negativeCount}`
  );
  assert(
    hpdResult.blocking === true,
    "HPD must BLOCK when 0 negative tests (hard rule violation)"
  );

  // Verify the checkHardRules function directly
  const violations = checkHardRules({
    M1: { negativeCount: 0, total: 3 },
    M2: { found: 0, total: 8 },
    M3: { noAssertionCount: 0, total: 3 },
    M6: { matchCount: 0, totalPatterns: 12 },
  });
  assert(
    violations.length > 0,
    "checkHardRules must flag 0 negative tests"
  );
  assert(
    violations.some(v => v.includes("negativ")),
    "Hard violation must mention negative tests"
  );

  // Verify inversion: if negativeCount > 0, no violation for that rule
  const noViolation = checkHardRules({
    M1: { negativeCount: 5, total: 100 },
    M2: { found: 3, total: 8 },
    M3: { noAssertionCount: 5, total: 100 },
    M6: { matchCount: 3, totalPatterns: 12 },
  });
  const negativeViolation = noViolation.some(v => v.includes("negative"));
  assert(!negativeViolation, "No negative-test violation when negativeCount > 0");
});

// S14 — Classification boundary inversion: verify exact classification at boundaries
scenario("HPD-classification-boundary-exact", (_cwd) => {
  // Test classify() at exact boundaries: 75, 60, and just below
  assert(classify(75) === "Robust", `classify(75) should be Robust, got ${classify(75)}`);
  assert(classify(74) === "Needs reinforcement", `classify(74) should be Needs reinforcement, got ${classify(74)}`);
  assert(classify(60) === "Needs reinforcement", `classify(60) should be Needs reinforcement, got ${classify(60)}`);
  assert(classify(59) === "Happy-path dominant", `classify(59) should be Happy-path dominant, got ${classify(59)}`);
  assert(classify(100) === "Robust", `classify(100) should be Robust, got ${classify(100)}`);
  assert(classify(0) === "Happy-path dominant", `classify(0) should be Happy-path dominant, got ${classify(0)}`);

  // Test computeHPDScore with controlled metrics
  const metrics = {
    M1: { score: 80 },
    M2: { score: 100 },
    M3: { score: 100 },
    M4: { score: 60 },
    M5: { score: 100 },
    M6: { score: 100 },
  };
  // Weighted: M1*0.20=16, M2*0.15=15, M3*0.20=20, M4*0.20=12, M5*0.15=15, M6*0.10=10 = 88
  const score = computeHPDScore(metrics);
  assert(score === 88, `Expected score 88 from controlled metrics, got ${score}`);

  // Verify boundary score >= vs > behavior at threshold
  // A score of exactly 75 should classify as Robust (>=, not just >)
  const boundaryClassification = classify(computeHPDScore({
    M1: { score: 75 },
    M2: { score: 75 },
    M3: { score: 75 },
    M4: { score: 75 },
    M5: { score: 75 },
    M6: { score: 75 },
  }));
  assert(
    boundaryClassification === "Robust",
    `All-75 metrics should classify as Robust (score=75), got ${boundaryClassification}`
  );

  // All-0 should be Happy-path dominant
  assert(
    classify(computeHPDScore({
      M1: { score: 0 },
      M2: { score: 0 },
      M3: { score: 0 },
      M4: { score: 0 },
      M5: { score: 0 },
      M6: { score: 0 },
    })) === "Happy-path dominant",
    "All-0 metrics should classify as Happy-path dominant"
  );
});

// ──────── Final Report ────────

console.log("\n══════════════════════════════════");
console.log(
  `  RESULTS: ${passCount}/${scenarioCount} passed, ${failCount} failed`,
);
if (failures.length > 0) {
  console.log("\n  FAILURES:");
  for (const f of failures) {
    console.log(`    ⛔ ${f.scenario}: ${f.error}`);
  }
}
console.log("══════════════════════════════════\n");

// Cleanup test root
cleanup(join(ROOT, ".test-adversarial"));

process.exit(failCount > 0 ? 1 : 0);
