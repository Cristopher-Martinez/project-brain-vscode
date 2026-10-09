/**
 * test-gate-adversarial-hardening.test.ts — Tests for T4-HARDENING-1 (S11–S15).
 *
 * Validates the 5 hardening adversarial scenarios that address
 * structural gaps identified during audit:
 * - S11: Internal module inflation   (FIX 1: min > average)
 * - S12: Textual association w/o execution (FIX 2: hasExecution)
 * - S13: HPD boundary exact           (FIX 3: >= vs >)
 * - S14: Downgrade with coverage drop (FIX 4: coverage guard)
 * - S15: Sentinel mutation integrity  (FIX 5: meta-sentinel)
 */

import * as assert from "assert";
import { runHardeningScenarios } from "../test-gate-adversarial-hardening";
import type { AdversarialScenarioResult } from "../test-gate-structural";

suite("T4-HARDENING-1: Adversarial Scenarios S11–S15", () => {
  let results: AdversarialScenarioResult[];

  suiteSetup(() => {
    results = runHardeningScenarios();
  });

  // ——— Suite-level invariants ————————————————————————————
  test("returns exactly 5 hardening scenario results", () => {
    assert.strictEqual(results.length, 5);
  });

  test("all scenario IDs are S11..S15 in order", () => {
    const ids = results.map((r) => r.id);
    assert.deepStrictEqual(ids, ["S11", "S12", "S13", "S14", "S15"]);
  });

  test("every result has a non-empty explanation", () => {
    for (const r of results) {
      assert.ok(
        r.explanation && r.explanation.length > 0,
        `${r.id} (${r.name}): explanation must not be empty`,
      );
    }
  });

  // ——— Individual Scenario Verification ——————————————————
  test("S11 — Internal Module Inflation: min prevents average trick", () => {
    const s = results.find((r) => r.id === "S11")!;
    assert.ok(s, "S11 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block when min coverage < threshold despite high average",
    );
    assert.strictEqual(
      s.expected_block,
      true,
      "Scenario expects a block",
    );
  });

  test("S12 — Textual Association Without Execution: blocks zero linePct", () => {
    const s = results.find((r) => r.id === "S12")!;
    assert.ok(s, "S12 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block when invariant file has linePct = 0 despite textual match",
    );
  });

  test("S13 — HPD Boundary Exact: 60→PASS, 59→FAIL", () => {
    const s = results.find((r) => r.id === "S13")!;
    assert.ok(s, "S13 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  test("S14 — Downgrade With Coverage Drop: blocks despite valid justification", () => {
    const s = results.find((r) => r.id === "S14")!;
    assert.ok(s, "S14 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block downgrade when coverage drops >10% even with valid justification",
    );
  });

  test("S15 — Sentinel Mutation Integrity: holds at boundary", () => {
    const s = results.find((r) => r.id === "S15")!;
    assert.ok(s, "S15 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  // ——— Aggregate verification ————————————————————————————
  test("all 5 hardening scenarios pass (no mutations survive)", () => {
    const failures = results.filter((r) => !r.passed);
    assert.strictEqual(
      failures.length,
      0,
      `Hardening failures: ${failures.map((f) => `${f.id}: ${f.explanation}`).join("; ")}`,
    );
  });

  test("hardening suite is deterministic (second run matches)", () => {
    const secondRun = runHardeningScenarios();
    assert.strictEqual(secondRun.length, results.length);
    for (let i = 0; i < results.length; i++) {
      assert.strictEqual(secondRun[i].id, results[i].id);
      assert.strictEqual(secondRun[i].passed, results[i].passed);
      assert.strictEqual(secondRun[i].actual_block, results[i].actual_block);
    }
  });
});
