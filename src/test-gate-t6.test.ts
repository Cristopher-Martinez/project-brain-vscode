/**
 * T6 — Full Pipeline Integration Tests
 *
 * Tests the complete T6 orchestrator (runT6ObservabilityGate).
 * Individual module tests are in their own files.
 */

import * as assert from "assert";
import { runT6ObservabilityGate } from "./test-gate-t6";
import { makeFinalT5Result, makeDeps, makeT6Config, T5_CONFIG } from "./test-gate-t6-test-helpers";

suite("T6: Full Pipeline", () => {
  test("succeeds with valid input", async () => {
    const r = await runT6ObservabilityGate(
      makeFinalT5Result(), T5_CONFIG, makeT6Config(), makeDeps(),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.viewModel);
    assert.strictEqual(r.viewModel.protection.integrityState, "clean");
    assert.strictEqual(r.viewModel.evolution.trend, "improving");
    assert.strictEqual(r.viewModel.confidence.confidenceLabel, "high");
  });

  test("fails gracefully when input is null", async () => {
    const r = await runT6ObservabilityGate(
      null, T5_CONFIG, makeT6Config(), makeDeps(),
    );
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.viewModel, null);
  });

  test("includes advanced metrics when enabled", async () => {
    const config = makeT6Config();
    config.showAdvancedMetrics = true;
    const r = await runT6ObservabilityGate(
      makeFinalT5Result(), T5_CONFIG, config, makeDeps(),
    );
    assert.ok(r.viewModel?.advancedMetrics);
    assert.strictEqual(r.viewModel?.advancedMetrics?.rawScore, 85);
  });

  test("hides advanced metrics by default", async () => {
    const r = await runT6ObservabilityGate(
      makeFinalT5Result(), T5_CONFIG, makeT6Config(), makeDeps(),
    );
    assert.strictEqual(r.viewModel?.advancedMetrics, undefined);
  });

  test("scores pass through unchanged — no recalculation", async () => {
    const config = makeT6Config();
    config.showAdvancedMetrics = true;
    const r = await runT6ObservabilityGate(
      makeFinalT5Result({ rawScore: 77, adjustedScore: 72, deltaScore: 3 }),
      T5_CONFIG, config, makeDeps(),
    );
    assert.strictEqual(r.viewModel?.advancedMetrics?.rawScore, 77);
    assert.strictEqual(r.viewModel?.advancedMetrics?.adjustedScore, 72);
    assert.strictEqual(r.viewModel?.advancedMetrics?.deltaScore, 3);
  });
});
