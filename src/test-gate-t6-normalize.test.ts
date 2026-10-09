/**
 * T6-2/3/4 — Normalization Layer Tests
 */

import * as assert from "assert";
import {
  buildProtectionSummary,
  buildEvolutionSummary,
  buildConfidenceModel,
} from "./test-gate-t6-normalize";
import { makeFinalT5Result } from "./test-gate-t6-test-helpers";

// ——— T6-2: Protection ————————————————————————————————————

suite("T6-2: Protection Summary", () => {
  test("clean state with no issues", () => {
    const s = buildProtectionSummary(makeFinalT5Result());
    assert.strictEqual(s.preventedCriticalErrors, 0);
    assert.strictEqual(s.regressionsBlocked, 0);
    assert.strictEqual(s.tamperingAttemptsDetected, 0);
    assert.strictEqual(s.integrityState, "clean");
  });

  test("counts prevented critical errors when blocking", () => {
    const input = makeFinalT5Result({
      blocking: true,
      criticalSurvivors: [
        { mutantId: "m1", file: "a.ts", line: 1, column: 0, operator: "!==→===", functionName: "fn", astNodeKind: "Bin" },
        { mutantId: "m2", file: "b.ts", line: 2, column: 0, operator: "||→&&", functionName: "fn", astNodeKind: "Bin" },
      ],
    });
    assert.strictEqual(buildProtectionSummary(input).preventedCriticalErrors, 2);
  });

  test("detects tampering attempts", () => {
    const input = makeFinalT5Result({
      baselineDrifted: true,
      volumeDriftSuspicious: true,
      policyConsistent: false,
    });
    assert.strictEqual(buildProtectionSummary(input).tamperingAttemptsDetected, 3);
  });

  test("recovered state", () => {
    const input = makeFinalT5Result({ recoveredFromDirtyState: true });
    assert.strictEqual(buildProtectionSummary(input).integrityState, "recovered");
  });

  test("degraded state", () => {
    const input = makeFinalT5Result({ historyIntegrity: "degraded" });
    assert.strictEqual(buildProtectionSummary(input).integrityState, "degraded");
  });
});

// ——— T6-3: Evolution —————————————————————————————————————

suite("T6-3: Evolution Summary", () => {
  test("maps trend and maturity", () => {
    const s = buildEvolutionSummary(makeFinalT5Result({
      trend: "improving", maturityLevel: "mature", deltaScore: 10,
    }));
    assert.strictEqual(s.trend, "improving");
    assert.strictEqual(s.maturity, "mature");
    assert.strictEqual(s.scoreDelta, 10);
    assert.strictEqual(s.volumeHealth, "normal");
  });

  test("suspicious volume health", () => {
    const s = buildEvolutionSummary(makeFinalT5Result({ volumeDriftSuspicious: true }));
    assert.strictEqual(s.volumeHealth, "suspicious");
  });

  test("stability high for mature improving", () => {
    const s = buildEvolutionSummary(makeFinalT5Result({
      trend: "improving", maturityLevel: "mature",
    }));
    assert.ok(s.stabilityIndicator >= 70);
  });

  test("stability low for legacy regressing", () => {
    const s = buildEvolutionSummary(makeFinalT5Result({
      trend: "regressing", maturityLevel: "legacy", baselineDrifted: true,
    }));
    assert.ok(s.stabilityIndicator <= 20);
  });
});

// ——— T6-4: Confidence ————————————————————————————————————

suite("T6-4: Confidence Model", () => {
  test("high confidence for clean mature state", () => {
    const m = buildConfidenceModel(makeFinalT5Result({ maturityLevel: "mature" }));
    assert.strictEqual(m.confidenceLabel, "high");
    assert.strictEqual(m.riskFactors.length, 0);
  });

  test("low confidence for degraded state", () => {
    const m = buildConfidenceModel(makeFinalT5Result({
      historyIntegrity: "degraded",
      baselineDrifted: true,
      volumeDriftSuspicious: true,
    }));
    assert.strictEqual(m.confidenceLabel, "low");
    assert.ok(m.riskFactors.length >= 3);
  });

  test("moderate confidence for legacy maturity", () => {
    const m = buildConfidenceModel(makeFinalT5Result({ maturityLevel: "legacy" }));
    assert.strictEqual(m.confidenceLabel, "moderate");
  });
});
