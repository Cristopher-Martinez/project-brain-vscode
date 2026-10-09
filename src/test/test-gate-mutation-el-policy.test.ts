/**
 * T5-EL Policy Tests (4 modes + recommendations)
 * Covers: FIX 4 (mutantId in baseline-lock), FIX 5 (blockingReason)
 */
import * as assert from "assert";
import {
  applyPolicy,
  assertPolicyConsistency,
  generateRecommendation,
} from "../test-gate-mutation-el-policy";
import type {
  MutantDetail,
  MutationBaseline,
  MutationRun,
  PolicyDecision,
  T5ELConfig,
} from "../test-gate-mutation-el-types";
import { DEFAULT_T5EL_CONFIG } from "../test-gate-mutation-el-types";

function makeRun(overrides: Partial<MutationRun> = {}): MutationRun {
  return {
    commit: "abc",
    timestamp: "2025-01-01T00:00:00Z",
    rawScore: 70,
    adjustedScore: 68,
    moduleScores: { "src/a.ts": 70 },
    totalMutants: 50,
    killed: 35,
    survived: 10,
    timeout: 3,
    equivalent: 2,
    invalid: 0,
    criticalSurvivors: [],
    capped: false,
    mutantsSkippedDueToCap: 0,
    ...overrides,
  };
}

function makeBaseline(
  overrides: Partial<MutationBaseline> = {},
): MutationBaseline {
  return {
    baselineScore: 60,
    baselineCritical: 1,
    baselineMutantIds: ["existing-id"],
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<MutantDetail> = {}): MutantDetail {
  return {
    mutantId: "new-survivor-id",
    file: "src/a.ts",
    line: 10,
    column: 5,
    operator: ">=→>",
    functionName: "check",
    astNodeKind: "BinaryExpression",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<T5ELConfig> = {}): T5ELConfig {
  return { ...DEFAULT_T5EL_CONFIG, ...overrides };
}

suite("T5-EL Policy — report mode", () => {
  test("never blocks", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 10 }),
      "report",
      null,
      "legacy",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, false);
    assert.strictEqual(d.blockingReason, null);
  });

  test("reports wouldBlockInEnforce when enforce would block", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 40 }),
      "report",
      null,
      "legacy",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.wouldBlockInEnforce, true);
  });

  test("wouldBlockInEnforce false when enforce would pass", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 80, moduleScores: { "a.ts": 70 } }),
      "report",
      null,
      "growing",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.wouldBlockInEnforce, false);
  });
});

suite("T5-EL Policy — enforce mode", () => {
  test("blocks when adjustedScore < globalMinScore (FIX 5: blockingReason)", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 50 }),
      "enforce",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "global-threshold");
  });

  test("blocks when module score < coreMinScore", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 70, moduleScores: { "core.ts": 40 } }),
      "enforce",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "core-threshold");
  });

  test("blocks when critical survivors exist", () => {
    const d = applyPolicy(
      makeRun({
        adjustedScore: 80,
        moduleScores: { "a.ts": 80 },
        criticalSurvivors: [makeDetail()],
      }),
      "enforce",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "critical-survivor");
  });

  test("passes when all thresholds met", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 80, moduleScores: { "a.ts": 80 } }),
      "enforce",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, false);
    assert.strictEqual(d.blockingReason, null);
  });
});

suite("T5-EL Policy — baseline-lock mode", () => {
  test("passes when no baseline exists", () => {
    const d = applyPolicy(
      makeRun(),
      "baseline-lock",
      null,
      "growing",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, false);
    assert.strictEqual(d.blockingReason, null);
  });

  test("blocks when rawScore < baselineScore (FIX 5: baseline-regression)", () => {
    const d = applyPolicy(
      makeRun({ rawScore: 55 }),
      "baseline-lock",
      makeBaseline(),
      "growing",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "baseline-regression");
  });

  test("blocks when critical > baselineCritical", () => {
    const d = applyPolicy(
      makeRun({
        criticalSurvivors: [makeDetail(), makeDetail({ mutantId: "id2" })],
      }),
      "baseline-lock",
      makeBaseline({ baselineCritical: 1 }),
      "growing",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "baseline-regression");
  });

  test("blocks when NEW critical in modified file (FIX 4: mutantId comparison)", () => {
    const newSurvivor = makeDetail({
      mutantId: "brand-new-id",
      file: "src/modified.ts",
    });
    const d = applyPolicy(
      makeRun({ criticalSurvivors: [newSurvivor] }),
      "baseline-lock",
      makeBaseline({ baselineCritical: 5, baselineMutantIds: ["existing-id"] }),
      "growing",
      makeConfig(),
      ["src/modified.ts"],
    );
    assert.strictEqual(d.blocking, true);
    assert.strictEqual(d.blockingReason, "critical-survivor");
  });

  test("passes when survivors match baseline IDs (FIX 4)", () => {
    const existingSurvivor = makeDetail({
      mutantId: "existing-id",
      file: "src/a.ts",
    });
    const d = applyPolicy(
      makeRun({ criticalSurvivors: [existingSurvivor] }),
      "baseline-lock",
      makeBaseline({ baselineCritical: 5, baselineMutantIds: ["existing-id"] }),
      "growing",
      makeConfig(),
      ["src/a.ts"],
    );
    assert.strictEqual(d.blocking, false);
  });
});

suite("T5-EL Policy — adaptive mode", () => {
  test("mature escalates to enforce", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 50 }),
      "adaptive",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.ok(d.reason?.includes("enforce"));
  });

  test("not mature with baseline uses baseline-lock", () => {
    const d = applyPolicy(
      makeRun({ rawScore: 55 }),
      "adaptive",
      makeBaseline(),
      "growing",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, true);
    assert.ok(d.reason?.includes("baseline-lock"));
  });

  test("not mature without baseline falls to report", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 40 }),
      "adaptive",
      null,
      "legacy",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, false);
  });

  test("mature passes when enforce would pass", () => {
    const d = applyPolicy(
      makeRun({ adjustedScore: 80, moduleScores: { "a.ts": 80 } }),
      "adaptive",
      null,
      "mature",
      makeConfig(),
      [],
    );
    assert.strictEqual(d.blocking, false);
  });
});

suite("T5-EL generateRecommendation", () => {
  test("returns blocked message when blocking", () => {
    const d: PolicyDecision = {
      blocking: true,
      wouldBlockInEnforce: true,
      blockingReason: "global-threshold",
      reason: "too low",
    };
    const r = generateRecommendation(d, "enforce", "mature", "regressing");
    assert.ok(r?.includes("Blocked"));
  });

  test("returns would-block warning when not blocking but enforce would", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: true,
      blockingReason: null,
    };
    const r = generateRecommendation(d, "report", "growing", "stable");
    assert.ok(r?.includes("would block"));
  });

  test("returns advice for legacy", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: false,
      blockingReason: null,
    };
    const r = generateRecommendation(d, "report", "legacy", null);
    assert.ok(r?.includes("tests"));
  });

  test("returns undefined when all good", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: false,
      blockingReason: null,
    };
    const r = generateRecommendation(d, "enforce", "mature", "improving");
    assert.strictEqual(r, undefined);
  });
});

// ——— FIX 13: Policy Consistency Assertions ———
suite("T5-EL assertPolicyConsistency (FIX 13)", () => {
  const cfg = { globalMinScore: 65 };

  test("consistent when blocking=true with blockingReason", () => {
    const d: PolicyDecision = {
      blocking: true,
      wouldBlockInEnforce: true,
      blockingReason: "global-threshold",
      reason: "low score",
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 0 } },
      "enforce",
      cfg,
    );
    assert.strictEqual(r.consistent, true);
    assert.strictEqual(r.violations.length, 0);
  });

  test("inconsistent: blocking=true without blockingReason", () => {
    const d: PolicyDecision = {
      blocking: true,
      wouldBlockInEnforce: true,
      blockingReason: null,
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 0 } },
      "enforce",
      cfg,
    );
    assert.strictEqual(r.consistent, false);
    assert.ok(r.violations.some((v) => v.includes("blockingReason is null")));
  });

  test("inconsistent: blocking=false with blockingReason", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: false,
      blockingReason: "global-threshold",
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 80, criticalSurvivors: { length: 0 } },
      "report",
      cfg,
    );
    assert.strictEqual(r.consistent, false);
    assert.ok(r.violations.some((v) => v.includes("blocking=false")));
  });

  test("inconsistent: enforce + critical survivors + above threshold but not blocking", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: false,
      blockingReason: null,
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 80, criticalSurvivors: { length: 2 } },
      "enforce",
      cfg,
    );
    assert.strictEqual(r.consistent, false);
    assert.ok(r.violations.some((v) => v.includes("critical survivors")));
  });

  test("inconsistent: enforce + below threshold but not blocking", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: false,
      blockingReason: null,
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 0 } },
      "enforce",
      cfg,
    );
    assert.strictEqual(r.consistent, false);
    assert.ok(r.violations.some((v) => v.includes("below threshold")));
  });

  test("inconsistent: enforce blocking but wouldBlockInEnforce=false", () => {
    const d: PolicyDecision = {
      blocking: true,
      wouldBlockInEnforce: false,
      blockingReason: "global-threshold",
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 0 } },
      "enforce",
      cfg,
    );
    assert.strictEqual(r.consistent, false);
    assert.ok(r.violations.some((v) => v.includes("wouldBlockInEnforce")));
  });

  test("consistent in report mode with any values", () => {
    const d: PolicyDecision = {
      blocking: false,
      wouldBlockInEnforce: true,
      blockingReason: null,
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 3 } },
      "report",
      cfg,
    );
    assert.strictEqual(r.consistent, true);
  });

  test("multiple violations captured", () => {
    const d: PolicyDecision = {
      blocking: true,
      wouldBlockInEnforce: false,
      blockingReason: null,
    };
    const r = assertPolicyConsistency(
      d,
      { adjustedScore: 50, criticalSurvivors: { length: 0 } },
      "enforce",
      cfg,
    );
    assert.ok(
      r.violations.length >= 2,
      `Expected >=2 violations, got ${r.violations.length}`,
    );
  });
});
