/**
 * T6.1 — Attribution & Change Weight Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCommit } from "./test-gate-t61-test-helpers";
import { initT61Schema } from "./test-gate-t61-storage";
import {
  attributeCommit,
  attributeCommits,
  calculateChangeWeight,
  calculateCommitWeight,
  shouldAccumulateWeight,
} from "./test-gate-t61-attribution";

suite("T6.1 Attribution", () => {
  test("attributeCommit stores commit and returns true", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const result = attributeCommit(deps, makeCommit({ commitHash: "c1" }));
    assert.strictEqual(result, true);
  });

  test("attributeCommit returns false for duplicate", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    attributeCommit(deps, makeCommit({ commitHash: "c1" }));
    const result = attributeCommit(deps, makeCommit({ commitHash: "c1" }));
    assert.strictEqual(result, false);
  });

  test("attributeCommit defaults modelId to human", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    attributeCommit(deps, {
      commitHash: "c2",
      timestamp: new Date().toISOString(),
      linesAdded: 10,
      linesRemoved: 5,
      filesModified: ["a.ts"],
    });
    const stored = deps.tables.get("model_commits")!;
    assert.strictEqual(stored[0].model_id, "human");
  });

  test("attributeCommits batch returns count of new", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const count = attributeCommits(deps, [
      makeCommit({ commitHash: "c1" }),
      makeCommit({ commitHash: "c2" }),
      makeCommit({ commitHash: "c1" }), // duplicate
    ]);
    assert.strictEqual(count, 2);
  });
});

suite("T6.1 Change Weight", () => {
  test("calculateChangeWeight sums all components equally", () => {
    const cw = calculateChangeWeight({
      linesAdded: 50,
      linesRemoved: 10,
      totalMutants: 20,
      structuralViolations: 5,
    });
    assert.strictEqual(cw, 85); // 50 + 10 + 20 + 5
  });

  test("calculateChangeWeight with zeros", () => {
    const cw = calculateChangeWeight({
      linesAdded: 0,
      linesRemoved: 0,
      totalMutants: 0,
      structuralViolations: 0,
    });
    assert.strictEqual(cw, 0);
  });

  test("calculateCommitWeight combines commit stats with mutation data", () => {
    const commit = makeCommit({ linesAdded: 100, linesRemoved: 20 });
    const cw = calculateCommitWeight(commit, 30, 5);
    assert.strictEqual(cw, 155); // 100 + 20 + 30 + 5
  });

  test("shouldAccumulateWeight returns false for human", () => {
    assert.strictEqual(shouldAccumulateWeight("human"), false);
  });

  test("shouldAccumulateWeight returns true for models", () => {
    assert.strictEqual(shouldAccumulateWeight("gpt-4"), true);
    assert.strictEqual(shouldAccumulateWeight("claude-3"), true);
  });
});
