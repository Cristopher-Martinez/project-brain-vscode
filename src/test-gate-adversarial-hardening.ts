/**
 * test-gate-adversarial-hardening.ts — T4-HARDENING-1: Scenarios S11–S15.
 *
 * Additional adversarial scenarios that address structural gaps
 * identified during auditoría:
 * - S11: Internal module inflation (FIX 1)
 * - S12: Textual association without execution (FIX 2)
 * - S13: HPD boundary exact (FIX 3)
 * - S14: Downgrade with coverage drop (FIX 4)
 * - S15: Sentinel mutation integrity (FIX 5)
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md (T4-HARDENING-1)
 */

import {
  checkCoreInvariantIntegrity,
  checkDeletionAndDowngrade,
  checkMutationSentinel,
  getModuleBranchCoverage,
} from "./test-gate-structural";
import type { AdversarialScenarioResult } from "./test-gate-structural";
import type {
  FileCoverageSummary,
  InvariantHistoryEntry,
  InvariantRecord,
} from "./test-pipeline-types";

/** Run all hardening scenarios (S11–S15) */
export function runHardeningScenarios(): AdversarialScenarioResult[] {
  return [
    runS11_InternalModuleInflation(),
    runS12_TextualAssociationWithoutExecution(),
    runS13_HpdBoundaryExact(),
    runS14_DowngradeWithCoverageDrop(),
    runS15_SentinelMutationIntegrity(),
  ];
}

/** S11: Internal Module Inflation — multi-file module with unbalanced coverage → BLOCK */
function runS11_InternalModuleInflation(): AdversarialScenarioResult {
  // Two files: one inflated, one underprotected. min(100, 40) = 40 < 70
  const coverageSummaries: FileCoverageSummary[] = [
    { file: "src/payment.ts", branchPct: 100, linePct: 100, uncoveredBranches: [] },
    { file: "src/payment-utils.ts", branchPct: 40, linePct: 50, uncoveredBranches: [] },
  ];
  const minCov = getModuleBranchCoverage(
    ["src/payment.ts", "src/payment-utils.ts"],
    coverageSummaries,
  );
  const blocked = minCov < 70;

  return {
    id: "S11",
    name: "Internal Module Inflation",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? `Correctamente BLOQUEADO: min coverage=${minCov}% < 70% (inflación interna detectada)`
      : `FALLO: inflación interna NO detectada (min=${minCov}%)`,
  };
}

/** S12: Textual Association Without Execution — test mentions ID but file has 0 coverage → BLOCK */
function runS12_TextualAssociationWithoutExecution(): AdversarialScenarioResult {
  const invariants: InvariantRecord[] = [{
    id: "sec-validate",
    description: "Must validate security",
    impact: "critical",
    tier: "core",
    files: ["src/security.ts"],
    addedAt: "2026-01-01",
  }];
  // Test mentions ID and has assertion, BUT coverage = 0 for the actual file
  const testContents = new Map<string, string>();
  testContents.set("src/test/security.test.ts", `
    test("sec-validate", () => {
      assert.ok(true); // strong assertion but never runs security.ts
    });
  `);
  const coverageWithZero: FileCoverageSummary[] = [
    { file: "src/security.ts", branchPct: 0, linePct: 0, uncoveredBranches: [] },
  ];

  const checks = checkCoreInvariantIntegrity(
    invariants, coverageWithZero, testContents, 70,
  );
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S12",
    name: "Textual Association Without Execution",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: test menciona ID pero archivo tiene 0% cobertura"
      : "FALLO: asociación textual sin ejecución NO detectada",
  };
}

/** S13: HPD Boundary Exact — 60→PASS, 59→FAIL */
function runS13_HpdBoundaryExact(): AdversarialScenarioResult {
  const invariant: InvariantRecord = {
    id: "hpd-boundary-test",
    description: "Test invariant for HPD boundary",
    impact: "critical",
    tier: "core",
    files: ["src/mod.ts"],
    addedAt: "2026-01-01",
  };
  const cov: FileCoverageSummary[] = [
    { file: "src/mod.ts", branchPct: 85, linePct: 90, uncoveredBranches: [] },
  ];
  const testContents = new Map<string, string>();
  testContents.set("src/test/mod.test.ts", `
    test("hpd-boundary-test", () => { assert.strictEqual(1, 1); });
  `);

  // HPD = 60 (exactly at threshold)
  const at60 = checkCoreInvariantIntegrity([invariant], cov, testContents, 60);
  const pass60 = at60.every((c) => c.passed);

  // HPD = 59 (below threshold)
  const at59 = checkCoreInvariantIntegrity([invariant], cov, testContents, 59);
  const fail59 = at59.some((c) => !c.passed);

  const correct = pass60 && fail59;

  return {
    id: "S13",
    name: "HPD Boundary Exact",
    passed: correct,
    expected_block: true,
    actual_block: fail59,
    explanation: correct
      ? "Correctamente: HPD=60→PASS, HPD=59→FAIL — mutación >= → > eliminada"
      : `FALLO: HPD=60=${pass60 ? "PASS" : "FAIL"}, HPD=59=${fail59 ? "FAIL" : "PASS"}`,
  };
}

/** S14: Downgrade With Coverage Drop — impact downgrade + coverage drop >10% → BLOCK */
function runS14_DowngradeWithCoverageDrop(): AdversarialScenarioResult {
  const previous: InvariantRecord[] = [{
    id: "data-guard",
    description: "Data must be guarded",
    impact: "critical",
    tier: "core",
    files: ["src/data.ts"],
    addedAt: "2026-01-01",
  }];
  const current: InvariantRecord[] = [{
    id: "data-guard",
    description: "Data must be guarded",
    impact: "low",
    tier: "core",
    files: ["src/data.ts"],
    addedAt: "2026-01-01",
  }];
  // Valid justification (>20 chars + keyword)
  const history: InvariantHistoryEntry[] = [{
    action: "modified",
    invariantId: "data-guard",
    timestamp: new Date().toISOString(),
    justification: "Refactor interno, comportamiento equivalente garantizado",
  }];
  // Previous 85%, current 60% = drop of 25% > 10%
  const prevCov: FileCoverageSummary[] = [
    { file: "src/data.ts", branchPct: 85, linePct: 90, uncoveredBranches: [] },
  ];
  const currCov: FileCoverageSummary[] = [
    { file: "src/data.ts", branchPct: 60, linePct: 65, uncoveredBranches: [] },
  ];

  const checks = checkDeletionAndDowngrade(current, previous, history, currCov, prevCov);
  const blocked = checks.some((c) => !c.passed && c.blocking);

  return {
    id: "S14",
    name: "Downgrade With Coverage Drop",
    passed: blocked,
    expected_block: true,
    actual_block: blocked,
    explanation: blocked
      ? "Correctamente BLOQUEADO: downgrade con coverage drop 85→60 (>10%) detectado"
      : "FALLO: downgrade con coverage drop NO fue bloqueado",
  };
}

/** S15: Sentinel Mutation Integrity — sentinel must produce kills, not always pass */
function runS15_SentinelMutationIntegrity(): AdversarialScenarioResult {
  // At boundary (80), sentinel should detect mutation >= → >
  const checks80 = checkMutationSentinel(80, [], [], true);
  const sentinel80 = checks80.find((c) => c.name === "structural-mutation-sentinel");
  const passed80 = sentinel80?.passed === true;

  // At 79, sentinel should report surviving mutations
  const checks79 = checkMutationSentinel(79, [], [], true);
  const sentinel79 = checks79.find((c) => c.name === "structural-mutation-sentinel");

  // If sentinel always returns passed:true regardless of input → integrity compromised
  const alwaysPasses = passed80 && sentinel79?.passed === true;
  const correct = passed80 && !alwaysPasses;

  return {
    id: "S15",
    name: "Sentinel Mutation Integrity",
    passed: correct,
    expected_block: true,
    actual_block: !alwaysPasses,
    explanation: correct
      ? "Correctamente: sentinel produce kills en boundary 80 y falla en 79"
      : alwaysPasses
        ? "FALLO: sentinel siempre retorna passed:true — integridad comprometida"
        : "FALLO: sentinel no produce kills en boundary 80",
  };
}
