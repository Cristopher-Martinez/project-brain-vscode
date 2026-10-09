/**
 * T6-0 — Preconditions Gate Tests
 */

import * as assert from "assert";
import { checkPreconditions } from "./test-gate-t6-preconditions";
import { makeFinalT5Result, makeDeps } from "./test-gate-t6-test-helpers";

suite("T6-0: Preconditions", () => {
  test("passes with valid input", async () => {
    const input = makeFinalT5Result();
    const deps = makeDeps();
    const r = await checkPreconditions(
      input, ".mutation-history", ".mutation-baseline.json", deps,
    );
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.failures.length, 0);
  });

  test("fails when input is null", async () => {
    const deps = makeDeps();
    const r = await checkPreconditions(
      null, ".mutation-history", ".mutation-baseline.json", deps,
    );
    assert.strictEqual(r.ready, false);
    assert.ok(r.failures[0].includes("missing"));
  });

  test("fails when historyIntegrity is degraded", async () => {
    const input = makeFinalT5Result({ historyIntegrity: "degraded" });
    const deps = makeDeps();
    const r = await checkPreconditions(
      input, ".mutation-history", ".mutation-baseline.json", deps,
    );
    assert.strictEqual(r.ready, false);
    assert.ok(r.failures.some(f => f.includes("degraded")));
  });

  test("fails when baseline is malformed", async () => {
    const deps = makeDeps({
      readFile: async (p: string) =>
        p.endsWith("baseline.json") ? '{"invalid": true}' : null,
    });
    const input = makeFinalT5Result();
    const r = await checkPreconditions(
      input, ".mutation-history", ".mutation-baseline.json", deps,
    );
    assert.strictEqual(r.ready, false);
    assert.ok(r.failures.some(f => f.includes("malformed")));
  });
});
