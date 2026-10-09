#!/usr/bin/env node
/**
 * T5 + T5-EL End-to-End Validation Script
 *
 * Validates the COMPLETE mutation testing pipeline:
 * 1. Behavioral bug introduction + detection
 * 2. T5 mutation engine execution
 * 3. T5-EL evolution layer (scoring, trends, baselines, policy)
 * 4. Anti-tampering (checksum, artifact corruption)
 * 5. File integrity (no dirty state)
 * 6. Determinism (2 runs = same result)
 *
 * Uses REAL compiled modules with DI-based deps wired to
 * in-memory filesystem + controlled test runner.
 */

import fs from "fs";
import path from "path";

// ——— Import compiled modules ——————————————————————————————

const { runT5MutationGate } = await import("../dist/test-gate-mutation.js");
const { runT5EvolutionLayer, verifyIntegrity } =
  await import("../dist/test-gate-mutation-el.js");
const { parseMutableNodes, validateSyntax, computeHash } =
  await import("../dist/test-gate-mutation-ast.js");
const {
  isValidArtifact,
  computeBaselineChecksum,
  loadBaseline,
  saveBaseline,
  buildArtifact,
  saveArtifact,
  loadHistory,
  loadRecentHistory,
} = await import("../dist/test-gate-mutation-el-persistence.js");

// ——— Test Infrastructure ——————————————————————————————————

const TEMP_DIR = path.join(process.cwd(), ".t5-e2e-temp");
const HISTORY_DIR = path.join(TEMP_DIR, ".mutation-history");
const BASELINE_PATH = path.join(TEMP_DIR, ".mutation-baseline.json");

let testResults = [];
let currentTest = "";
const logs = [];

function logMsg(msg) {
  logs.push(msg);
}

function assert(condition, message) {
  if (!condition) {
    testResults.push({ test: currentTest, passed: false, message });
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    testResults.push({ test: currentTest, passed: false, message: msg });
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function pass(extra = "") {
  testResults.push({ test: currentTest, passed: true, message: extra });
}

function section(name) {
  currentTest = name;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`▶ ${name}`);
  console.log("═".repeat(60));
}

// ——— Cleanup ——————————————————————————————————————————————

function cleanup() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// ——— Source File: Target for mutation ————————————————————

// This simulates a "core module" with a boundary validation bug (>= → >)
const ORIGINAL_SOURCE = `
/**
 * Validates that a score meets the minimum threshold.
 * @param score - The score to validate  
 * @param threshold - Minimum acceptable score
 * @returns true if score meets threshold
 */
export function validateScore(score: number, threshold: number): boolean {
  if (typeof score !== 'number' || !isFinite(score)) {
    return false;
  }
  return score >= threshold;
}

export function clampValue(value: number, min: number, max: number): number {
  if (value < min) { return min; }
  if (value > max) { return max; }
  return value;
}

export function calculatePercentage(part: number, total: number): number {
  if (total === 0) { return 0; }
  return (part / total) * 100;
}
`.trim();

// Buggy version: >= changed to > (boundary error)
const BUGGY_SOURCE = ORIGINAL_SOURCE.replace(
  "score >= threshold",
  "score > threshold",
);

const TARGET_FILE = "src/score-validator.ts";

// ——— Build T5 Deps (DI) ——————————————————————————————————

function buildT5Deps(source, testBehavior = "kill-all") {
  const inMemoryFS = new Map();
  inMemoryFS.set(TARGET_FILE, source);

  return {
    readFile: async (p) => inMemoryFS.get(p) || "",
    writeFile: async (p, content) => {
      inMemoryFS.set(p, content);
    },

    runTests: async (targetFile) => {
      // Behavior controls how tests respond to mutations
      // TestRunResult: { passed, failed, testName?, error?, durationMs }
      switch (testBehavior) {
        case "kill-all":
          return {
            passed: false,
            failed: true,
            testName: "mutation-detector",
            durationMs: 50,
          };
        case "survive-all":
          return { passed: true, failed: false, durationMs: 30 };
        case "kill-boundary-only":
          return {
            passed: false,
            failed: true,
            testName: "boundary-check",
            durationMs: 40,
          };
        default:
          return { passed: true, failed: false, durationMs: 20 };
      }
    },

    getComplexity: async () => 5,
    getCoreModules: () => [TARGET_FILE],
    getModifiedFiles: () => [TARGET_FILE],
    getInvariantFiles: () => [],
    log: logMsg,
    parseMutableNodes: (content, filePath) =>
      parseMutableNodes(content, filePath),
    validateSyntax: (content, filePath) => validateSyntax(content, filePath),
    computeHash: (content) => computeHash(content),

    // Expose for integrity verification
    _fs: inMemoryFS,
  };
}

// ——— Build T5-EL Deps (DI) ———————————————————————————————

function buildT5ELDeps(commitHash = "abc123def456") {
  return {
    readFile: async (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
    },
    listDir: async (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    getCommitHash: async () => commitHash,
    getBranch: async () => "master",
    getT4PassStreak: async () => 10,
    restoreFile: async () => false,
    deleteFile: async (p) => {
      try {
        fs.unlinkSync(p);
      } catch {}
    },
    log: logMsg,
  };
}

// ——— T5 Config (enforce mode) ————————————————————————————

const T5_CONFIG = {
  globalMinScore: 65,
  coreModuleMinScore: 55,
  maxMutantsPerFile: 30,
  maxTotalMutantsPerRun: 100,
  mutationTimeoutMs: 5000,
  equivalentTolerance: 0.15,
  complexityPenaltyEnabled: true,
  tiers: ["Tier1", "Tier2"],
  mode: "enforce",
};

const T5EL_CONFIG = {
  mode: "enforce",
  historyDir: HISTORY_DIR,
  baselinePath: BASELINE_PATH,
  globalMinScore: 65,
  coreMinScore: 55,
  maturityWindowSize: 5,
  maturityMinAvgScore: 70,
  maturityMinT4Streak: 5,
  maxHistoryEntries: 100,
  minMutationVolume: 30,
};

// ═══════════════════════════════════════════════════════════
// SCENARIO 1: Bug detection — tests kill mutant (healthy state)
// ═══════════════════════════════════════════════════════════

async function scenario1_healthyMutationKilling() {
  section("SCENARIO 1: Healthy state — tests kill all mutants");

  const deps = buildT5Deps(ORIGINAL_SOURCE, "kill-all");
  const result = await runT5MutationGate(
    { t4Passed: true, hpdScore: 80 },
    deps,
    T5_CONFIG,
  );

  console.log(`  Total mutants: ${result.totalMutants}`);
  console.log(`  Killed: ${result.killed}`);
  console.log(`  Survived: ${result.survived}`);
  console.log(`  Raw score: ${result.rawGlobalScore}%`);
  console.log(`  Adjusted score: ${result.globalScore}%`);
  console.log(`  Passed: ${result.passed}`);
  console.log(`  Hash verified: ${result.hashVerified}`);

  assert(result.totalMutants > 0, "Must generate mutants");
  assert(result.killed > 0, "Must kill mutants");
  assertEqual(result.survived, 0, "Survived");
  assert(result.rawGlobalScore === 100, "Raw score should be 100%");
  assert(result.passed === true, "Should pass");
  assert(result.hashVerified === true, "Hash must be verified");
  assert(result.criticalSurvivors.length === 0, "No critical survivors");

  pass(
    `${result.totalMutants} mutants, all killed, score=${result.globalScore}%`,
  );
  return result;
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 2: Bug survives — T5 detects critical mutant
// ═══════════════════════════════════════════════════════════

async function scenario2_survivingMutant() {
  section("SCENARIO 2: Behavioral bug — mutant SURVIVES (tests too weak)");

  // Use buggy source, tests pass everything = mutants survive
  const deps = buildT5Deps(BUGGY_SOURCE, "survive-all");
  const result = await runT5MutationGate(
    { t4Passed: true, hpdScore: 80 },
    deps,
    T5_CONFIG,
  );

  console.log(`  Total mutants: ${result.totalMutants}`);
  console.log(`  Killed: ${result.killed}`);
  console.log(`  Survived: ${result.survived}`);
  console.log(`  Raw score: ${result.rawGlobalScore}%`);
  console.log(`  Adjusted score: ${result.globalScore}%`);
  console.log(`  Passed: ${result.passed}`);
  console.log(`  Critical survivors: ${result.criticalSurvivors.length}`);
  console.log(`  Hash verified: ${result.hashVerified}`);

  assert(result.survived > 0, "Mutants must survive");
  assert(result.rawGlobalScore < 100, "Score must be below 100%");
  assert(result.passed === false, "Should BLOCK (enforce mode)");
  assert(result.blocking === true, "Must be blocking");
  assert(result.hashVerified === true, "Hash must still be verified");

  // Critical survivors = Tier1 mutations in core modules that survived
  if (result.criticalSurvivors.length > 0) {
    console.log(`  ⚠️ Critical survivor examples:`);
    for (const cs of result.criticalSurvivors.slice(0, 3)) {
      console.log(`    - ${cs.mutant.id} (${cs.mutant.operator.name})`);
    }
  }

  pass(
    `${result.survived} survivors, score=${result.rawGlobalScore}%, BLOCKED as expected`,
  );
  return result;
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 3: T5-EL — Artifact persistence + history
// ═══════════════════════════════════════════════════════════

async function scenario3_artifactPersistence(t5Result) {
  section("SCENARIO 3: T5-EL artifact persistence (.mutation-history/)");

  const commit = "e2etest_abc123";
  const elDeps = buildT5ELDeps(commit);

  const finalResult = await runT5EvolutionLayer(
    t5Result,
    [TARGET_FILE],
    elDeps,
    T5EL_CONFIG,
  );

  console.log(`  Mode: ${finalResult.mode}`);
  console.log(`  Policy applied: ${finalResult.policyApplied}`);
  console.log(`  Raw score: ${finalResult.rawScore}`);
  console.log(`  Adjusted score: ${finalResult.adjustedScore}`);
  console.log(`  Trend: ${finalResult.trend}`);
  console.log(`  Maturity: ${finalResult.maturityLevel}`);
  console.log(`  Blocking: ${finalResult.blocking}`);
  console.log(`  Blocking reason: ${finalResult.blockingReason}`);
  console.log(`  History integrity: ${finalResult.historyIntegrity}`);
  console.log(`  Hash verified: ${finalResult.hashVerified}`);
  console.log(`  Policy consistent: ${finalResult.policyConsistent}`);

  // Verify artifact was saved to disk
  const artifactPath = path.join(HISTORY_DIR, `${commit}.json`);
  assert(fs.existsSync(artifactPath), `Artifact must exist at ${artifactPath}`);

  const savedArtifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assertEqual(savedArtifact.commit, commit, "Artifact commit");
  assert(
    typeof savedArtifact.rawScore === "number",
    "Artifact must have rawScore",
  );
  assert(
    typeof savedArtifact.adjustedScore === "number",
    "Artifact must have adjustedScore",
  );
  assert(
    typeof savedArtifact.timestamp === "string",
    "Artifact must have timestamp",
  );
  assert(
    isValidArtifact(savedArtifact),
    "Artifact must pass isValidArtifact()",
  );

  console.log(`  ✅ Artifact saved: ${artifactPath}`);
  console.log(`  ✅ Artifact valid: isValidArtifact() = true`);

  pass(
    `Artifact persisted at ${commit}.json, rawScore=${savedArtifact.rawScore}`,
  );
  return finalResult;
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 4: T5-EL Scoring — rawScore + adjustedScore
// ═══════════════════════════════════════════════════════════

async function scenario4_scoring(t5ResultHealthy, t5ResultBuggy) {
  section("SCENARIO 4: T5-EL scoring — rawScore + adjustedScore calculation");

  // Run EL for healthy result
  const commit1 = "e2e_healthy_001";
  const elDeps1 = buildT5ELDeps(commit1);
  const healthyFinal = await runT5EvolutionLayer(
    t5ResultHealthy,
    [TARGET_FILE],
    elDeps1,
    T5EL_CONFIG,
  );

  console.log(
    `  Healthy: raw=${healthyFinal.rawScore}, adj=${healthyFinal.adjustedScore}`,
  );

  // Run EL for buggy result
  const commit2 = "e2e_buggy_002";
  const elDeps2 = buildT5ELDeps(commit2);
  const buggyFinal = await runT5EvolutionLayer(
    t5ResultBuggy,
    [TARGET_FILE],
    elDeps2,
    T5EL_CONFIG,
  );

  console.log(
    `  Buggy:   raw=${buggyFinal.rawScore}, adj=${buggyFinal.adjustedScore}`,
  );

  // Healthy should score higher
  assert(
    healthyFinal.rawScore > buggyFinal.rawScore,
    "Healthy rawScore > Buggy rawScore",
  );
  assert(
    healthyFinal.adjustedScore > buggyFinal.adjustedScore,
    "Healthy adjScore > Buggy adjScore",
  );

  // Buggy should be blocking in enforce mode
  assert(buggyFinal.blocking === true, "Buggy must be blocking in enforce");
  assert(buggyFinal.blockingReason !== null, "Must have blocking reason");
  console.log(`  Buggy blocking reason: ${buggyFinal.blockingReason}`);

  pass(
    `Healthy=${healthyFinal.adjustedScore}% > Buggy=${buggyFinal.adjustedScore}%`,
  );
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 5: Trend + Maturity computation
// ═══════════════════════════════════════════════════════════

async function scenario5_trendAndMaturity() {
  section("SCENARIO 5: Trend + Maturity computation");

  // Create a history of improving scores
  for (let i = 1; i <= 6; i++) {
    const successRate = 60 + i * 5; // 65, 70, 75, 80, 85, 90
    const totalMutants = 40;
    const killed = Math.round((totalMutants * successRate) / 100);
    const survived = totalMutants - killed;

    const fakeResult = {
      name: "mutation-testing",
      passed: true,
      blocking: false,
      skipped: false,
      globalScore: successRate,
      rawGlobalScore: successRate + 2,
      moduleScores: [
        {
          file: TARGET_FILE,
          rawScore: successRate + 2,
          complexity: 5,
          penalty: 0.03,
          adjustedScore: successRate,
          killed,
          survived,
          timeout: 0,
          equivalentExcluded: 0,
          invalid: 0,
          totalMutants,
        },
      ],
      totalMutants,
      killed,
      survived,
      timeout: 0,
      equivalentExcluded: 0,
      invalid: 0,
      capped: false,
      mutantsSkippedDueToCap: 0,
      criticalSurvivors: [],
      highSurvivors: [],
      complexityAdjusted: true,
      executionTimeMs: 100,
      filesAnalyzed: 1,
      ready_for_T6: true,
      mode: "enforce",
      mutantReports: [],
      hashVerified: true,
    };

    const commit = `e2e_trend_${String(i).padStart(3, "0")}`;
    const elDeps = buildT5ELDeps(commit);
    const result = await runT5EvolutionLayer(
      fakeResult,
      [TARGET_FILE],
      elDeps,
      T5EL_CONFIG,
    );

    if (i === 6) {
      console.log(
        `  Run ${i}: raw=${result.rawScore}, adj=${result.adjustedScore}`,
      );
      console.log(`  Trend: ${result.trend}`);
      console.log(`  Delta: ${result.deltaScore}`);
      console.log(`  Maturity: ${result.maturityLevel}`);
      console.log(`  Baseline active: ${result.baselineActive}`);
      console.log(`  Baseline drifted: ${result.baselineDrifted}`);
      console.log(`  Volume drift: ${result.volumeDriftSuspicious}`);
      console.log(`  History integrity: ${result.historyIntegrity}`);

      assert(result.trend !== null, "Trend must be computed");
      assert(result.deltaScore !== null, "Delta must be computed");
      assert(
        ["legacy", "growing", "mature"].includes(result.maturityLevel),
        "Maturity must be valid",
      );
      assert(
        result.historyIntegrity === "healthy",
        "History should be healthy",
      );
    }
  }

  // Verify history files exist
  const historyFiles = fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"));
  console.log(`  History files: ${historyFiles.length}`);
  assert(historyFiles.length >= 6, "Must have 6+ history files");

  pass(
    `6 runs with improving scores, trend computed, ${historyFiles.length} artifacts`,
  );
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 6: Baseline lock + checksum anti-tampering
// ═══════════════════════════════════════════════════════════

async function scenario6_baselineAntiTampering() {
  section("SCENARIO 6: Baseline checksum anti-tampering");

  // Create a baseline file manually with _checksum (as saveBaseline does)
  const baseline = {
    baselineScore: 85,
    baselineCritical: 0,
    baselineMutantIds: ["abc123", "def456", "ghi789"],
    createdAt: new Date().toISOString(),
    commit: "e2e_baseline_commit",
  };

  const checksum = computeBaselineChecksum(baseline);
  const baselineWithChecksum = { ...baseline, _checksum: checksum };

  // Save valid baseline
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(baselineWithChecksum, null, 2),
  );
  console.log(`  Baseline saved: _checksum=${checksum}`);

  // Load and verify — should succeed
  const elDeps = buildT5ELDeps("e2e_tampering_test");
  const loaded = await loadBaseline(BASELINE_PATH, elDeps);
  assert(loaded !== null, "Valid baseline must load");
  assertEqual(loaded.baselineScore, 85, "Baseline score");
  console.log(`  ✅ Valid baseline loaded successfully`);

  // NOW TAMPER: change the score without updating _checksum
  const tamperedBaseline = { ...baselineWithChecksum, baselineScore: 99 };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(tamperedBaseline, null, 2));
  console.log(`  Tampered: baselineScore 85 → 99 (_checksum unchanged)`);

  const loadedTampered = await loadBaseline(BASELINE_PATH, elDeps);

  // loadBaseline returns null when checksum fails (FIX 11)
  assert(loadedTampered === null, "Tampered baseline must be REJECTED (null)");
  console.log(`  ✅ Tampered baseline REJECTED by checksum verification`);

  // Verify manually that checksums differ
  const wrongChecksum = computeBaselineChecksum({
    baselineScore: 99,
    baselineCritical: 0,
    baselineMutantIds: ["abc123", "def456", "ghi789"],
    createdAt: baseline.createdAt,
    commit: baseline.commit,
  });
  console.log(`  Original checksum:  ${checksum}`);
  console.log(`  Tampered checksum:  ${wrongChecksum}`);
  assert(checksum !== wrongChecksum, "Checksums must differ");

  pass("Tampered baseline rejected by loadBaseline() (FIX 11)");
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 7: Artifact corruption detection
// ═══════════════════════════════════════════════════════════

async function scenario7_artifactCorruption() {
  section("SCENARIO 7: Artifact corruption — isValidArtifact()");

  // Valid artifact
  const valid = {
    commit: "abc123",
    timestamp: new Date().toISOString(),
    rawScore: 85,
    adjustedScore: 82,
    totalMutants: 40,
    killed: 34,
    survived: 6,
    branch: "master",
    criticalSurvivors: [],
    moduleScores: {},
  };
  assert(isValidArtifact(valid), "Valid artifact must pass");
  console.log("  ✅ Valid artifact: isValidArtifact() = true");

  // Corrupted: missing commit
  const noCommit = { ...valid, commit: "" };
  assert(!isValidArtifact(noCommit), "No commit must fail");
  console.log("  ✅ Empty commit: isValidArtifact() = false");

  // Corrupted: NaN score
  const nanScore = { ...valid, rawScore: NaN };
  assert(!isValidArtifact(nanScore), "NaN score must fail");
  console.log("  ✅ NaN rawScore: isValidArtifact() = false");

  // Corrupted: Infinity
  const infScore = { ...valid, adjustedScore: Infinity };
  assert(!isValidArtifact(infScore), "Infinity score must fail");
  console.log("  ✅ Infinity adjustedScore: isValidArtifact() = false");

  // Corrupted: missing timestamp
  const noTimestamp = { ...valid, timestamp: "" };
  assert(!isValidArtifact(noTimestamp), "Empty timestamp must fail");
  console.log("  ✅ Empty timestamp: isValidArtifact() = false");

  // Corrupted: null object
  assert(!isValidArtifact(null), "null must fail");
  assert(!isValidArtifact(undefined), "undefined must fail");
  assert(!isValidArtifact("not an object"), "string must fail");
  console.log("  ✅ null/undefined/string: isValidArtifact() = false");

  pass("6 corruption scenarios correctly filtered");
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 8: File integrity — no dirty state after execution
// ═══════════════════════════════════════════════════════════

async function scenario8_noDirtyState() {
  section("SCENARIO 8: No dirty files after T5 execution");

  const deps = buildT5Deps(ORIGINAL_SOURCE, "kill-all");
  const originalHash = computeHash(ORIGINAL_SOURCE);

  const result = await runT5MutationGate(
    { t4Passed: true, hpdScore: 80 },
    deps,
    T5_CONFIG,
  );

  // After execution, check in-memory FS still has original content
  const postExecContent = await deps.readFile(TARGET_FILE);
  const postExecHash = computeHash(postExecContent);

  console.log(`  Pre-hash:  ${originalHash}`);
  console.log(`  Post-hash: ${postExecHash}`);
  assertEqual(originalHash, postExecHash, "File hash pre/post");
  assertEqual(postExecContent, ORIGINAL_SOURCE, "File content pre/post");
  assert(result.hashVerified === true, "T5 must report hashVerified=true");

  console.log("  ✅ File unchanged after mutation testing");
  console.log(`  ✅ hashVerified=${result.hashVerified}`);

  pass("File hash matches pre/post execution");
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 9: Determinism — 2 consecutive runs same result
// ═══════════════════════════════════════════════════════════

async function scenario9_determinism() {
  section("SCENARIO 9: Determinism — 2 runs same result");

  const config = { ...T5_CONFIG };

  // Run 1
  const deps1 = buildT5Deps(ORIGINAL_SOURCE, "kill-all");
  const result1 = await runT5MutationGate(
    { t4Passed: true, hpdScore: 80 },
    deps1,
    config,
  );

  // Run 2
  const deps2 = buildT5Deps(ORIGINAL_SOURCE, "kill-all");
  const result2 = await runT5MutationGate(
    { t4Passed: true, hpdScore: 80 },
    deps2,
    config,
  );

  console.log(
    `  Run 1: mutants=${result1.totalMutants}, killed=${result1.killed}, raw=${result1.rawGlobalScore}%, adj=${result1.globalScore}%`,
  );
  console.log(
    `  Run 2: mutants=${result2.totalMutants}, killed=${result2.killed}, raw=${result2.rawGlobalScore}%, adj=${result2.globalScore}%`,
  );

  assertEqual(result1.totalMutants, result2.totalMutants, "totalMutants");
  assertEqual(result1.killed, result2.killed, "killed");
  assertEqual(result1.survived, result2.survived, "survived");
  assertEqual(result1.rawGlobalScore, result2.rawGlobalScore, "rawGlobalScore");
  assertEqual(result1.globalScore, result2.globalScore, "globalScore");
  assertEqual(result1.passed, result2.passed, "passed");
  assertEqual(
    result1.criticalSurvivors.length,
    result2.criticalSurvivors.length,
    "criticalSurvivors",
  );
  assertEqual(result1.hashVerified, result2.hashVerified, "hashVerified");

  // Compare mutant IDs
  const ids1 = result1.mutantReports.map((r) => r.mutant.id).sort();
  const ids2 = result2.mutantReports.map((r) => r.mutant.id).sort();
  assertEqual(JSON.stringify(ids1), JSON.stringify(ids2), "mutant IDs");

  console.log("  ✅ Both runs produce identical results");

  pass(
    `Deterministic: ${result1.totalMutants} mutants, score=${result1.globalScore}%`,
  );
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 10: verifyIntegrity — hash verification
// ═══════════════════════════════════════════════════════════

async function scenario10_integrityVerification() {
  section("SCENARIO 10: verifyIntegrity() — dirty state detection");

  // Simulate source files with known hashes
  const files = [TARGET_FILE, "src/other-module.ts"];
  const contents = new Map();
  contents.set(TARGET_FILE, ORIGINAL_SOURCE);
  contents.set("src/other-module.ts", "export const x = 42;");

  // Compute expected hashes
  const expectedHashes = new Map();
  for (const [file, content] of contents) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    expectedHashes.set(file, `${content.length}:${hash}`);
  }

  // Clean state → all files match
  const cleanDeps = {
    readFile: async (p) => contents.get(p) || null,
    restoreFile: async () => false,
    log: logMsg,
  };

  const cleanResult = await verifyIntegrity(files, expectedHashes, cleanDeps);
  console.log(
    `  Clean state: clean=${cleanResult.clean}, corrupted=${cleanResult.corrupted.length}`,
  );
  assert(cleanResult.clean === true, "Clean state must be clean");

  // Dirty state → one file modified
  const dirtyContents = new Map(contents);
  dirtyContents.set(TARGET_FILE, ORIGINAL_SOURCE + "\n// MUTATED");

  const dirtyDeps = {
    readFile: async (p) => dirtyContents.get(p) || null,
    restoreFile: async () => false, // Can't restore
    log: logMsg,
  };

  const dirtyResult = await verifyIntegrity(files, expectedHashes, dirtyDeps);
  console.log(
    `  Dirty state: clean=${dirtyResult.clean}, corrupted=${dirtyResult.corrupted.length}`,
  );
  assert(dirtyResult.clean === false, "Dirty state must NOT be clean");
  assert(
    dirtyResult.corrupted.includes(TARGET_FILE),
    "Target must be in corrupted list",
  );
  console.log(`  ✅ Corrupted files: ${dirtyResult.corrupted.join(", ")}`);

  pass("Clean=clean, dirty=detected, corrupted files identified");
}

// ═══════════════════════════════════════════════════════════
// SCENARIO 11: T5-EL Policy — enforce blocks, report doesn't
// ═══════════════════════════════════════════════════════════

async function scenario11_policyModes() {
  section("SCENARIO 11: T5-EL policy modes — enforce vs report");

  // Create a failing T5 result (low score)
  const failingResult = {
    name: "mutation-testing",
    passed: false,
    blocking: true,
    skipped: false,
    globalScore: 30,
    rawGlobalScore: 35,
    moduleScores: [
      {
        file: TARGET_FILE,
        rawScore: 35,
        complexity: 5,
        penalty: 0.03,
        adjustedScore: 30,
        killed: 12,
        survived: 28,
        timeout: 0,
        equivalentExcluded: 0,
        invalid: 0,
        totalMutants: 40,
      },
    ],
    totalMutants: 40,
    killed: 12,
    survived: 28,
    timeout: 0,
    equivalentExcluded: 0,
    invalid: 0,
    capped: false,
    mutantsSkippedDueToCap: 0,
    criticalSurvivors: [
      {
        mutant: {
          id: "test:L1:>=→>",
          file: TARGET_FILE,
          operator: {
            name: "relational",
            original: ">=",
            mutated: ">",
            tier: "Tier1",
          },
        },
        status: "survived",
      },
    ],
    highSurvivors: [],
    complexityAdjusted: true,
    executionTimeMs: 100,
    filesAnalyzed: 1,
    ready_for_T6: false,
    mode: "enforce",
    mutantReports: [],
    hashVerified: true,
  };

  // Enforce mode: should block
  const enforceConfig = { ...T5EL_CONFIG, mode: "enforce" };
  const deps1 = buildT5ELDeps("e2e_enforce_policy");
  const enforceResult = await runT5EvolutionLayer(
    failingResult,
    [TARGET_FILE],
    deps1,
    enforceConfig,
  );

  console.log(
    `  Enforce: blocking=${enforceResult.blocking}, reason=${enforceResult.blockingReason}`,
  );
  assert(enforceResult.blocking === true, "Enforce must block low score");
  assert(enforceResult.blockingReason !== null, "Must have blocking reason");

  // Report mode: should NOT block
  const reportConfig = { ...T5EL_CONFIG, mode: "report" };
  const deps2 = buildT5ELDeps("e2e_report_policy");
  const reportResult = await runT5EvolutionLayer(
    failingResult,
    [TARGET_FILE],
    deps2,
    reportConfig,
  );

  console.log(
    `  Report: blocking=${reportResult.blocking}, reason=${reportResult.blockingReason}`,
  );
  assert(reportResult.blocking === false, "Report must NOT block");
  assert(
    reportResult.wouldBlockInEnforce === true,
    "Must indicate would-block",
  );

  pass("enforce=BLOCK, report=PASS+wouldBlock");
}

// ═══════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  T5 + T5-EL  —  End-to-End Validation Suite            ║");
  console.log("║  Project Brain Quality Gate Pipeline                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  cleanup();

  try {
    // T5 Engine scenarios
    const healthyResult = await scenario1_healthyMutationKilling();
    const buggyResult = await scenario2_survivingMutant();

    // T5-EL scenarios
    await scenario3_artifactPersistence(healthyResult);

    // Clean temp for fresh EL tests
    cleanup();
    await scenario4_scoring(healthyResult, buggyResult);

    cleanup();
    await scenario5_trendAndMaturity();

    cleanup();
    await scenario6_baselineAntiTampering();

    await scenario7_artifactCorruption();
    await scenario8_noDirtyState();
    await scenario9_determinism();
    await scenario10_integrityVerification();

    cleanup();
    await scenario11_policyModes();
  } catch (e) {
    console.error(`\n💥 FATAL: ${e.message}`);
    console.error(e.stack);
  }

  // Final report
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS SUMMARY                                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const passed = testResults.filter((r) => r.passed).length;
  const failed = testResults.filter((r) => !r.passed).length;

  for (const r of testResults) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} ${r.test}`);
    if (r.message) {
      console.log(`     ${r.message}`);
    }
  }

  console.log(
    `\n  Total: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`,
  );

  if (failed === 0) {
    console.log("\n  🏴‍☠️ ALL SCENARIOS PASSED — System ready for T6");
  } else {
    console.log("\n  ⛔ SOME SCENARIOS FAILED — Fix before T6");
  }

  // Cleanup
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
