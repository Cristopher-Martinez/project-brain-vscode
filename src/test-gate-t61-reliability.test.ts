/**
 * T6.1 — Reliability & Confidence Unit Tests
 */

import * as assert from "assert";
import { makeCohort } from "./test-gate-t61-test-helpers";
import {
  extractReliabilityComponents,
  computeReliabilityIndex,
  computeCohortReliability,
  getConfidenceLevel,
  applyReliabilityToCohort,
} from "./test-gate-t61-reliability";

suite("T6.1 Reliability Components", () => {
  test("extracts rates from cohort data", () => {
    const cohort = makeCohort({
      totalMutants: 100,
      survived: 20,
      criticalSurvivors: 5,
      structuralViolations: 3,
      correctionCycles: 2,
      commits: ["c1", "c2", "c3", "c4"],
    });
    const comp = extractReliabilityComponents(cohort);
    assert.strictEqual(comp.mutationSurvivalRate, 0.2); // 20/100
    assert.strictEqual(comp.criticalRegressionRate, 0.05); // 5/100
    assert.strictEqual(comp.structuralViolationRate, 0.75); // 3/4
    assert.strictEqual(comp.normalizedCorrectionCycles, 0.5); // 2/4
  });

  test("handles zero totalMutants (avoids div/0)", () => {
    const cohort = makeCohort({ totalMutants: 0, survived: 0 });
    const comp = extractReliabilityComponents(cohort);
    assert.strictEqual(comp.mutationSurvivalRate, 0); // 0/1
  });
});

suite("T6.1 Reliability Index", () => {
  test("perfect cohort scores 100", () => {
    const r = computeReliabilityIndex({
      mutationSurvivalRate: 0,
      criticalRegressionRate: 0,
      structuralViolationRate: 0,
      normalizedCorrectionCycles: 0,
    });
    assert.strictEqual(r, 100);
  });

  test("worst case clamps to 0", () => {
    const r = computeReliabilityIndex({
      mutationSurvivalRate: 1,
      criticalRegressionRate: 1,
      structuralViolationRate: 1,
      normalizedCorrectionCycles: 1,
    });
    assert.strictEqual(r, 0);
  });

  test("mixed rates produce intermediate score", () => {
    const r = computeReliabilityIndex({
      mutationSurvivalRate: 0.2,
      criticalRegressionRate: 0.05,
      structuralViolationRate: 0.1,
      normalizedCorrectionCycles: 0.1,
    });
    // 100 - (0.2*40) - (0.05*30) - (0.1*20) - (0.1*10) = 100 - 8 - 1.5 - 2 - 1 = 87.5
    assert.strictEqual(r, 87.5);
  });

  test("computeCohortReliability convenience wrapper", () => {
    const cohort = makeCohort({
      totalMutants: 100,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
      commits: ["c1"],
    });
    const r = computeCohortReliability(cohort);
    assert.strictEqual(r, 100);
  });
});

suite("T6.1 Confidence Level", () => {
  test("< 300 → low", () => {
    assert.strictEqual(getConfidenceLevel(0), "low");
    assert.strictEqual(getConfidenceLevel(299), "low");
  });

  test("300-1000 → medium", () => {
    assert.strictEqual(getConfidenceLevel(300), "medium");
    assert.strictEqual(getConfidenceLevel(1000), "medium");
  });

  test("> 1000 → high", () => {
    assert.strictEqual(getConfidenceLevel(1001), "high");
    assert.strictEqual(getConfidenceLevel(5000), "high");
  });
});

suite("T6.1 Apply Reliability", () => {
  test("applies reliability and confidence to closed cohort", () => {
    const cohort = makeCohort({
      closed: true,
      totalMutants: 100,
      survived: 0,
      criticalSurvivors: 0,
      structuralViolations: 0,
      correctionCycles: 0,
      accumulatedWeight: 500,
      commits: ["c1"],
    });
    const result = applyReliabilityToCohort(cohort);
    assert.strictEqual(result.reliabilityIndex, 100);
    assert.strictEqual(result.confidenceLevel, "medium");
  });

  test("skips open cohorts", () => {
    const cohort = makeCohort({ closed: false });
    const result = applyReliabilityToCohort(cohort);
    assert.strictEqual(result.reliabilityIndex, null); // unchanged — open cohorts keep null
  });
});
