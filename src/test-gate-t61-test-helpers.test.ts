/**
 * T6.1 — Test Helpers Unit Tests
 */

import * as assert from "assert";
import { makeT61Deps, makeCommit, makeCohort, makeT61Config } from "./test-gate-t61-test-helpers";

suite("T6.1 Test Helpers", () => {
  test("makeT61Deps creates in-memory deps with empty tables", () => {
    const deps = makeT61Deps();
    assert.ok(deps.tables);
    assert.strictEqual(deps.tables.size, 0);
  });

  test("makeT61Deps dbRun creates tables", () => {
    const deps = makeT61Deps();
    deps.dbRun("CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)");
    assert.ok(deps.tables.has("test_table"));
    assert.strictEqual(deps.tables.get("test_table")!.length, 0);
  });

  test("makeT61Deps supports INSERT and SELECT", () => {
    const deps = makeT61Deps();
    deps.dbRun("CREATE TABLE IF NOT EXISTS items (name TEXT PRIMARY KEY, value INTEGER)");
    deps.dbRun("INSERT OR IGNORE INTO items (name, value) VALUES (?, ?)", ["a", 1]);
    deps.dbRun("INSERT OR IGNORE INTO items (name, value) VALUES (?, ?)", ["b", 2]);
    const rows = deps.dbAll("SELECT * FROM items");
    assert.strictEqual(rows.length, 2);
  });

  test("makeT61Deps INSERT OR IGNORE skips duplicates", () => {
    const deps = makeT61Deps();
    deps.dbRun("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)");
    deps.dbRun("INSERT OR IGNORE INTO items (id) VALUES (?)", ["x"]);
    deps.dbRun("INSERT OR IGNORE INTO items (id) VALUES (?)", ["x"]);
    assert.strictEqual(deps.tables.get("items")!.length, 1);
  });

  test("makeCommit returns valid commit with defaults", () => {
    const commit = makeCommit();
    assert.strictEqual(commit.modelId, "gpt-4");
    assert.strictEqual(commit.linesAdded, 50);
    assert.ok(commit.commitHash);
  });

  test("makeCommit accepts overrides", () => {
    const commit = makeCommit({ modelId: "claude-3", linesAdded: 100 });
    assert.strictEqual(commit.modelId, "claude-3");
    assert.strictEqual(commit.linesAdded, 100);
  });

  test("makeCohort returns valid closed=false cohort", () => {
    const cohort = makeCohort();
    assert.strictEqual(cohort.closed, false);
    assert.strictEqual(cohort.modelId, "gpt-4");
  });

  test("makeT61Config returns DEFAULT_T61_CONFIG by default", () => {
    const config = makeT61Config();
    assert.strictEqual(config.defaultCohortThreshold, 300);
    assert.strictEqual(config.dynamicThresholdMultiplier, 5);
  });
});
