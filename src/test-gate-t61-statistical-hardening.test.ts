/**
 * T6.1 — Statistical Hardening Test Suite
 *
 * Validates hardening requirements:
 * H1: Robust cohort threshold with median
 * H2: Minimum stability rule
 * H3: Volatility guard
 * H4: Determinism guarantee
 * H5: Stability status computation
 * H6: Backward compatibility
 * H7: Type conformance
 */

import * as assert from "assert";
import { makeCohort, makeT61Deps } from "./test-gate-t61-test-helpers";
import { calculateMedian, calculateCohortThreshold } from "./test-gate-t61-cohorts";
import { initT61Schema } from "./test-gate-t61-storage";
import {
  meetsMinimumStability,
  detectVolatility,
  computeStabilityStatus,
  applyReliabilityToCohort,
  type StabilityContext,
} from "./test-gate-t61-reliability";
import type { ModelCohort } from "./test-gate-t61-types";

// --- H1: Robust Cohort Threshold ---

suite("T6.1 Hardening: Threshold", () => {
  test("H1.1: no cohorts -> base threshold 300", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const result = calculateCohortThreshold(deps, "gpt-4o");
    assert.strictEqual(result.value, 300);
    assert.strictEqual(result.source, "default");
  });

  test("H1.2: even-length median is average of two middle", () => {
    assert.strictEqual(calculateMedian([10, 20, 30, 40]), 25);
  });

  test("H1.3: single element median equals element", () => {
    assert.strictEqual(calculateMedian([42]), 42);
  });

  test("H1.4: deterministic median (no randomness)", () => {
    const vals = [300, 100, 200];
    assert.strictEqual(calculateMedian(vals), calculateMedian(vals));
  });
});

// --- H2: Minimum Stability Rule ---

suite("T6.1 Hardening: Min Stability", () => {
  test("H2.1: 1 closed cohort -> insufficient", () => {
    const c1 = makeCohort({
      closed: true,
      accumulatedWeight: 500,
      totalMutants: 50,
    });
    const ctx: StabilityContext = { closedCohorts: [c1] };
    assert.strictEqual(meetsMinimumStability(ctx), false);
  });

  test("H2.2: R blocked with insufficient data", () => {
    const cohort = makeCohort({
      closed: true,
      accumulatedWeight: 500,
      totalMutants: 50,
    });
    const result = applyReliabilityToCohort(cohort, {
      closedCohorts: [],
    });
    assert.strictEqual(result.reliabilityIndex, null);
    assert.strictEqual(result.confidenceLevel, "insufficient-data");
    assert.strictEqual(result.stabilityStatus, "insufficient-data");
  });
});

suite("T6.1 Hardening: Stability Threshold", () => {
  test("H2.3: R allowed with >=2 cohorts, weight >=300, mutants >=10", () => {
    const c1 = makeCohort({
      closed: true,
      accumulatedWeight: 200,
      totalMutants: 8,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
    });
    const c2 = makeCohort({
      closed: true,
      accumulatedWeight: 150,
      totalMutants: 5,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
    });
    const result = applyReliabilityToCohort(c2, {
      closedCohorts: [c1],
    });
    assert.ok(typeof result.reliabilityIndex === "number");
    assert.notStrictEqual(result.confidenceLevel, "insufficient-data");
  });

  test("H2.4: insufficient mutants blocks R", () => {
    const c1 = makeCohort({
      closed: true,
      accumulatedWeight: 200,
      totalMutants: 2,
    });
    const c2 = makeCohort({
      closed: true,
      accumulatedWeight: 200,
      totalMutants: 3,
    });
    const ctx: StabilityContext = { closedCohorts: [c1, c2] };
    assert.strictEqual(meetsMinimumStability(ctx), false);
  });
});

// --- H3: Volatility Guard ---

suite("T6.1 Hardening: Volatility", () => {
  test("H3.1: volatility detection thresholds", () => {
    assert.strictEqual(detectVolatility(80, 50), true);
    assert.strictEqual(detectVolatility(80, 60), false);
    assert.strictEqual(detectVolatility(80, 55), false);
    assert.strictEqual(detectVolatility(50, 80), true);
    assert.strictEqual(detectVolatility(80, null), false);
  });

  test("H3.2: volatility flag set on cohort", () => {
    const prev = makeCohort({
      closed: true,
      accumulatedWeight: 200,
      totalMutants: 10,
      reliabilityIndex: 50,
    });
    const current = makeCohort({
      closed: true,
      accumulatedWeight: 200,
      totalMutants: 10,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
    });
    const result = applyReliabilityToCohort(current, {
      closedCohorts: [prev],
    });
    assert.strictEqual(result.volatilityFlag, true);
    assert.strictEqual(result.stabilityStatus, "unstable");
  });
});

// --- H4/H5: Stability Status ---

suite("T6.1 Hardening: Status", () => {
  test("H5.1: computeStabilityStatus states", () => {
    const empty: StabilityContext = { closedCohorts: [] };
    assert.strictEqual(
      computeStabilityStatus(empty, null, null),
      "insufficient-data",
    );

    const ok: StabilityContext = {
      closedCohorts: [
        makeCohort({ closed: true, accumulatedWeight: 200, totalMutants: 8 }),
        makeCohort({ closed: true, accumulatedWeight: 200, totalMutants: 8 }),
      ],
    };
    assert.strictEqual(computeStabilityStatus(ok, 80, 75), "stable");
    assert.strictEqual(computeStabilityStatus(ok, 80, 50), "unstable");
  });
});

// --- H6: Backward Compatibility ---

suite("T6.1 Hardening: Compat", () => {
  test("H6.1: no context -> basic reliability", () => {
    const cohort = makeCohort({
      closed: true,
      accumulatedWeight: 500,
      totalMutants: 100,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
    });
    const result = applyReliabilityToCohort(cohort);
    assert.strictEqual(result.reliabilityIndex, 100);
    assert.strictEqual(result.confidenceLevel, "medium");
    assert.strictEqual(result.volatilityFlag, false);
    assert.strictEqual(result.stabilityStatus, "insufficient-data");
  });
});

// --- H7: Type Conformance ---

suite("T6.1 Hardening: Types", () => {
  test("H7.1: ModelCohort has all hardening fields", () => {
    const cohort: ModelCohort = makeCohort();
    assert.strictEqual(typeof cohort.volatilityFlag, "boolean");
    assert.ok(
      ["stable", "unstable", "insufficient-data"]
        .includes(cohort.stabilityStatus),
    );
    assert.strictEqual(cohort.reliabilityIndex, null);
    assert.strictEqual(cohort.confidenceLevel, "insufficient-data");
  });
});
