/**
 * T5-EL — Policy Engine
 *
 * Applies mutation policy based on mode, baseline, and maturity.
 * Pure functions — no I/O.
 */

import type {
  MaturityLevel,
  MutationBaseline,
  MutationMode,
  MutationRun,
  PolicyDecision,
  T5ELConfig,
} from "./test-gate-mutation-el-types";

// ——— Policy Application —————————————————————————————————————

/**
 * Apply policy to determine if this run should block CI.
 * This is the core switch from the spec (Section 6).
 */
export function applyPolicy(
  artifact: MutationRun,
  mode: MutationMode,
  baseline: MutationBaseline | null,
  maturityLevel: MaturityLevel,
  config: T5ELConfig,
  modifiedFiles: string[],
): PolicyDecision {
  // Always compute what enforce would say
  const enforceResult = applyEnforce(artifact, config);

  switch (mode) {
    case "report":
      return {
        blocking: false,
        wouldBlockInEnforce: enforceResult.blocking,
        blockingReason: null,
        reason: enforceResult.blocking
          ? `[report] Would block: ${enforceResult.reason}`
          : undefined,
      };

    case "baseline-lock":
      return applyBaselineLock(
        artifact,
        baseline,
        enforceResult,
        modifiedFiles,
      );

    case "adaptive":
      return applyAdaptive(
        artifact,
        maturityLevel,
        baseline,
        config,
        enforceResult,
        modifiedFiles,
      );

    case "enforce":
      return enforceResult;
  }
}

// ——— Enforce ————————————————————————————————————————————————

/** Strict enforcement: blocks on score thresholds and critical survivors */
function applyEnforce(
  artifact: MutationRun,
  config: T5ELConfig,
): PolicyDecision {
  // Check 1: Global adjusted score
  if (artifact.adjustedScore < config.globalMinScore) {
    return {
      blocking: true,
      wouldBlockInEnforce: true,
      blockingReason: "global-threshold",
      reason: `adjustedScore ${artifact.adjustedScore} < ${config.globalMinScore}`,
    };
  }

  // Check 2: Core module below threshold
  for (const [mod, score] of Object.entries(artifact.moduleScores)) {
    if (score < config.coreMinScore) {
      return {
        blocking: true,
        wouldBlockInEnforce: true,
        blockingReason: "core-threshold",
        reason: `module "${mod}" score ${score} < ${config.coreMinScore}`,
      };
    }
  }

  // Check 3: Any critical Tier1 survivors in core
  if (artifact.criticalSurvivors.length > 0) {
    return {
      blocking: true,
      wouldBlockInEnforce: true,
      blockingReason: "critical-survivor",
      reason: `${artifact.criticalSurvivors.length} critical survivor(s)`,
    };
  }

  return { blocking: false, wouldBlockInEnforce: false, blockingReason: null };
}

// ——— Baseline Lock ——————————————————————————————————————————

/**
 * Baseline-lock: only block if regression below established baseline.
 * Never demands scores above baseline — just prevents regression.
 */
function applyBaselineLock(
  artifact: MutationRun,
  baseline: MutationBaseline | null,
  enforceResult: PolicyDecision,
  modifiedFiles: string[],
): PolicyDecision {
  if (!baseline) {
    // No baseline → can't lock → pass (like report)
    return {
      blocking: false,
      wouldBlockInEnforce: enforceResult.blocking,
      blockingReason: null,
      reason: "[baseline-lock] No baseline exists, passing",
    };
  }

  // Rule 1: rawScore < baselineScore → block
  if (artifact.rawScore < baseline.baselineScore) {
    return {
      blocking: true,
      wouldBlockInEnforce: enforceResult.blocking,
      blockingReason: "baseline-regression",
      reason: `rawScore ${artifact.rawScore} < baseline ${baseline.baselineScore}`,
    };
  }

  // Rule 2: criticalSurvivors > baselineCritical → block
  if (artifact.criticalSurvivors.length > baseline.baselineCritical) {
    return {
      blocking: true,
      wouldBlockInEnforce: enforceResult.blocking,
      blockingReason: "baseline-regression",
      reason: `critical ${artifact.criticalSurvivors.length} > baseline ${baseline.baselineCritical}`,
    };
  }

  // Rule 3: New Tier1 survivor in modified file → block (compare by mutantId)
  const baselineIds = new Set(baseline.baselineMutantIds ?? []);
  const newInModified = artifact.criticalSurvivors.some(
    (s) => modifiedFiles.includes(s.file) && !baselineIds.has(s.mutantId),
  );
  if (newInModified) {
    return {
      blocking: true,
      wouldBlockInEnforce: enforceResult.blocking,
      blockingReason: "critical-survivor",
      reason: "New critical survivor in modified file",
    };
  }

  return {
    blocking: false,
    wouldBlockInEnforce: enforceResult.blocking,
    blockingReason: null,
  };
}

// ——— Adaptive ———————————————————————————————————————————————

/**
 * Adaptive mode: auto-escalates based on project maturity.
 * Mature → enforce rules. Otherwise → baseline-lock or report.
 */
function applyAdaptive(
  artifact: MutationRun,
  maturityLevel: MaturityLevel,
  baseline: MutationBaseline | null,
  config: T5ELConfig,
  enforceResult: PolicyDecision,
  modifiedFiles: string[],
): PolicyDecision {
  if (maturityLevel === "mature") {
    // Mature project → escalate to enforce
    const result = enforceResult;
    if (result.blocking) {
      return {
        ...result,
        reason: `[adaptive→enforce] ${result.reason}`,
      };
    }
    return result;
  }

  // Not mature → try baseline-lock, fall back to report
  if (baseline) {
    const blResult = applyBaselineLock(
      artifact,
      baseline,
      enforceResult,
      modifiedFiles,
    );
    if (blResult.blocking) {
      return {
        ...blResult,
        reason: `[adaptive→baseline-lock] ${blResult.reason}`,
      };
    }
    return blResult;
  }

  // No baseline, not mature → report mode
  return {
    blocking: false,
    wouldBlockInEnforce: enforceResult.blocking,
    blockingReason: null,
    reason: "[adaptive] No baseline, not mature → report",
  };
}

// ——— Recommendation Generator ———————————————————————————————

/** Generate a human-readable recommendation based on policy result */
export function generateRecommendation(
  decision: PolicyDecision,
  mode: MutationMode,
  maturityLevel: MaturityLevel,
  trend: string | null,
): string | undefined {
  if (decision.blocking) {
    return `Blocked in ${mode} mode: ${decision.reason}`;
  }

  if (decision.wouldBlockInEnforce && mode !== "enforce") {
    return (
      `Passing in ${mode} mode, but would block in enforce. ` +
      `Project maturity: ${maturityLevel}. Trend: ${trend || "unknown"}.`
    );
  }

  if (maturityLevel === "legacy") {
    return "Consider adding more tests to improve mutation score.";
  }

  return undefined;
}

// ——— FIX 13: Policy Consistency Assertions ———————————————————

export interface PolicyConsistencyResult {
  consistent: boolean;
  violations: string[];
}

/**
 * Verify that a PolicyDecision is internally consistent.
 * Catches contradictions that would indicate a bug in the policy engine.
 */
export function assertPolicyConsistency(
  decision: PolicyDecision,
  artifact: { adjustedScore: number; criticalSurvivors: { length: number } },
  mode: MutationMode,
  config: { globalMinScore: number },
): PolicyConsistencyResult {
  const violations: string[] = [];

  // Rule 1: blocking=true requires a blockingReason
  if (decision.blocking && !decision.blockingReason) {
    violations.push("blocking=true but blockingReason is null/undefined");
  }

  // Rule 2: blocking=false must NOT have a blockingReason
  if (!decision.blocking && decision.blockingReason) {
    violations.push(
      `blocking=false but blockingReason="${decision.blockingReason}"`,
    );
  }

  // Rule 3: enforce mode + critical survivors + score above threshold → must be blocking
  if (
    mode === "enforce" &&
    artifact.criticalSurvivors.length > 0 &&
    artifact.adjustedScore >= config.globalMinScore
  ) {
    if (!decision.blocking) {
      violations.push("enforce mode with critical survivors should block");
    }
  }

  // Rule 4: enforce mode + score below threshold → must be blocking
  if (mode === "enforce" && artifact.adjustedScore < config.globalMinScore) {
    if (!decision.blocking) {
      violations.push("enforce mode with score below threshold should block");
    }
  }

  // Rule 5: wouldBlockInEnforce should be true when blocking in enforce mode
  if (
    mode === "enforce" &&
    decision.blocking &&
    !decision.wouldBlockInEnforce
  ) {
    violations.push(
      "blocking in enforce mode but wouldBlockInEnforce is false",
    );
  }

  return { consistent: violations.length === 0, violations };
}
