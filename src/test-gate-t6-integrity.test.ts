/**
 * T6-9 — Integrity Cross-Check Tests
 */

import * as assert from "assert";
import { crossCheckIntegrity } from "./test-gate-t6-integrity";
import { makeFinalT5Result, makeDeps } from "./test-gate-t6-test-helpers";

suite("T6-9: Integrity Cross-Check", () => {
  test("healthy when no issues", async () => {
    const r = await crossCheckIntegrity(
      makeFinalT5Result(), ".mutation-history", ".mutation-baseline.json", makeDeps(),
    );
    assert.strictEqual(r.overallState, "healthy");
    assert.strictEqual(r.corruptArtifacts, 0);
    assert.strictEqual(r.warnings.length, 0);
  });

  test("degraded when hash verification failed", async () => {
    const r = await crossCheckIntegrity(
      makeFinalT5Result({ hashVerified: false }),
      ".mutation-history", ".mutation-baseline.json", makeDeps(),
    );
    assert.strictEqual(r.overallState, "degraded");
    assert.ok(r.warnings.some(w => w.includes("dirty")));
  });

  test("counts corrupt artifacts", async () => {
    const deps = makeDeps({
      listDir: async () => ["a.json", "b.json"],
      readFile: async (p: string) => {
        if (p.includes("a.json")) { return '{"invalid": true}'; }
        if (p.includes("b.json")) { return "not json"; }
        return null;
      },
    });
    const r = await crossCheckIntegrity(
      makeFinalT5Result(), ".mutation-history", ".mutation-baseline.json", deps,
    );
    assert.strictEqual(r.corruptArtifacts, 2);
    assert.strictEqual(r.overallState, "degraded");
  });
});
