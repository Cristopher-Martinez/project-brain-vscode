/**
 * T6-5/6/7 — Governance Layer Tests
 */

import * as assert from "assert";
import { DEFAULT_T5EL_CONFIG } from "./test-gate-mutation-el-types";
import {
  extractGovernanceConfig,
  simulateConfigChange,
  buildAuditEntry,
} from "./test-gate-t6-governance";
import { makeGovConfig, makeArtifact } from "./test-gate-t6-test-helpers";

// ——— T6-5: Governance ————————————————————————————————————

suite("T6-5: Governance Config", () => {
  test("extracts from T5EL config", () => {
    const c = extractGovernanceConfig(DEFAULT_T5EL_CONFIG, 30, 150, 30000);
    assert.strictEqual(c.policyMode, "report");
    assert.strictEqual(c.globalMinScore, 65);
    assert.strictEqual(c.coreMinScore, 55);
  });
});

// ——— T6-6: Retroactive Simulation ————————————————————————

suite("T6-6: Retroactive Simulation", () => {
  test("detects when mode change would block", () => {
    const artifact = makeArtifact({ adjustedScore: 50 });
    const current = makeGovConfig({ policyMode: "report" });
    const next = makeGovConfig({ policyMode: "enforce" });
    const p = simulateConfigChange(artifact, null, current, next, []);
    assert.strictEqual(p.previousDecision, false);
    assert.strictEqual(p.newDecision, true);
    assert.ok(p.warning?.includes("BLOCKED"));
  });

  test("no blocking warning when both agree", () => {
    const artifact = makeArtifact({ adjustedScore: 90 });
    const p = simulateConfigChange(
      artifact, null, makeGovConfig(), makeGovConfig({ globalMinScore: 70 }), [],
    );
    assert.strictEqual(p.previousDecision, false);
    assert.strictEqual(p.newDecision, false);
  });
});

// ——— T6-7: Audit Trail ——————————————————————————————————

suite("T6-7: Config Audit Trail", () => {
  test("builds audit entry with timestamp", () => {
    const prev = makeGovConfig();
    const next = makeGovConfig({ globalMinScore: 75 });
    const preview = { previousDecision: false, newDecision: false };
    const entry = buildAuditEntry(prev, next, preview, "Cristopher");
    assert.ok(entry.timestamp);
    assert.strictEqual(entry.user, "Cristopher");
    assert.deepStrictEqual(entry.previousConfig, prev);
  });
});
