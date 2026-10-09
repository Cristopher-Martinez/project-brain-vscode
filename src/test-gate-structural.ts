/**
 * test-gate-structural.ts — T4-ADS: Structural Gate (Phase A).
 *
 * Pre-merge gate that verifies structural integrity against:
 * - Inflated coverage
 * - Symbolic invariants
 * - Silent downgrade
 * - Off-by-one at boundaries
 * - False invariant-test association
 * - Disabled structural sentinel
 *
 * Phase B (adversarial suite) lives in test-gate-adversarial.ts.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md (T4)
 */

import { readInvariantsDoc } from "./invariants-manager";
import { readHistory } from "./invariants-queries";
import { log, logWarn } from "./logger";
import {
  findAndParseCoverage,
  calculateAggregateCoverage,
} from "./test-gate-coverage";
import { runAdversarialSuite } from "./test-gate-adversarial";
import type {
  CoreModuleEntry,
  FileCoverageSummary,
  GateCheck,
  GateResult,
  InvariantHistoryEntry,
  InvariantRecord,
  ProjectTestContract,
} from "./test-pipeline-types";

// ——— Constants ———————————————————————————————————
export const GLOBAL_BRANCH_THRESHOLD = 80;
export const CORE_BRANCH_THRESHOLD = 70;
export const HPD_MODULE_THRESHOLD = 60;
export const HPD_GLOBAL_THRESHOLD = 65;
export const VALID_JUSTIFICATION_MIN_LENGTH = 20;
export const VALID_JUSTIFICATION_KEYWORDS = [
  "refactor", "deprecated", "merged", "replaced", "removed",
  "consolidated", "split", "extracted", "obsolete", "migrated",
];

const STRONG_ASSERTION_PATTERNS = [
  /assert\s*\(/, /expect\s*\(/, /\.toBe\s*\(/, /\.toEqual\s*\(/,
  /\.toThrow\s*\(/, /\.toStrictEqual\s*\(/, /\.toMatch\s*\(/,
  /\.rejects\s*\./, /\.resolves\s*\./, /strictEqual\s*\(/,
  /deepStrictEqual\s*\(/, /throws\s*\(/, /\.toHaveBeenCalled/,
  /\.toContain\s*\(/,
];

// ——— T4-ADS Output Contract ———————————————————————
export interface T4ADSResult {
  T4_structural_passed: boolean;
  adversarial_passed: number;
  adversarial_total: number;
  mutations_surviving: number;
  blocking: boolean;
  ready_for_T5: boolean;
  hardening_complete: boolean;
  gate: GateResult;
  adversarial_details: AdversarialScenarioResult[];
}

export interface AdversarialScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  expected_block: boolean;
  actual_block: boolean;
  explanation: string;
}

export interface StructuralGateInput {
  wsRoot: string;
  contract: ProjectTestContract;
  t2Result: GateResult;
  hpdScore?: number;
  coverageSummaries?: FileCoverageSummary[];
  previousSnapshot?: InvariantRecord[];
  testFileContents?: Map<string, string>;
  sentinelEnabled?: boolean;
}

// ——— Phase A: Structural Checks ———————————————————

/** CHECK 1: Core Invariant Presence — every core module must have ≥1 invariant */
export function checkCoreInvariantPresence(
  coreModules: CoreModuleEntry[],
  invariants: InvariantRecord[],
): GateCheck[] {
  return coreModules.map((mod) => {
    const matched = invariants.filter((inv) =>
      inv.files.some((f) => mod.path.includes(f) || f.includes(mod.path)),
    );
    const passed = matched.length > 0;
    return {
      name: "core-invariant-presence",
      passed,
      blocking: true,
      value: matched.length,
      threshold: 1,
      explanation: passed
        ? `Módulo core ${mod.path} tiene ${matched.length} invariante(s)`
        : `Módulo core ${mod.path} NO tiene invariantes declaradas`,
      suggestion: passed ? undefined
        : `Agregar invariante para ${mod.path} en INVARIANTS.md sección ## Core`,
      location: { file: mod.path },
      invariantId: matched[0]?.id,
    };
  });
}

/** CHECK 2: Core Invariant Structural Integrity */
export function checkCoreInvariantIntegrity(
  invariants: InvariantRecord[],
  coverageSummaries: FileCoverageSummary[],
  testFileContents: Map<string, string>,
  hpdScore: number,
): GateCheck[] {
  const high = invariants.filter(
    (inv) => inv.tier === "core" && (inv.impact === "critical" || inv.impact === "high"),
  );

  return high.map((inv) => {
    const hasLinkedTest = testFileContents.size > 0 &&
      Array.from(testFileContents.entries()).some(([file, content]) =>
        content.includes(inv.id) ||
        inv.files.some((f) => file.includes(f.replace(/\.\w+$/, ""))),
      );

    const modCov = getModuleBranchCoverage(inv.files, coverageSummaries);
    const hpdOk = hpdScore >= HPD_MODULE_THRESHOLD;

    const hasStrongAssertion = hasLinkedTest &&
      Array.from(testFileContents.values()).some((content) =>
        STRONG_ASSERTION_PATTERNS.some((p) => p.test(content)) &&
        (content.includes(inv.id) ||
          inv.files.some((f) => content.includes(f.replace(/\.\w+$/, "")))),
      );

    // FIX 2 (T4-HARDENING-1): Verify actual execution — each invariant file
    // must have lineCoverage > 0 (not just textual mention in test).
    const hasExecution = inv.files.every((f) => {
      const cov = coverageSummaries.find((s) => {
        const nS = s.file.replace(/\\/g, "/");
        const nF = f.replace(/\\/g, "/");
        return nS.includes(nF) || nF.includes(nS);
      });
      return cov !== undefined && cov.linePct > 0;
    });

    const allPass = hasLinkedTest && modCov >= CORE_BRANCH_THRESHOLD && hpdOk && hasStrongAssertion && hasExecution;
    const failures: string[] = [];
    if (!hasLinkedTest) { failures.push("sin test vinculado"); }
    if (modCov < CORE_BRANCH_THRESHOLD) { failures.push(`branchCoverage=${modCov}% < ${CORE_BRANCH_THRESHOLD}%`); }
    if (!hpdOk) { failures.push(`HPD=${hpdScore} < ${HPD_MODULE_THRESHOLD}`); }
    if (!hasStrongAssertion) { failures.push("sin aserción fuerte"); }
    if (!hasExecution) { failures.push("archivo(s) sin líneas ejecutadas (linePct=0)"); }

    return {
      name: "core-invariant-structural-integrity",
      passed: allPass,
      blocking: true,
      value: modCov,
      threshold: CORE_BRANCH_THRESHOLD,
      explanation: allPass
        ? `Invariante ${inv.id} (${inv.impact}) pasa integridad estructural`
        : `Invariante ${inv.id} (${inv.impact}) falla: ${failures.join(", ")}`,
      suggestion: allPass ? undefined : `Corregir: ${failures.join("; ")}`,
      invariantId: inv.id,
    };
  });
}

/** CHECK 3: Decision Coverage Integrity */
export function checkDecisionCoverage(
  globalCoverage: number,
  coreModules: CoreModuleEntry[],
  coverageSummaries: FileCoverageSummary[],
): GateCheck[] {
  const checks: GateCheck[] = [{
    name: "decision-coverage-global",
    passed: globalCoverage >= GLOBAL_BRANCH_THRESHOLD,
    blocking: true,
    value: globalCoverage,
    threshold: GLOBAL_BRANCH_THRESHOLD,
    explanation: globalCoverage >= GLOBAL_BRANCH_THRESHOLD
      ? `Cobertura global ${globalCoverage}% >= ${GLOBAL_BRANCH_THRESHOLD}%`
      : `Cobertura global ${globalCoverage}% < ${GLOBAL_BRANCH_THRESHOLD}%`,
  }];

  for (const mod of coreModules) {
    const modCov = getModuleBranchCoverage([mod.path], coverageSummaries);
    checks.push({
      name: "decision-coverage-core-module",
      passed: modCov >= CORE_BRANCH_THRESHOLD,
      blocking: true,
      value: modCov,
      threshold: CORE_BRANCH_THRESHOLD,
      explanation: modCov >= CORE_BRANCH_THRESHOLD
        ? `Módulo core ${mod.path}: ${modCov}% >= ${CORE_BRANCH_THRESHOLD}%`
        : `Módulo core ${mod.path}: ${modCov}% < ${CORE_BRANCH_THRESHOLD}%`,
      location: { file: mod.path },
    });
  }
  return checks;
}

/** CHECK 4: Invariant Deletion & Downgrade Protection */
export function checkDeletionAndDowngrade(
  currentInvariants: InvariantRecord[],
  previousSnapshot: InvariantRecord[],
  history: InvariantHistoryEntry[],
  currentCoverage?: FileCoverageSummary[],
  previousCoverage?: FileCoverageSummary[],
): GateCheck[] {
  const checks: GateCheck[] = [];
  const currentIds = new Set(currentInvariants.map((i) => i.id));
  const previousMap = new Map(previousSnapshot.map((i) => [i.id, i]));

  for (const prev of previousSnapshot) {
    if (!currentIds.has(prev.id)) {
      const del = history.find((h) => h.action === "deleted" && h.invariantId === prev.id);
      const valid = isValidJustification(del?.justification);
      checks.push({
        name: "invariant-deletion-protection", passed: valid, blocking: true,
        explanation: valid
          ? `Invariante ${prev.id} eliminada con justificación válida`
          : `Invariante ${prev.id} eliminada sin justificación válida`,
        suggestion: valid ? undefined
          : `Justificación >= ${VALID_JUSTIFICATION_MIN_LENGTH} chars con razón semántica`,
        invariantId: prev.id,
      });
    }
  }

  for (const curr of currentInvariants) {
    const prev = previousMap.get(curr.id);
    if (!prev) { continue; }

    if (isImpactDowngrade(prev.impact, curr.impact)) {
      const mod = history.find((h) => h.action === "modified" && h.invariantId === curr.id);
      const valid = isValidJustification(mod?.justification);

      // FIX 4 (T4-HARDENING-1): Check coverage consistency on downgrade.
      // If coverage drops >10% alongside a downgrade, block even with valid justification.
      let coverageDropBlocked = false;
      if (valid && currentCoverage && previousCoverage) {
        const currCov = getModuleBranchCoverage(curr.files, currentCoverage);
        const prevCov = getModuleBranchCoverage(prev.files, previousCoverage);
        if (prevCov > 0 && (prevCov - currCov) > 10) {
          coverageDropBlocked = true;
        }
      }

      checks.push({
        name: "invariant-impact-downgrade", passed: valid && !coverageDropBlocked, blocking: true,
        explanation: coverageDropBlocked
          ? `${curr.id}: downgrade ${prev.impact}→${curr.impact} con coverage drop >${10}%`
          : valid
            ? `${curr.id}: downgrade ${prev.impact}→${curr.impact} con justificación`
            : `${curr.id}: downgrade silencioso ${prev.impact}→${curr.impact}`,
        invariantId: curr.id,
      });
    }

    if (prev.tier === "core" && curr.tier === "non-core") {
      const mod = history.find((h) => h.action === "modified" && h.invariantId === curr.id);
      const valid = isValidJustification(mod?.justification);
      checks.push({
        name: "invariant-tier-downgrade", passed: valid, blocking: true,
        explanation: valid
          ? `${curr.id}: tier core→non-core con justificación`
          : `${curr.id}: tier downgrade silencioso core→non-core`,
        invariantId: curr.id,
      });
    }
  }
  return checks;
}

/** CHECK 5: Structural Mutation Sentinel */
export function checkMutationSentinel(
  globalCoverage: number,
  coreModules: CoreModuleEntry[],
  coverageSummaries: FileCoverageSummary[],
  sentinelEnabled: boolean,
): GateCheck[] {
  if (!sentinelEnabled) {
    return [{
      name: "structural-mutation-sentinel", passed: false, blocking: true,
      explanation: "Sentinel desactivado — no se verifica integridad de mutación",
      suggestion: "Activar sentinelEnabled=true",
    }];
  }

  const mutations: Array<{ label: string; killed: boolean }> = [];
  const gGte = globalCoverage >= GLOBAL_BRANCH_THRESHOLD;
  const gGt = globalCoverage > GLOBAL_BRANCH_THRESHOLD;
  mutations.push({ label: `global: >= → > (${globalCoverage})`, killed: gGte !== gGt || globalCoverage === GLOBAL_BRANCH_THRESHOLD });
  const p80 = globalCoverage >= GLOBAL_BRANCH_THRESHOLD;
  const p79 = globalCoverage >= GLOBAL_BRANCH_THRESHOLD - 1;
  mutations.push({ label: `global: 80→79 (${globalCoverage})`, killed: p80 !== p79 || globalCoverage === GLOBAL_BRANCH_THRESHOLD });

  for (const mod of coreModules) {
    const modCov = getModuleBranchCoverage([mod.path], coverageSummaries);
    const a70 = modCov >= CORE_BRANCH_THRESHOLD;
    const a69 = modCov >= CORE_BRANCH_THRESHOLD - 1;
    mutations.push({ label: `${mod.path}: 70→69 (${modCov})`, killed: a70 !== a69 || modCov === CORE_BRANCH_THRESHOLD });
  }

  const surviving = mutations.filter((m) => !m.killed);
  return [{
    name: "structural-mutation-sentinel",
    passed: surviving.length === 0, blocking: true,
    value: surviving.length, threshold: 0,
    explanation: surviving.length === 0
      ? `Mutaciones eliminadas (${mutations.length}/${mutations.length})`
      : `${surviving.length} mutaciones sobreviven: ${surviving.map((s) => s.label).join(", ")}`,
  }];
}

// ——— Main Gate Runner ————————————————————————————

/** Run T4-ADS: Structural Gate + Adversarial Suite */
export async function runStructuralGate(input: StructuralGateInput): Promise<T4ADSResult> {
  const startTime = Date.now();
  const { wsRoot, contract, t2Result, hpdScore = 0, sentinelEnabled = true } = input;

  if (!t2Result.passed) { return buildAbortResult(startTime, "T2 no pasó"); }
  if (hpdScore < HPD_GLOBAL_THRESHOLD) { return buildAbortResult(startTime, `HPD=${hpdScore} < ${HPD_GLOBAL_THRESHOLD}`); }

  const invariants = readInvariantsDoc(wsRoot);
  const covs = input.coverageSummaries ?? findAndParseCoverage(wsRoot);
  const globalCov = calculateAggregateCoverage(covs);
  const prev = input.previousSnapshot ?? invariants;
  const hist = readHistory(wsRoot);
  const testFiles = input.testFileContents ?? new Map<string, string>();

  const allChecks: GateCheck[] = [
    ...checkCoreInvariantPresence(contract.coreModules, invariants),
    ...checkCoreInvariantIntegrity(invariants, covs, testFiles, hpdScore),
    ...checkDecisionCoverage(globalCov, contract.coreModules, covs),
    ...checkDeletionAndDowngrade(invariants, prev, hist, covs),
    ...checkMutationSentinel(globalCov, contract.coreModules, covs, sentinelEnabled),
  ];

  const structOk = allChecks.every((c) => c.passed || !c.blocking);
  const advResults = runAdversarialSuite();
  const advOk = advResults.filter((r) => r.passed).length;
  const mutSurv = advResults.filter((r) => !r.passed).length;

  const gate: GateResult = {
    level: 3, passed: structOk && advOk === advResults.length,
    checks: allChecks, consumedFrom: t2Result,
    duration: Date.now() - startTime, timestamp: Date.now(),
  };

  log(`[T4-ADS] Struct: ${structOk ? "PASS" : "FAIL"} | Adv: ${advOk}/${advResults.length} | Surv: ${mutSurv}`);
  if (!gate.passed) { logWarn("[T4-ADS] ⛔ NO avanzar a T5"); }

  const hardeningComplete = structOk && advOk === advResults.length && mutSurv === 0;

  return {
    T4_structural_passed: structOk,
    adversarial_passed: advOk, adversarial_total: advResults.length,
    mutations_surviving: mutSurv,
    blocking: !gate.passed, ready_for_T5: gate.passed,
    hardening_complete: hardeningComplete,
    gate, adversarial_details: advResults,
  };
}

// ——— Helpers ————————————————————————————————————

export function getModuleBranchCoverage(files: string[], summaries: FileCoverageSummary[]): number {
  if (summaries.length === 0) { return 0; }
  const matched = summaries.filter((s) =>
    files.some((f) => {
      const nS = s.file.replace(/\\/g, "/");
      const nF = f.replace(/\\/g, "/");
      return nS.includes(nF) || nF.includes(nS);
    }),
  );
  if (matched.length === 0) { return 0; }
  // FIX 1 (T4-HARDENING-1): Use min() instead of average to prevent internal inflation.
  // A module is only as strong as its weakest file.
  return Math.min(...matched.map((s) => Math.round(s.branchPct)));
}

export function isValidJustification(justification?: string): boolean {
  if (!justification || justification.length < VALID_JUSTIFICATION_MIN_LENGTH) { return false; }
  return VALID_JUSTIFICATION_KEYWORDS.some((kw) => justification.toLowerCase().includes(kw));
}

export function isImpactDowngrade(previous: string, current: string): boolean {
  const order = ["critical", "high", "medium", "low"];
  const pI = order.indexOf(previous);
  const cI = order.indexOf(current);
  return pI !== -1 && cI !== -1 && cI > pI;
}

function buildAbortResult(startTime: number, reason: string): T4ADSResult {
  return {
    T4_structural_passed: false, adversarial_passed: 0, adversarial_total: 15,
    mutations_surviving: 15, blocking: true, ready_for_T5: false, hardening_complete: false,
    gate: {
      level: 3, passed: false,
      checks: [{ name: "precondition-check", passed: false, blocking: true, explanation: `ABORT: ${reason}` }],
      duration: Date.now() - startTime, timestamp: Date.now(),
    },
    adversarial_details: [],
  };
}
