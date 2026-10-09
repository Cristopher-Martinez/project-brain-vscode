/**
 * T6.1 — Types & Config Unit Tests
 */

import * as assert from "assert";
import { DEFAULT_T61_CONFIG } from "./test-gate-t61-types";
import type {
  T61Config,
  ConfidenceLevel,
  ModelCommit,
  ModelCohort,
} from "./test-gate-t61-types";

suite("T6.1 Types & Config", () => {
  test("DEFAULT_T61_CONFIG has correct threshold", () => {
    assert.strictEqual(DEFAULT_T61_CONFIG.defaultCohortThreshold, 300);
  });

  test("DEFAULT_T61_CONFIG has correct multiplier", () => {
    assert.strictEqual(DEFAULT_T61_CONFIG.dynamicThresholdMultiplier, 5);
  });

  test("DEFAULT_T61_CONFIG has correct window", () => {
    assert.strictEqual(DEFAULT_T61_CONFIG.dynamicThresholdWindow, 20);
  });

  test("DEFAULT_T61_CONFIG satisfies T61Config interface", () => {
    const config: T61Config = DEFAULT_T61_CONFIG;
    assert.ok(typeof config.defaultCohortThreshold === "number");
    assert.ok(typeof config.dynamicThresholdMultiplier === "number");
    assert.ok(typeof config.dynamicThresholdWindow === "number");
  });

  test("ConfidenceLevel union matches known values", () => {
    const levels: ConfidenceLevel[] = ["low", "medium", "high"];
    assert.strictEqual(levels.length, 3);
    assert.ok(levels.includes("low"));
    assert.ok(levels.includes("medium"));
    assert.ok(levels.includes("high"));
  });

  test("ModelCommit interface shape is valid", () => {
    const commit: ModelCommit = {
      commitHash: "abc123",
      modelId: "gpt-4",
      timestamp: new Date().toISOString(),
      linesAdded: 10,
      linesRemoved: 5,
      filesModified: ["a.ts"],
    };
    assert.strictEqual(commit.modelId, "gpt-4");
    assert.ok(Array.isArray(commit.filesModified));
  });

  test("ModelCohort interface shape is valid", () => {
    const cohort: ModelCohort = {
      modelId: "gpt-4",
      cohortIndex: 0,
      commits: ["abc123"],
      accumulatedWeight: 100,
      rawScoreAvg: 80,
      adjustedScoreAvg: 75,
      totalMutants: 50,
      survived: 10,
      criticalSurvivors: 2,
      structuralViolations: 3,
      correctionCycles: 0,
      reliabilityIndex: 85,
      confidenceLevel: "medium",
      volatilityFlag: false,
      stabilityStatus: "stable",
      closed: false,
    };
    assert.strictEqual(cohort.closed, false);
    assert.strictEqual(cohort.reliabilityIndex, 85);
  });
});
