/**
 * test-gate-adversarial.test.ts — Tests for T4-ADS Phase B: Adversarial Suite.
 *
 * Tests the 15 adversarial scenarios (S1-S15) that verify the structural
 * gate cannot be bypassed by common mutation/manipulation patterns.
 */

import * as assert from "assert";
import { runAdversarialSuite } from "../test-gate-adversarial";
import type { AdversarialScenarioResult } from "../test-gate-structural";

suite("T4-ADS Phase B: Adversarial Suite", () => {
  let results: AdversarialScenarioResult[];

  suiteSetup(() => {
    results = runAdversarialSuite();
  });

  // ——— Suite-level invariants ———————————————————————

  test("returns exactly 15 scenario results", () => {
    assert.strictEqual(results.length, 15);
  });

  test("all scenario IDs are S1..S10 in order", () => {
    const ids = results.map((r) => r.id);
    const expected = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"];
    assert.deepStrictEqual(ids, expected);
  });

  test("every scenario has expected_block=true", () => {
    for (const r of results) {
      assert.strictEqual(
        r.expected_block,
        true,
        `${r.id} (${r.name}): expected_block should be true`,
      );
    }
  });

  test("every result has a non-empty explanation", () => {
    for (const r of results) {
      assert.ok(
        r.explanation && r.explanation.length > 0,
        `${r.id} (${r.name}): explanation must not be empty`,
      );
    }
  });

  // ——— Individual Scenario Verification —————————————

  test("S1 — Core Without Invariant: correctly blocks", () => {
    const s = results.find((r) => r.id === "S1")!;
    assert.ok(s, "S1 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block when core module has no invariant");
  });

  test("S2 — Invariant Without Strong Assertion: correctly blocks", () => {
    const s = results.find((r) => r.id === "S2")!;
    assert.ok(s, "S2 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block when invariant has no strong assertion");
  });

  test("S3 — Coverage Inflated Global: correctly blocks", () => {
    const s = results.find((r) => r.id === "S3")!;
    assert.ok(s, "S3 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block when core module below threshold despite high global",
    );
  });

  test("S4 — Impact Downgrade Silent: correctly blocks", () => {
    const s = results.find((r) => r.id === "S4")!;
    assert.ok(s, "S4 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block critical→low downgrade without justification",
    );
  });

  test("S5 — Tier Downgrade Silent: correctly blocks", () => {
    const s = results.find((r) => r.id === "S5")!;
    assert.ok(s, "S5 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block core→non-core downgrade without justification",
    );
  });

  test("S6 — Global Boundary Exact: 80→PASS, 79→FAIL", () => {
    const s = results.find((r) => r.id === "S6")!;
    assert.ok(s, "S6 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  test("S7 — Core Boundary Exact: 70→PASS, 69→FAIL", () => {
    const s = results.find((r) => r.id === "S7")!;
    assert.ok(s, "S7 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  test("S8 — False File Association: correctly blocks", () => {
    const s = results.find((r) => r.id === "S8")!;
    assert.ok(s, "S8 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block when invariant file doesn't match core module",
    );
  });

  test("S9 — Sentinel Disabled: correctly blocks", () => {
    const s = results.find((r) => r.id === "S9")!;
    assert.ok(s, "S9 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block when sentinel is disabled");
  });

  test("S10 — Fake Justification: correctly blocks", () => {
    const s = results.find((r) => r.id === "S10")!;
    assert.ok(s, "S10 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(
      s.actual_block,
      true,
      "Must block when justification is trivial/too short",
    );
  });

  // ——— Hardening Scenarios (S11-S15) ————————————————————
  test("S11 — Internal Module Inflation: min prevents average inflation", () => {
    const s = results.find((r) => r.id === "S11")!;
    assert.ok(s, "S11 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block when min coverage < threshold despite high average");
  });

  test("S12 — Textual Association Without Execution: blocks zero-execution test", () => {
    const s = results.find((r) => r.id === "S12")!;
    assert.ok(s, "S12 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block when linePct is 0 despite textual match");
  });

  test("S13 — HPD Boundary Exact: 60→PASS, 59→FAIL", () => {
    const s = results.find((r) => r.id === "S13")!;
    assert.ok(s, "S13 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  test("S14 — Downgrade With Coverage Drop: blocks valid justification + coverage drop", () => {
    const s = results.find((r) => r.id === "S14")!;
    assert.ok(s, "S14 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
    assert.strictEqual(s.actual_block, true, "Must block downgrade even with valid justification when coverage drops >10%");
  });

  test("S15 — Sentinel Mutation Integrity: sentinel holds at boundary", () => {
    const s = results.find((r) => r.id === "S15")!;
    assert.ok(s, "S15 must exist");
    assert.strictEqual(s.passed, true, s.explanation);
  });

  // ——— Aggregate verification ————————————————————————

  test("all 15 scenarios pass (gate cannot be bypassed)", () => {
    const failures = results.filter((r) => !r.passed);
    assert.strictEqual(
      failures.length,
      0,
      `Adversarial failures: ${failures.map((f) => `${f.id}: ${f.explanation}`).join("; ")}`,
    );
  });

  test("suite result is deterministic (second run matches)", () => {
    const secondRun = runAdversarialSuite();
    assert.strictEqual(secondRun.length, results.length);
    for (let i = 0; i < results.length; i++) {
      assert.strictEqual(secondRun[i].id, results[i].id);
      assert.strictEqual(secondRun[i].passed, results[i].passed);
      assert.strictEqual(secondRun[i].actual_block, results[i].actual_block);
    }
  });
});
