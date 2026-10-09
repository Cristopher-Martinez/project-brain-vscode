/**
 * test-gate-adversarial.ts — T4-ADS Phase B: Adversarial Suite.
 *
 * Generates and runs 10 controlled adversarial scenarios against the
 * structural gate logic to verify it cannot be bypassed.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md (T4)
 */

import {
  checkCoreInvariantIntegrity,
  checkCoreInvariantPresence,
  checkDecisionCoverage,
  checkDeletionAndDowngrade,
  checkMutationSentinel,
} from "./test-gate-structural";
import type { AdversarialScenarioResult } from "./test-gate-structural";
import type {
  CoreModuleEntry,
  FileCoverageSummary,
  InvariantHistoryEntry,
  InvariantRecord,
} from "./test-pipeline-types";
import { runHardeningScenarios } from "./test-gate-adversarial-hardening";

// ——— Phase B: Adversarial Suite ——————————————————

/** Run all 15 adversarial scenarios against the gate logic */
export function runAdversarialSuite(): AdversarialScenarioResult[] {
  return [
    runS1_CoreWithoutInvariant(),
    runS2_InvariantWithoutStrongAssertion(),
    runS3_CoverageInflatedGlobal(),
    runS4_ImpactDowngradeSilent(),
    runS5_TierDowngradeSilent(),
    runS6_GlobalBoundaryExact(),
    runS7_CoreBoundaryExact(),
    runS8_FalseFileAssociation(),
    runS9_SentinelDisabled(),
    runS10_FakeJustification(),
    ...runHardeningScenarios(),
  ];
}

/** S1: Core module without invariant → must BLOCK */
function runS1_CoreWithoutInvariant(): AdversarialScenarioResult {
  const fakeCoreModules: CoreModuleEntry[] = [
    { path: "src/auth.ts", reasons: ["auth"], autoDetected: true },
  ];
  const noInvariants: InvariantRecord[] = [];
  const checks = checkCoreInvariantPresence(fakeCoreModules, noInvariants);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S1",
    name: "Core Without Invariant",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: módulo core sin invariante detectado"
      : "FALLO: módulo core sin invariante NO fue bloqueado",
  };
}

/** S2: Invariant without strong assertion → must BLOCK */
function runS2_InvariantWithoutStrongAssertion(): AdversarialScenarioResult {
  const invariants: InvariantRecord[] = [{
    id: "auth-session-valid",
    description: "Session must be validated",
    impact: "critical",
    tier: "core",
    files: ["src/auth.ts"],
    addedAt: "2026-01-01",
  }];

  // Test file present but NO strong assertion
  const weakTestContents = new Map<string, string>();
  weakTestContents.set("src/test/auth.test.ts", `
    describe("auth", () => {
      it("should work", () => {
        console.log("auth-session-valid tested");
      });
    });
  `);

  const checks = checkCoreInvariantIntegrity(
    invariants,
    [{ file: "src/auth.ts", branchPct: 85, linePct: 90, uncoveredBranches: [] }],
    weakTestContents,
    70,
  );

  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S2",
    name: "Invariant Without Strong Assertion",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: invariante crítica sin aserción fuerte"
      : "FALLO: invariante sin aserción fuerte NO fue bloqueado",
  };
}

/** S3: Coverage inflated global — global OK, core module below threshold → BLOCK */
function runS3_CoverageInflatedGlobal(): AdversarialScenarioResult {
  const coreModules: CoreModuleEntry[] = [
    { path: "src/coreA.ts", reasons: ["persistence"], autoDetected: true },
    { path: "src/coreB.ts", reasons: ["external-api"], autoDetected: true },
  ];

  const coverageSummaries: FileCoverageSummary[] = [
    { file: "src/coreA.ts", branchPct: 62, linePct: 70, uncoveredBranches: [] },
    { file: "src/coreB.ts", branchPct: 95, linePct: 98, uncoveredBranches: [] },
    { file: "src/utils.ts", branchPct: 95, linePct: 98, uncoveredBranches: [] },
  ];

  const globalCoverage = 85;
  const checks = checkDecisionCoverage(globalCoverage, coreModules, coverageSummaries);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S3",
    name: "Coverage Inflated Global",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: coreA=62% < 70% detectado pese a global=85%"
      : "FALLO: cobertura inflada NO fue bloqueada (coreA=62%)",
  };
}

/** S4: Impact downgrade critical→low without justification → must BLOCK */
function runS4_ImpactDowngradeSilent(): AdversarialScenarioResult {
  const previous: InvariantRecord[] = [{
    id: "data-integrity", description: "Data must be consistent",
    impact: "critical", tier: "core", files: ["src/db.ts"], addedAt: "2026-01-01",
  }];
  const current: InvariantRecord[] = [{
    id: "data-integrity", description: "Data must be consistent",
    impact: "low", tier: "core", files: ["src/db.ts"], addedAt: "2026-01-01",
  }];
  const history: InvariantHistoryEntry[] = [];

  const checks = checkDeletionAndDowngrade(current, previous, history);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S4",
    name: "Impact Downgrade Silent",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: downgrade critical→low sin justificación"
      : "FALLO: downgrade silencioso NO fue bloqueado",
  };
}

/** S5: Tier downgrade core→non-core without justification → must BLOCK */
function runS5_TierDowngradeSilent(): AdversarialScenarioResult {
  const previous: InvariantRecord[] = [{
    id: "auth-check", description: "Must check auth",
    impact: "high", tier: "core", files: ["src/auth.ts"], addedAt: "2026-01-01",
  }];
  const current: InvariantRecord[] = [{
    id: "auth-check", description: "Must check auth",
    impact: "high", tier: "non-core", files: ["src/auth.ts"], addedAt: "2026-01-01",
  }];
  const history: InvariantHistoryEntry[] = [];

  const checks = checkDeletionAndDowngrade(current, previous, history);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S5",
    name: "Tier Downgrade Silent",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: tier downgrade core→non-core sin justificación"
      : "FALLO: tier downgrade silencioso NO fue bloqueado",
  };
}

/** S6: Global boundary exact — 80 PASS, 79 FAIL */
function runS6_GlobalBoundaryExact(): AdversarialScenarioResult {
  const at80 = checkDecisionCoverage(80, [], []);
  const at79 = checkDecisionCoverage(79, [], []);

  const g80 = at80.find((c) => c.name === "decision-coverage-global");
  const g79 = at79.find((c) => c.name === "decision-coverage-global");

  const passesAt80 = g80?.passed === true;
  const failsAt79 = g79?.passed === false;
  const correct = passesAt80 && failsAt79;

  return {
    id: "S6",
    name: "Global Boundary Exact",
    passed: correct,
    expected_block: true,
    actual_block: failsAt79,
    explanation: correct
      ? "Correctamente: 80→PASS, 79→FAIL — mutación >= → > eliminada"
      : `FALLO: 80=${passesAt80 ? "PASS" : "FAIL"}, 79=${failsAt79 ? "FAIL" : "PASS"}`,
  };
}

/** S7: Core boundary exact — 70 PASS, 69 FAIL */
function runS7_CoreBoundaryExact(): AdversarialScenarioResult {
  const mod: CoreModuleEntry = {
    path: "src/core.ts", reasons: ["persistence"], autoDetected: true,
  };
  const cov70: FileCoverageSummary[] = [
    { file: "src/core.ts", branchPct: 70, linePct: 80, uncoveredBranches: [] },
  ];
  const cov69: FileCoverageSummary[] = [
    { file: "src/core.ts", branchPct: 69, linePct: 80, uncoveredBranches: [] },
  ];

  const at70 = checkDecisionCoverage(85, [mod], cov70);
  const at69 = checkDecisionCoverage(85, [mod], cov69);

  const c70 = at70.find((c) => c.name === "decision-coverage-core-module");
  const c69 = at69.find((c) => c.name === "decision-coverage-core-module");

  const passesAt70 = c70?.passed === true;
  const failsAt69 = c69?.passed === false;
  const correct = passesAt70 && failsAt69;

  return {
    id: "S7",
    name: "Core Boundary Exact",
    passed: correct,
    expected_block: true,
    actual_block: failsAt69,
    explanation: correct
      ? "Correctamente: 70→PASS, 69→FAIL — mutación >= → > eliminada"
      : `FALLO: 70=${passesAt70 ? "PASS" : "FAIL"}, 69=${failsAt69 ? "FAIL" : "PASS"}`,
  };
}

/** S8: False file association in invariant → must BLOCK */
function runS8_FalseFileAssociation(): AdversarialScenarioResult {
  const coreModules: CoreModuleEntry[] = [
    { path: "src/payment.ts", reasons: ["money"], autoDetected: true },
  ];
  const invariants: InvariantRecord[] = [{
    id: "payment-validate", description: "Must validate payment",
    impact: "critical", tier: "core",
    files: ["src/utils.ts"], // WRONG file
    addedAt: "2026-01-01",
  }];

  const checks = checkCoreInvariantPresence(coreModules, invariants);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S8",
    name: "False File Association",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: invariante con archivo incorrecto no cubre módulo"
      : "FALLO: falsa asociación de archivo NO fue detectada",
  };
}

/** S9: Sentinel disabled → must BLOCK */
function runS9_SentinelDisabled(): AdversarialScenarioResult {
  const checks = checkMutationSentinel(85, [], [], false);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S9",
    name: "Sentinel Disabled",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: sentinel desactivado detectado"
      : "FALLO: sentinel desactivado NO fue bloqueado",
  };
}

/** S10: Fake justification (empty or trivial) → must BLOCK */
function runS10_FakeJustification(): AdversarialScenarioResult {
  const previous: InvariantRecord[] = [{
    id: "sec-check", description: "Security check",
    impact: "critical", tier: "core",
    files: ["src/security.ts"], addedAt: "2026-01-01",
  }];
  const current: InvariantRecord[] = [];
  const history: InvariantHistoryEntry[] = [{
    action: "deleted",
    invariantId: "sec-check",
    timestamp: new Date().toISOString(),
    justification: "ok", // Too short — trivial
  }];

  const checks = checkDeletionAndDowngrade(current, previous, history);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S10",
    name: "Fake Justification",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: justificación trivial rechazada"
      : "FALLO: justificación trivial fue aceptada",
  };
}

