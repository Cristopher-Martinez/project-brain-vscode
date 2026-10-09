/**
 * T6.1 — Corrections Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCommit, makeCohort } from "./test-gate-t61-test-helpers";
import { initT61Schema, insertCommit, upsertCohort } from "./test-gate-t61-storage";
import {
  detectCorrectionCycle,
  detectMetricReductions,
  getCohortFiles,
} from "./test-gate-t61-corrections";

suite("T6.1 Metric Reductions", () => {
  test("detects survived reduction", () => {
    const deltas = detectMetricReductions(
      { survived: 5, criticalSurvivors: 2, structuralViolations: 3 },
      { survived: 3, criticalSurvivors: 2, structuralViolations: 3 },
    );
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0].metric, "survived");
    assert.strictEqual(deltas[0].before, 5);
    assert.strictEqual(deltas[0].after, 3);
  });

  test("detects multiple reductions", () => {
    const deltas = detectMetricReductions(
      { survived: 5, criticalSurvivors: 2, structuralViolations: 3 },
      { survived: 3, criticalSurvivors: 1, structuralViolations: 3 },
    );
    assert.strictEqual(deltas.length, 2);
  });

  test("returns empty for no reductions", () => {
    const deltas = detectMetricReductions(
      { survived: 3, criticalSurvivors: 1, structuralViolations: 2 },
      { survived: 3, criticalSurvivors: 1, structuralViolations: 2 },
    );
    assert.strictEqual(deltas.length, 0);
  });

  test("returns empty for increases", () => {
    const deltas = detectMetricReductions(
      { survived: 3, criticalSurvivors: 1, structuralViolations: 2 },
      { survived: 5, criticalSurvivors: 3, structuralViolations: 4 },
    );
    assert.strictEqual(deltas.length, 0);
  });
});

suite("T6.1 Correction Cycle Detection", () => {
  test("detects correction when all conditions met", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const commit = makeCommit({
      commitHash: "fix1",
      modelId: "human",
      filesModified: ["src/foo.ts"],
    });
    const cohort = makeCohort({
      cohortIndex: 0,
      commits: ["c1"],
      closed: false,
    });
    const cohortFiles = new Set(["src/foo.ts"]);
    const result = detectCorrectionCycle(
      deps,
      commit,
      cohort,
      { survived: 5, criticalSurvivors: 2, structuralViolations: 1 },
      { survived: 3, criticalSurvivors: 2, structuralViolations: 1 },
      cohortFiles,
    );
    assert.ok(result);
    assert.strictEqual(result.correctorCommitHash, "fix1");
    assert.strictEqual(result.reducedMetrics.length, 1);
  });

  test("returns null for closed cohort", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const cohort = makeCohort({ closed: true });
    const result = detectCorrectionCycle(
      deps,
      makeCommit({ filesModified: ["src/foo.ts"] }),
      cohort,
      { survived: 5, criticalSurvivors: 2, structuralViolations: 1 },
      { survived: 3, criticalSurvivors: 2, structuralViolations: 1 },
      new Set(["src/foo.ts"]),
    );
    assert.strictEqual(result, null);
  });

  test("returns null when no overlapping files", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const result = detectCorrectionCycle(
      deps,
      makeCommit({ filesModified: ["src/bar.ts"] }),
      makeCohort({ closed: false }),
      { survived: 5, criticalSurvivors: 2, structuralViolations: 1 },
      { survived: 3, criticalSurvivors: 2, structuralViolations: 1 },
      new Set(["src/foo.ts"]),
    );
    assert.strictEqual(result, null);
  });

  test("returns null when no metric reduction", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    const result = detectCorrectionCycle(
      deps,
      makeCommit({ filesModified: ["src/foo.ts"] }),
      makeCohort({ closed: false }),
      { survived: 3, criticalSurvivors: 1, structuralViolations: 1 },
      { survived: 3, criticalSurvivors: 1, structuralViolations: 1 },
      new Set(["src/foo.ts"]),
    );
    assert.strictEqual(result, null);
  });
});

suite("T6.1 Cohort Files", () => {
  test("getCohortFiles returns files from cohort commits", () => {
    const deps = makeT61Deps();
    initT61Schema(deps);
    insertCommit(deps, makeCommit({
      commitHash: "c1",
      modelId: "gpt-4",
      filesModified: ["src/a.ts", "src/b.ts"],
    }));
    insertCommit(deps, makeCommit({
      commitHash: "c2",
      modelId: "gpt-4",
      filesModified: ["src/b.ts", "src/c.ts"],
    }));
    const cohort = makeCohort({ commits: ["c1", "c2"] });
    const files = getCohortFiles(deps, cohort);
    assert.strictEqual(files.size, 3);
    assert.ok(files.has("src/a.ts"));
    assert.ok(files.has("src/b.ts"));
    assert.ok(files.has("src/c.ts"));
  });
});
