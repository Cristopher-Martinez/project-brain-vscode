/**
 * test-gate-structural.test.ts — Tests for T4-ADS Structural Gate + Adversarial Suite.
 */

import * as assert from "assert";
import type {
  CoreModuleEntry,
  FileCoverageSummary,
  GateResult,
  InvariantHistoryEntry,
  InvariantRecord,
} from "../test-pipeline-types";
import {
  checkCoreInvariantPresence,
  checkCoreInvariantIntegrity,
  checkDecisionCoverage,
  checkDeletionAndDowngrade,
  checkMutationSentinel,
  isValidJustification,
  isImpactDowngrade,
  getModuleBranchCoverage,
  GLOBAL_BRANCH_THRESHOLD,
  CORE_BRANCH_THRESHOLD,
  runStructuralGate,
} from "../test-gate-structural";
import { runAdversarialSuite } from "../test-gate-adversarial";

// ——— Test Helpers ————————————————————————————————

function makeInvariant(overrides: Partial<InvariantRecord> = {}): InvariantRecord {
  return {
    id: "test-inv",
    description: "Test invariant",
    impact: "critical",
    tier: "core",
    files: ["src/module.ts"],
    addedAt: "2026-01-01",
    ...overrides,
  };
}

function makeCoreModule(path = "src/module.ts"): CoreModuleEntry {
  return { path, reasons: ["persistence"], autoDetected: true };
}

function makeCoverage(file: string, branchPct: number): FileCoverageSummary {
  return { file, branchPct, linePct: branchPct + 5, uncoveredBranches: [] };
}

function makeT2Result(passed = true): GateResult {
  return {
    level: 1,
    passed,
    checks: [],
    duration: 100,
    timestamp: Date.now(),
  };
}

// ——— CHECK 1: Core Invariant Presence ————————————

suite("T4-ADS: CHECK 1 — Core Invariant Presence", () => {
  test("passes when core module has invariant", () => {
    const checks = checkCoreInvariantPresence(
      [makeCoreModule()],
      [makeInvariant()],
    );
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].passed, true);
    assert.strictEqual(checks[0].blocking, true);
  });

  test("fails when core module has no invariant", () => {
    const checks = checkCoreInvariantPresence(
      [makeCoreModule("src/auth.ts")],
      [makeInvariant({ files: ["src/other.ts"] })],
    );
    assert.strictEqual(checks[0].passed, false);
    assert.strictEqual(checks[0].blocking, true);
  });

  test("handles multiple core modules", () => {
    const checks = checkCoreInvariantPresence(
      [makeCoreModule("src/a.ts"), makeCoreModule("src/b.ts")],
      [makeInvariant({ files: ["src/a.ts"] })],
    );
    assert.strictEqual(checks.length, 2);
    assert.strictEqual(checks[0].passed, true);
    assert.strictEqual(checks[1].passed, false);
  });
});

// ——— CHECK 2: Core Invariant Structural Integrity ————

suite("T4-ADS: CHECK 2 — Core Invariant Structural Integrity", () => {
  test("passes with all conditions met", () => {
    const testContents = new Map<string, string>();
    testContents.set("src/test/module.test.ts", `
      describe("module", () => {
        it("validates test-inv", () => {
          assert(result === true);
        });
      });
    `);

    const checks = checkCoreInvariantIntegrity(
      [makeInvariant()],
      [makeCoverage("src/module.ts", 80)],
      testContents,
      70,
    );
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].passed, true);
  });

  test("fails without linked test", () => {
    const checks = checkCoreInvariantIntegrity(
      [makeInvariant()],
      [makeCoverage("src/module.ts", 80)],
      new Map(),
      70,
    );
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("sin test vinculado"));
  });

  test("fails with low branch coverage", () => {
    const testContents = new Map<string, string>();
    testContents.set("src/test/module.test.ts", `assert(true); // test-inv`);

    const checks = checkCoreInvariantIntegrity(
      [makeInvariant()],
      [makeCoverage("src/module.ts", 50)],
      testContents,
      70,
    );
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("branchCoverage=50%"));
  });

  test("fails with low HPD score", () => {
    const testContents = new Map<string, string>();
    testContents.set("src/test/module.test.ts", `assert(true); // test-inv`);

    const checks = checkCoreInvariantIntegrity(
      [makeInvariant()],
      [makeCoverage("src/module.ts", 80)],
      testContents,
      30, // low HPD
    );
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("HPD=30"));
  });

  test("fails without strong assertion", () => {
    const testContents = new Map<string, string>();
    testContents.set("src/test/module.test.ts", `console.log("test-inv");`);

    const checks = checkCoreInvariantIntegrity(
      [makeInvariant()],
      [makeCoverage("src/module.ts", 80)],
      testContents,
      70,
    );
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("sin aserción fuerte"));
  });

  test("skips non-core invariants", () => {
    const checks = checkCoreInvariantIntegrity(
      [makeInvariant({ tier: "non-core" })],
      [makeCoverage("src/module.ts", 80)],
      new Map(),
      70,
    );
    assert.strictEqual(checks.length, 0);
  });

  test("skips low impact invariants", () => {
    const checks = checkCoreInvariantIntegrity(
      [makeInvariant({ impact: "low" })],
      [makeCoverage("src/module.ts", 80)],
      new Map(),
      70,
    );
    assert.strictEqual(checks.length, 0);
  });
});

// ——— CHECK 3: Decision Coverage ——————————————————

suite("T4-ADS: CHECK 3 — Decision Coverage Integrity", () => {
  test("passes when global >= 80", () => {
    const checks = checkDecisionCoverage(80, [], []);
    const global = checks.find((c) => c.name === "decision-coverage-global");
    assert.strictEqual(global?.passed, true);
  });

  test("fails when global < 80", () => {
    const checks = checkDecisionCoverage(79, [], []);
    const global = checks.find((c) => c.name === "decision-coverage-global");
    assert.strictEqual(global?.passed, false);
  });

  test("passes when core module >= 70", () => {
    const checks = checkDecisionCoverage(85, [makeCoreModule()], [makeCoverage("src/module.ts", 70)]);
    const core = checks.find((c) => c.name === "decision-coverage-core-module");
    assert.strictEqual(core?.passed, true);
  });

  test("fails when core module < 70", () => {
    const checks = checkDecisionCoverage(85, [makeCoreModule()], [makeCoverage("src/module.ts", 69)]);
    const core = checks.find((c) => c.name === "decision-coverage-core-module");
    assert.strictEqual(core?.passed, false);
  });

  test("exact boundary: 80 passes, 79 fails", () => {
    const at80 = checkDecisionCoverage(80, [], []);
    const at79 = checkDecisionCoverage(79, [], []);
    assert.strictEqual(at80[0].passed, true);
    assert.strictEqual(at79[0].passed, false);
  });
});

// ——— CHECK 4: Deletion & Downgrade Protection ————

suite("T4-ADS: CHECK 4 — Deletion & Downgrade Protection", () => {
  test("blocks deletion without justification", () => {
    const prev = [makeInvariant({ id: "inv-1" })];
    const curr: InvariantRecord[] = [];
    const checks = checkDeletionAndDowngrade(curr, prev, []);
    assert.strictEqual(checks[0].passed, false);
    assert.strictEqual(checks[0].blocking, true);
  });

  test("allows deletion with valid justification", () => {
    const prev = [makeInvariant({ id: "inv-1" })];
    const curr: InvariantRecord[] = [];
    const history: InvariantHistoryEntry[] = [{
      action: "deleted", invariantId: "inv-1",
      timestamp: new Date().toISOString(),
      justification: "Refactored into a new module with better design",
    }];
    const checks = checkDeletionAndDowngrade(curr, prev, history);
    assert.strictEqual(checks[0].passed, true);
  });

  test("blocks impact downgrade without justification", () => {
    const prev = [makeInvariant({ id: "inv-1", impact: "critical" })];
    const curr = [makeInvariant({ id: "inv-1", impact: "low" })];
    const checks = checkDeletionAndDowngrade(curr, prev, []);
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("downgrade silencioso"));
  });

  test("blocks tier downgrade without justification", () => {
    const prev = [makeInvariant({ id: "inv-1", tier: "core" })];
    const curr = [makeInvariant({ id: "inv-1", tier: "non-core" })];
    const checks = checkDeletionAndDowngrade(curr, prev, []);
    assert.strictEqual(checks[0].passed, false);
    assert.ok(checks[0].explanation.includes("tier downgrade"));
  });

  test("no checks when nothing changed", () => {
    const inv = [makeInvariant()];
    const checks = checkDeletionAndDowngrade(inv, inv, []);
    assert.strictEqual(checks.length, 0);
  });
});

// ——— CHECK 5: Mutation Sentinel ——————————————————

suite("T4-ADS: CHECK 5 — Structural Mutation Sentinel", () => {
  test("blocks when sentinel disabled", () => {
    const checks = checkMutationSentinel(85, [], [], false);
    assert.strictEqual(checks[0].passed, false);
    assert.strictEqual(checks[0].blocking, true);
  });

  test("passes at exact boundary values", () => {
    const checks = checkMutationSentinel(
      GLOBAL_BRANCH_THRESHOLD, // exactly 80
      [makeCoreModule()],
      [makeCoverage("src/module.ts", CORE_BRANCH_THRESHOLD)], // exactly 70
      true,
    );
    assert.strictEqual(checks[0].passed, true);
  });
});

// ——— Helpers ——————————————————————————————————————

suite("T4-ADS: Helpers", () => {
  test("isValidJustification rejects empty", () => {
    assert.strictEqual(isValidJustification(undefined), false);
    assert.strictEqual(isValidJustification(""), false);
  });

  test("isValidJustification rejects too short", () => {
    assert.strictEqual(isValidJustification("ok"), false);
    assert.strictEqual(isValidJustification("short refactor"), false);
  });

  test("isValidJustification accepts valid", () => {
    assert.strictEqual(isValidJustification("Refactored into new module with better design"), true);
    assert.strictEqual(isValidJustification("This function was deprecated in v2.0"), true);
  });

  test("isValidJustification rejects no keyword", () => {
    assert.strictEqual(isValidJustification("This is a long enough justification but no keyword"), false);
  });

  test("isImpactDowngrade detects downgrade", () => {
    assert.strictEqual(isImpactDowngrade("critical", "low"), true);
    assert.strictEqual(isImpactDowngrade("critical", "high"), true);
    assert.strictEqual(isImpactDowngrade("high", "medium"), true);
  });

  test("isImpactDowngrade rejects upgrade", () => {
    assert.strictEqual(isImpactDowngrade("low", "critical"), false);
    assert.strictEqual(isImpactDowngrade("medium", "high"), false);
  });

  test("isImpactDowngrade rejects same level", () => {
    assert.strictEqual(isImpactDowngrade("critical", "critical"), false);
  });

  test("getModuleBranchCoverage returns 0 for empty", () => {
    assert.strictEqual(getModuleBranchCoverage(["src/a.ts"], []), 0);
  });

  test("getModuleBranchCoverage returns 0 for no match", () => {
    assert.strictEqual(
      getModuleBranchCoverage(["src/a.ts"], [makeCoverage("src/b.ts", 85)]),
      0,
    );
  });

  test("getModuleBranchCoverage returns min of matched files", () => {
    const result = getModuleBranchCoverage(
      ["src/a.ts", "src/b.ts"],
      [makeCoverage("src/a.ts", 100), makeCoverage("src/b.ts", 40)],
    );
    assert.strictEqual(result, 40, "must return min, not average");
  });
});

// ——— Adversarial Suite ———————————————————————————

suite("T4-ADS: Phase B — Adversarial Suite", () => {
  test("all 15 scenarios pass", () => {
    const results = runAdversarialSuite();
    assert.strictEqual(results.length, 15);

    for (const r of results) {
      assert.strictEqual(r.passed, true, `${r.id} (${r.name}): ${r.explanation}`);
    }
  });

  test("no mutations survive", () => {
    const results = runAdversarialSuite();
    const surviving = results.filter((r) => !r.passed);
    assert.strictEqual(surviving.length, 0, `Mutations surviving: ${surviving.map((s) => s.id).join(", ")}`);
  });

  test("output contract matches spec", () => {
    const results = runAdversarialSuite();
    assert.strictEqual(results.filter((r) => r.passed).length, 15);
    assert.strictEqual(results.filter((r) => !r.passed).length, 0);
  });
});

// ——— Integration: runStructuralGate ——————————————

suite("T4-ADS: Integration — runStructuralGate", () => {
  test("aborts when T2 failed", async () => {
    const result = await runStructuralGate({
      wsRoot: __dirname,
      contract: { test: null, coverage: null, lint: null, mutation: null, framework: "mocha", invariantsPattern: "", coreModules: [] },
      t2Result: makeT2Result(false),
      hpdScore: 70,
    });
    assert.strictEqual(result.T4_structural_passed, false);
    assert.strictEqual(result.blocking, true);
    assert.strictEqual(result.ready_for_T5, false);
    assert.ok(result.gate.checks[0].explanation.includes("T2"));
  });

  test("aborts when HPD too low", async () => {
    const result = await runStructuralGate({
      wsRoot: __dirname,
      contract: { test: null, coverage: null, lint: null, mutation: null, framework: "mocha", invariantsPattern: "", coreModules: [] },
      t2Result: makeT2Result(true),
      hpdScore: 50, // < 65
    });
    assert.strictEqual(result.T4_structural_passed, false);
    assert.strictEqual(result.blocking, true);
    assert.ok(result.gate.checks[0].explanation.includes("HPD"));
  });

  test("output contract has all required fields", async () => {
    const result = await runStructuralGate({
      wsRoot: __dirname,
      contract: { test: null, coverage: null, lint: null, mutation: null, framework: "mocha", invariantsPattern: "", coreModules: [] },
      t2Result: makeT2Result(true),
      hpdScore: 70,
      coverageSummaries: [],
      previousSnapshot: [],
    });

    assert.strictEqual(typeof result.T4_structural_passed, "boolean");
    assert.strictEqual(typeof result.adversarial_passed, "number");
    assert.strictEqual(typeof result.adversarial_total, "number");
    assert.strictEqual(typeof result.mutations_surviving, "number");
    assert.strictEqual(typeof result.blocking, "boolean");
    assert.strictEqual(typeof result.ready_for_T5, "boolean");
    assert.ok(result.gate);
    assert.ok(Array.isArray(result.adversarial_details));
  });
});
