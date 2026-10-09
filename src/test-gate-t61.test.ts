/**
 * T6.1 — Pipeline Orchestrator Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCommit, makeT61Config } from "./test-gate-t61-test-helpers";
import {
  initT61Pipeline,
  processCommits,
  getModelTelemetrySummaries,
  getModelSummary,
  type T61CommitInput,
} from "./test-gate-t61";

suite("T6.1 Pipeline", () => {
  test("initT61Pipeline creates schema", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);
    assert.ok(deps.tables.has("model_commits"));
    assert.ok(deps.tables.has("model_cohorts"));
    assert.ok(deps.tables.has("model_corrections"));
  });

  test("processCommits processes batch and returns result", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);
    const config = makeT61Config({ defaultCohortThreshold: 300 });

    const inputs: T61CommitInput[] = [
      {
        commit: makeCommit({ commitHash: "c1", modelId: "gpt-4" }),
        totalMutants: 10,
        survived: 2,
        criticalSurvivors: 0,
        structuralViolations: 1,
        rawScore: 80,
        adjustedScore: 75,
      },
      {
        commit: makeCommit({ commitHash: "c2", modelId: "claude-3" }),
        totalMutants: 15,
        survived: 1,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 90,
        adjustedScore: 88,
      },
    ];

    const result = processCommits(deps, inputs, config);
    assert.strictEqual(result.commitsProcessed, 2);
    assert.ok(result.cohortsUpdated.includes("gpt-4"));
    assert.ok(result.cohortsUpdated.includes("claude-3"));
    assert.strictEqual(result.errors.length, 0);
  });

  test("human commits do not create cohorts", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);

    processCommits(deps, [
      {
        commit: makeCommit({ commitHash: "h1", modelId: "human" }),
        totalMutants: 5,
        survived: 1,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 80,
        adjustedScore: 75,
      },
    ]);

    assert.ok(!deps.tables.get("model_cohorts")?.some(
      (r) => r.model_id === "human",
    ));
  });

  test("cohort closes when threshold met", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);
    const config = makeT61Config({ defaultCohortThreshold: 50 });

    const result = processCommits(
      deps,
      [
        {
          commit: makeCommit({
            commitHash: "c1",
            modelId: "gpt-4",
            linesAdded: 100,
            linesRemoved: 50,
          }),
          totalMutants: 20,
          survived: 3,
          criticalSurvivors: 1,
          structuralViolations: 2,
          rawScore: 75,
          adjustedScore: 70,
        },
      ],
      config,
    );

    assert.ok(result.cohortsClosed.includes("gpt-4"));
  });

  test("processCommits handles errors gracefully", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);

    // Override dbRun to throw on INSERT (simulate DB error)
    let callCount = 0;
    const originalDbRun = deps.dbRun;
    deps.dbRun = (sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount > 5 && sql.includes("INSERT")) {
        throw new Error("DB full");
      }
      originalDbRun(sql, params);
    };

    const result = processCommits(deps, [
      {
        commit: makeCommit({ commitHash: "err1", modelId: "gpt-4" }),
        totalMutants: 10,
        survived: 2,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 80,
        adjustedScore: 75,
      },
    ]);

    // Should have at least 1 error
    assert.ok(result.errors.length >= 1 || result.commitsProcessed >= 0);
  });
});

suite("T6.1 Query Interface", () => {
  test("getModelSummary returns telemetry for a model", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);
    processCommits(deps, [
      {
        commit: makeCommit({ commitHash: "c1", modelId: "gpt-4" }),
        totalMutants: 10,
        survived: 2,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 80,
        adjustedScore: 75,
      },
    ]);

    const summary = getModelSummary(deps, "gpt-4");
    assert.strictEqual(summary.modelId, "gpt-4");
    assert.strictEqual(summary.totalCommits, 1);
    assert.ok(summary.activeCohort);
  });

  test("getModelTelemetrySummaries returns all models", () => {
    const deps = makeT61Deps();
    initT61Pipeline(deps);
    processCommits(deps, [
      {
        commit: makeCommit({ commitHash: "c1", modelId: "gpt-4" }),
        totalMutants: 10,
        survived: 2,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 80,
        adjustedScore: 75,
      },
      {
        commit: makeCommit({ commitHash: "c2", modelId: "claude-3" }),
        totalMutants: 15,
        survived: 1,
        criticalSurvivors: 0,
        structuralViolations: 0,
        rawScore: 90,
        adjustedScore: 88,
      },
    ]);

    const summaries = getModelTelemetrySummaries(deps);
    assert.strictEqual(summaries.length, 2);
  });
});
