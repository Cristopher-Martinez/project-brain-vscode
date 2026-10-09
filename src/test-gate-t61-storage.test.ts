/**
 * T6.1 — Storage Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCommit, makeCohort } from "./test-gate-t61-test-helpers";
import {
  initT61Schema,
  insertCommit,
  getCommit,
  getCommitsByModel,
  upsertCohort,
  getActiveCohort,
  getClosedCohorts,
  getRecentCohortWeights,
  getNextCohortIndex,
  insertCorrection,
  getCorrectionCount,
  getDistinctModels,
} from "./test-gate-t61-storage";

suite("T6.1 Storage", () => {
  test("initT61Schema creates all 3 tables", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    assert.ok(deps.tables.has("model_commits"));
    assert.ok(deps.tables.has("model_cohorts"));
    assert.ok(deps.tables.has("model_corrections"));
  });

  test("insertCommit + getCommit roundtrip", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const commit = makeCommit({ commitHash: "hash1" });
    insertCommit(deps, commit);
    const result = getCommit(deps, "hash1");
    assert.ok(result);
    assert.strictEqual(result.commitHash, "hash1");
    assert.strictEqual(result.modelId, "gpt-4");
  });

  test("getCommitsByModel returns only matching model", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    insertCommit(deps, makeCommit({ commitHash: "h1", modelId: "gpt-4" }));
    insertCommit(deps, makeCommit({ commitHash: "h2", modelId: "claude-3" }));
    insertCommit(deps, makeCommit({ commitHash: "h3", modelId: "gpt-4" }));
    const gptCommits = getCommitsByModel(deps, "gpt-4");
    assert.strictEqual(gptCommits.length, 2);
  });

  test("upsertCohort + getActiveCohort roundtrip", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const cohort = makeCohort({ modelId: "gpt-4", cohortIndex: 0 });
    upsertCohort(deps, cohort);
    const active = getActiveCohort(deps, "gpt-4");
    assert.ok(active);
    assert.strictEqual(active.modelId, "gpt-4");
    assert.strictEqual(active.closed, false);
  });

  test("getClosedCohorts returns only closed", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0, closed: true }));
    upsertCohort(deps, makeCohort({ cohortIndex: 1, closed: false }));
    const closed = getClosedCohorts(deps, "gpt-4");
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].cohortIndex, 0);
  });

  test("getRecentCohortWeights returns weights of closed cohorts", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0, closed: true, accumulatedWeight: 400 }));
    upsertCohort(deps, makeCohort({ cohortIndex: 1, closed: true, accumulatedWeight: 600 }));
    const weights = getRecentCohortWeights(deps, "gpt-4", 5);
    assert.strictEqual(weights.length, 2);
  });

  test("getNextCohortIndex returns 0 for new model", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    assert.strictEqual(getNextCohortIndex(deps, "new-model"), 0);
  });

  test("getNextCohortIndex returns max+1", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    upsertCohort(deps, makeCohort({ cohortIndex: 0 }));
    upsertCohort(deps, makeCohort({ cohortIndex: 1 }));
    assert.strictEqual(getNextCohortIndex(deps, "gpt-4"), 2);
  });

  test("insertCorrection + getCorrectionCount", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    insertCorrection(deps, {
      correctorCommitHash: "fix1",
      correctorModelId: "human",
      targetCohortModelId: "gpt-4",
      targetCohortIndex: 0,
      reducedMetrics: [{ metric: "survived", before: 5, after: 3 }],
      timestamp: new Date().toISOString(),
    });
    const count = getCorrectionCount(deps, "gpt-4", 0);
    assert.strictEqual(count, 1);
  });

  test("getDistinctModels returns unique model IDs", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    insertCommit(deps, makeCommit({ commitHash: "h1", modelId: "gpt-4" }));
    insertCommit(deps, makeCommit({ commitHash: "h2", modelId: "claude-3" }));
    insertCommit(deps, makeCommit({ commitHash: "h3", modelId: "gpt-4" }));
    const models = getDistinctModels(deps);
    assert.strictEqual(models.length, 2);
    assert.ok(models.includes("gpt-4"));
    assert.ok(models.includes("claude-3"));
  });
});
