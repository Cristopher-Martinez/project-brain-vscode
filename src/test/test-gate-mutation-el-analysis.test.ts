/**
 * T5-EL Analysis Tests (trend + maturity)
 * Covers: FIX 2 (adjustedScore trend), FIX 3 (volume guard)
 */
import * as assert from "assert";
import {
  classifyDelta,
  computeMaturity,
  computeTrend,
  detectBaselineDrift,
  detectVolumeDrift,
} from "../test-gate-mutation-el-analysis";
import type {
  MutantDetail,
  MutationBaseline,
  MutationRun,
} from "../test-gate-mutation-el-types";

const MATURITY_OPTS = {
  minAvgScore: 70,
  minT4Streak: 5,
  windowSize: 5,
  minMutationVolume: 30,
};

function makeRun(overrides: Partial<MutationRun> = {}): MutationRun {
  return {
    commit: "abc",
    timestamp: "2025-01-01T00:00:00Z",
    rawScore: 60,
    adjustedScore: 58,
    moduleScores: {},
    totalMutants: 50,
    killed: 30,
    survived: 15,
    timeout: 3,
    equivalent: 2,
    invalid: 0,
    criticalSurvivors: [],
    capped: false,
    mutantsSkippedDueToCap: 0,
    ...overrides,
  };
}

suite("T5-EL Trend", () => {
  test("returns null when no previous", () => {
    const result = computeTrend(makeRun(), null);
    assert.strictEqual(result, null);
  });

  test("improving when delta > 2 (uses adjustedScore — FIX 2)", () => {
    const current = makeRun({ adjustedScore: 75 });
    const previous = makeRun({ adjustedScore: 70 });
    const result = computeTrend(current, previous)!;
    assert.strictEqual(result.direction, "improving");
    assert.strictEqual(result.deltaScore, 5);
  });

  test("stable when |delta| <= 2", () => {
    const current = makeRun({ adjustedScore: 71 });
    const previous = makeRun({ adjustedScore: 70 });
    const result = computeTrend(current, previous)!;
    assert.strictEqual(result.direction, "stable");
  });

  test("regressing when delta < -2", () => {
    const current = makeRun({ adjustedScore: 65 });
    const previous = makeRun({ adjustedScore: 72 });
    const result = computeTrend(current, previous)!;
    assert.strictEqual(result.direction, "regressing");
  });

  test("deltaCritical tracks survivor count change", () => {
    const detail: MutantDetail = {
      mutantId: "id1",
      file: "a.ts",
      line: 1,
      column: 1,
      operator: ">=→>",
      functionName: "f",
      astNodeKind: "BinaryExpression",
    };
    const current = makeRun({ adjustedScore: 60, criticalSurvivors: [detail] });
    const previous = makeRun({ adjustedScore: 60, criticalSurvivors: [] });
    const result = computeTrend(current, previous)!;
    assert.strictEqual(result.deltaCritical, 1);
  });
});

suite("T5-EL classifyDelta", () => {
  test("boundaries", () => {
    assert.strictEqual(classifyDelta(2.1), "improving");
    assert.strictEqual(classifyDelta(2), "stable");
    assert.strictEqual(classifyDelta(-2), "stable");
    assert.strictEqual(classifyDelta(-2.1), "regressing");
  });
});

suite("T5-EL Maturity", () => {
  test("legacy with empty runs", () => {
    const info = computeMaturity([], 10, MATURITY_OPTS);
    assert.strictEqual(info.level, "legacy");
    assert.strictEqual(info.avgTotalMutants, 0);
  });

  test("legacy when avg < 55", () => {
    const runs = Array.from({ length: 5 }, () =>
      makeRun({ adjustedScore: 40, totalMutants: 50 }),
    );
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.strictEqual(info.level, "legacy");
  });

  test("growing when 55 <= avg < 70", () => {
    const runs = Array.from({ length: 5 }, () =>
      makeRun({ adjustedScore: 60, totalMutants: 50 }),
    );
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.strictEqual(info.level, "growing");
  });

  test("mature with all conditions met (including volume — FIX 3)", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun({
        adjustedScore: 75 + i * 0.5,
        totalMutants: 50,
        commit: `c${i}`,
        timestamp: new Date(2025, 0, i + 1).toISOString(),
      }),
    );
    const info = computeMaturity(runs, 5, MATURITY_OPTS);
    assert.strictEqual(info.level, "mature");
    assert.ok(info.avgTotalMutants >= 30, "avgTotalMutants should be >= 30");
  });

  test("not mature when window incomplete", () => {
    const runs = [makeRun({ adjustedScore: 80, totalMutants: 50 })];
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.notStrictEqual(info.level, "mature");
  });

  test("not mature when has criticals", () => {
    const detail: MutantDetail = {
      mutantId: "id1",
      file: "a.ts",
      line: 1,
      column: 1,
      operator: ">=→>",
      functionName: "f",
      astNodeKind: "BinaryExpression",
    };
    const runs = Array.from({ length: 5 }, () =>
      makeRun({
        adjustedScore: 80,
        totalMutants: 50,
        criticalSurvivors: [detail],
      }),
    );
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.notStrictEqual(info.level, "mature");
  });

  test("not mature with low T4 streak", () => {
    const runs = Array.from({ length: 5 }, () =>
      makeRun({ adjustedScore: 80, totalMutants: 50 }),
    );
    const info = computeMaturity(runs, 2, MATURITY_OPTS);
    assert.notStrictEqual(info.level, "mature");
  });

  test("not mature when regressing in window (uses adjustedScore — FIX 2)", () => {
    const runs = [
      makeRun({
        adjustedScore: 60,
        totalMutants: 50,
        timestamp: "2025-01-05T00:00:00Z",
      }),
      makeRun({
        adjustedScore: 75,
        totalMutants: 50,
        timestamp: "2025-01-04T00:00:00Z",
      }),
      makeRun({
        adjustedScore: 75,
        totalMutants: 50,
        timestamp: "2025-01-03T00:00:00Z",
      }),
      makeRun({
        adjustedScore: 75,
        totalMutants: 50,
        timestamp: "2025-01-02T00:00:00Z",
      }),
      makeRun({
        adjustedScore: 75,
        totalMutants: 50,
        timestamp: "2025-01-01T00:00:00Z",
      }),
    ];
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.notStrictEqual(info.level, "mature");
  });

  test("not mature when below minMutationVolume (FIX 3)", () => {
    const runs = Array.from({ length: 5 }, () =>
      makeRun({ adjustedScore: 80, totalMutants: 10 }),
    );
    const info = computeMaturity(runs, 10, MATURITY_OPTS);
    assert.notStrictEqual(info.level, "mature");
  });
});

// ——— FIX 10: Baseline Drift Detection ———
suite("T5-EL detectBaselineDrift (FIX 10)", () => {
  test("not drifted when no baseline", () => {
    const r = detectBaselineDrift(80, null);
    assert.strictEqual(r.drifted, false);
    assert.strictEqual(r.gap, 0);
  });

  test("not drifted when within range", () => {
    const bl: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 0,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const r = detectBaselineDrift(80, bl);
    assert.strictEqual(r.drifted, false);
    assert.strictEqual(r.gap, 20);
  });

  test("drifted when gap > maxDrift", () => {
    const bl: MutationBaseline = {
      baselineScore: 40,
      baselineCritical: 0,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const r = detectBaselineDrift(80, bl);
    assert.strictEqual(r.drifted, true);
    assert.strictEqual(r.gap, 40);
    assert.ok(r.recommendation);
  });

  test("exact boundary (25 gap) is not drifted", () => {
    const bl: MutationBaseline = {
      baselineScore: 55,
      baselineCritical: 0,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const r = detectBaselineDrift(80, bl);
    assert.strictEqual(r.drifted, false);
  });

  test("custom maxDrift threshold", () => {
    const bl: MutationBaseline = {
      baselineScore: 70,
      baselineCritical: 0,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const r = detectBaselineDrift(82, bl, 10);
    assert.strictEqual(r.drifted, true);
    assert.strictEqual(r.gap, 12);
  });
});

// ——— FIX 12: Volume Drift Detection ———
suite("T5-EL detectVolumeDrift (FIX 12)", () => {
  test("not suspicious when no previous runs", () => {
    const r = detectVolumeDrift(makeRun({ totalMutants: 50 }), []);
    assert.strictEqual(r.suspicious, false);
  });

  test("not suspicious when volume stable", () => {
    const current = makeRun({ totalMutants: 48 });
    const previous = [makeRun({ totalMutants: 50 })];
    const r = detectVolumeDrift(current, previous);
    assert.strictEqual(r.suspicious, false);
  });

  test("suspicious when drop > 30% vs single previous", () => {
    const current = makeRun({ totalMutants: 30 });
    const previous = [makeRun({ totalMutants: 50 })];
    const r = detectVolumeDrift(current, previous);
    assert.strictEqual(r.suspicious, true);
    assert.strictEqual(r.dropPercent, 40);
  });

  test("uses avg of last 3 runs", () => {
    const current = makeRun({ totalMutants: 30 });
    const history = [
      makeRun({ totalMutants: 50 }),
      makeRun({ totalMutants: 40 }),
      makeRun({ totalMutants: 60 }),
    ];
    // avg = 50, drop = 20/50 = 40%
    const r = detectVolumeDrift(current, history);
    assert.strictEqual(r.suspicious, true);
    assert.strictEqual(r.averageVolume, 50);
    assert.strictEqual(r.dropPercent, 40);
  });

  test("uses only first 3 runs even if more provided", () => {
    const current = makeRun({ totalMutants: 45 });
    const history = [
      makeRun({ totalMutants: 50 }),
      makeRun({ totalMutants: 40 }),
      makeRun({ totalMutants: 60 }),
      makeRun({ totalMutants: 10 }), // should be ignored
    ];
    // avg first3 = 50, drop = 5/50 = 10%
    const r = detectVolumeDrift(current, history);
    assert.strictEqual(r.suspicious, false);
    assert.strictEqual(r.averageVolume, 50);
  });

  test("exact boundary (30% drop) is not suspicious", () => {
    const current = makeRun({ totalMutants: 35 });
    const previous = [makeRun({ totalMutants: 50 })];
    const r = detectVolumeDrift(current, previous);
    assert.strictEqual(r.suspicious, false);
    assert.strictEqual(r.dropPercent, 30);
  });

  test("custom maxDropPercent", () => {
    const current = makeRun({ totalMutants: 40 });
    const previous = [makeRun({ totalMutants: 50 })];
    const r = detectVolumeDrift(current, previous, 15);
    assert.strictEqual(r.suspicious, true);
  });

  test("not suspicious when volume increases", () => {
    const current = makeRun({ totalMutants: 60 });
    const previous = [makeRun({ totalMutants: 50 })];
    const r = detectVolumeDrift(current, previous);
    assert.strictEqual(r.suspicious, false);
  });
});
