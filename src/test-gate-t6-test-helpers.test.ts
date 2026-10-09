/**
 * T6 — Test Helpers Unit Tests
 *
 * Validates that shared factory functions produce correct shapes.
 */

import * as assert from "assert";
import {
  makeEngineResult,
  makeFinalT5Result,
  makeDeps,
  makeT6Config,
  makeGovConfig,
  makeArtifact,
  T5_CONFIG,
} from "./test-gate-t6-test-helpers";

suite("T6 Test Helpers", () => {
  test("makeEngineResult returns valid engine result", () => {
    const result = makeEngineResult();
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.globalScore, 80);
    assert.strictEqual(result.totalMutants, 10);
    assert.strictEqual(result.killed, 8);
    assert.strictEqual(result.survived, 2);
    assert.strictEqual(result.ready_for_T6, true);
  });

  test("makeFinalT5Result returns valid result with overrides", () => {
    const result = makeFinalT5Result({ rawScore: 90, blocking: true });
    assert.strictEqual(result.rawScore, 90);
    assert.strictEqual(result.blocking, true);
    assert.strictEqual(result.adjustedScore, 80); // default
    assert.ok(result.engineResult);
  });

  test("makeDeps returns functional in-memory deps", async () => {
    const deps = makeDeps();
    assert.strictEqual(await deps.readFile("nonexistent"), null);
    await deps.writeFile("test.json", '{"a":1}');
    assert.strictEqual(await deps.readFile("test.json"), '{"a":1}');
  });

  test("makeDeps accepts overrides", async () => {
    const customLog: string[] = [];
    const deps = makeDeps({ log: (msg: string) => customLog.push(msg) });
    deps.log("hello");
    assert.deepStrictEqual(customLog, ["hello"]);
  });

  test("makeT6Config returns valid config", () => {
    const config = makeT6Config();
    assert.strictEqual(config.configHistoryDir, ".t6-config-history");
    assert.strictEqual(config.governanceConfigPath, ".t6-governance.json");
    assert.strictEqual(config.showAdvancedMetrics, false);
    assert.ok(config.elConfig);
  });

  test("makeGovConfig returns valid governance config with overrides", () => {
    const config = makeGovConfig({ policyMode: "enforce" });
    assert.strictEqual(config.policyMode, "enforce");
    assert.strictEqual(config.globalMinScore, 65); // default
    assert.strictEqual(config.maxMutantsPerFile, 30);
  });

  test("makeArtifact returns valid mutation run", () => {
    const artifact = makeArtifact({ rawScore: 95 });
    assert.strictEqual(artifact.rawScore, 95);
    assert.strictEqual(artifact.commit, "abc123"); // default
    assert.strictEqual(artifact.killed, 8);
  });

  test("T5_CONFIG has expected shape", () => {
    assert.strictEqual(T5_CONFIG.maxMutantsPerFile, 30);
    assert.strictEqual(T5_CONFIG.maxTotalMutantsPerRun, 150);
    assert.strictEqual(T5_CONFIG.mutationTimeoutMs, 30000);
  });
});
