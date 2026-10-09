/**
 * T6.1 — Cohorts Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCohort, makeT61Config } from "./test-gate-t61-test-helpers";
import { initT61Schema, upsertCohort } from "./test-gate-t61-storage";
import {
  calculateCohortThreshold,
  getOrCreateActiveCohort,
  accumulateIntoCohort,
  incrementCorrectionCycles,
} from "./test-gate-t61-cohorts";

suite("T6.1 Cohort Threshold", () => {
  test("returns default 300 with no history", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const threshold = calculateCohortThreshold(deps, "gpt-4");
    assert.strictEqual(threshold.value, 300);
    assert.strictEqual(threshold.source, "default");
  });

  test("returns dynamic threshold when > default", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    // Insert closed cohorts with high weights
    upsertCohort(deps, makeCohort({ cohortIndex: 0, closed: true, accumulatedWeight: 500 }));
    upsertCohort(deps, makeCohort({ cohortIndex: 1, closed: true, accumulatedWeight: 700 }));
    const threshold = calculateCohortThreshold(deps, "gpt-4");
    // avg = 600, dynamic = 600 * 5 = 3000
    assert.strictEqual(threshold.value, 3000);
    assert.strictEqual(threshold.source, "dynamic");
  });

  test("returns default when dynamic < default", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0, closed: true, accumulatedWeight: 10 }));
    const threshold = calculateCohortThreshold(deps, "gpt-4");
    // avg = 10, dynamic = 50, max(300, 50) = 300
    assert.strictEqual(threshold.value, 300);
    assert.strictEqual(threshold.source, "default");
  });
});

suite("T6.1 Cohort Management", () => {
  test("getOrCreateActiveCohort creates new if none exists", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const cohort = getOrCreateActiveCohort(deps, "gpt-4");
    assert.strictEqual(cohort.modelId, "gpt-4");
    assert.strictEqual(cohort.cohortIndex, 0);
    assert.strictEqual(cohort.closed, false);
  });

  test("getOrCreateActiveCohort returns existing", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0 }));
    const cohort = getOrCreateActiveCohort(deps, "gpt-4");
    assert.strictEqual(cohort.cohortIndex, 0);
  });

  test("accumulateIntoCohort adds weight and commit", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const { cohort } = accumulateIntoCohort(deps, "gpt-4", {
      commitHash: "c1",
      weight: 100,
      rawScore: 80,
      adjustedScore: 75,
      totalMutants: 10,
      survived: 2,
      criticalSurvivors: 0,
      structuralViolations: 1,
    });
    assert.strictEqual(cohort.accumulatedWeight, 100);
    assert.deepStrictEqual(cohort.commits, ["c1"]);
    assert.strictEqual(cohort.totalMutants, 10);
  });

  test("accumulateIntoCohort closes when threshold met", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const config = makeT61Config({ defaultCohortThreshold: 100 });
    const { closed } = accumulateIntoCohort(
      deps,
      "gpt-4",
      {
        commitHash: "c1",
        weight: 150,
        rawScore: 80,
        adjustedScore: 75,
        totalMutants: 10,
        survived: 2,
        criticalSurvivors: 0,
        structuralViolations: 1,
      },
      config,
    );
    assert.strictEqual(closed, true);
  });

  test("incrementCorrectionCycles increments active cohort", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0, correctionCycles: 0 }));
    incrementCorrectionCycles(deps, "gpt-4", 0);
    const table = deps.tables.get("model_cohorts")!;
    assert.strictEqual(table[0].correction_cycles, 1);
  });
});
