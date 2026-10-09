/**
 * T6-1/2/3/4 — Data Normalization Layer
 *
 * Transforms FinalT5Result into T6 UI models.
 * NO new calculations. NO engine metric recalculation.
 * Only mapping and presentation logic.
 */

import type { FinalT5Result } from "./test-gate-mutation-el-types";
import type {
  T6ConfidenceModel,
  T6EvolutionSummary,
  T6ProtectionSummary,
} from "./test-gate-t6-types";

// ——— T6-2: Protection Evidence Model ———————————————————————

/**
 * Build protection summary from FinalT5Result.
 * Raw mutation scores are forbidden here — only evidence counts.
 */
export function buildProtectionSummary(
  input: FinalT5Result,
): T6ProtectionSummary {
  const preventedCriticalErrors = input.blocking
    ? input.criticalSurvivors.length
    : 0;

  const regressionsBlocked =
    (input.blocking || input.wouldBlockInEnforce) &&
    input.trend === "regressing"
      ? 1
      : 0;

  const tamperingAttempts = countTamperingAttempts(input);
  const structuralViolations = input.recoveredFromDirtyState ? 1 : 0;
  const integrityState = deriveIntegrityState(input);

  return {
    preventedCriticalErrors,
    regressionsBlocked,
    tamperingAttemptsDetected: tamperingAttempts,
    structuralViolationsBlocked: structuralViolations,
    integrityState,
  };
}

function countTamperingAttempts(input: FinalT5Result): number {
  let count = 0;
  if (input.baselineDrifted) {
    count++;
  }
  if (input.volumeDriftSuspicious) {
    count++;
  }
  if (!input.policyConsistent) {
    count++;
  }
  return count;
}

function deriveIntegrityState(
  input: FinalT5Result,
): "clean" | "recovered" | "degraded" {
  if (input.historyIntegrity === "degraded") {
    return "degraded";
  }
  if (input.recoveredFromDirtyState) {
    return "recovered";
  }
  return "clean";
}

// ——— T6-3: Evolution Model —————————————————————————————————

/**
 * Build evolution summary based strictly on adjustedScore.
 * Trend must use adjustedScore only — never rawScore.
 */
export function buildEvolutionSummary(
  input: FinalT5Result,
): T6EvolutionSummary {
  const trend = input.trend ?? "stable";
  const maturity = input.maturityLevel;
  const scoreDelta = input.deltaScore ?? 0;
  const stabilityIndicator = computeStabilityIndicator(input);
  const volumeHealth = input.volumeDriftSuspicious ? "suspicious" : "normal";

  return {
    trend,
    maturity,
    scoreDelta,
    stabilityIndicator,
    volumeHealth,
  };
}

/**
 * Stability indicator: 0 = unstable, 100 = rock solid.
 * Derived from trend consistency + maturity + integrity signals.
 */
function computeStabilityIndicator(input: FinalT5Result): number {
  let score = 50; // baseline neutral

  // Trend contribution
  if (input.trend === "improving") {
    score += 20;
  }
  if (input.trend === "regressing") {
    score -= 30;
  }

  // Maturity contribution
  if (input.maturityLevel === "mature") {
    score += 25;
  }
  if (input.maturityLevel === "legacy") {
    score -= 15;
  }

  // Risk factors reduce stability
  if (input.baselineDrifted) {
    score -= 10;
  }
  if (input.volumeDriftSuspicious) {
    score -= 10;
  }
  if (!input.policyConsistent) {
    score -= 10;
  }
  if (input.historyIntegrity === "degraded") {
    score -= 15;
  }

  return Math.max(0, Math.min(100, score));
}

// ——— T6-4: Confidence Synthesis ————————————————————————————

/**
 * Build confidence model with human-readable explanation.
 * Technical terms require tooltips — no jargon in primary view.
 */
export function buildConfidenceModel(input: FinalT5Result): T6ConfidenceModel {
  const riskFactors = collectRiskFactors(input);
  const confidenceLabel = deriveConfidenceLabel(input, riskFactors);
  const explanation = buildExplanation(confidenceLabel, riskFactors, input);

  return {
    confidenceLabel,
    explanation,
    riskFactors,
  };
}

function collectRiskFactors(input: FinalT5Result): string[] {
  const factors: string[] = [];

  if (input.criticalSurvivors.length > 0) {
    factors.push(
      `${input.criticalSurvivors.length} critical error(s) survived testing`,
    );
  }
  if (input.baselineDrifted) {
    factors.push("Baseline has drifted significantly from current scores");
  }
  if (input.volumeDriftSuspicious) {
    factors.push("Mutation volume dropped unexpectedly");
  }
  if (!input.policyConsistent) {
    factors.push("Policy decision is internally inconsistent");
  }
  if (input.historyIntegrity === "degraded") {
    factors.push("Some historical records may be corrupted");
  }
  if (input.trend === "regressing") {
    factors.push("Test quality is trending downward");
  }

  return factors;
}

function deriveConfidenceLabel(
  input: FinalT5Result,
  riskFactors: string[],
): "low" | "moderate" | "high" {
  if (
    input.historyIntegrity === "degraded" ||
    riskFactors.length >= 3 ||
    (input.blocking && input.criticalSurvivors.length > 2)
  ) {
    return "low";
  }
  if (riskFactors.length >= 1 || input.maturityLevel === "legacy") {
    return "moderate";
  }
  return "high";
}

function buildExplanation(
  label: "low" | "moderate" | "high",
  riskFactors: string[],
  input: FinalT5Result,
): string {
  switch (label) {
    case "high":
      return (
        "The mutation testing system is healthy. " +
        "Tests are catching errors effectively and quality is stable."
      );
    case "moderate":
      return (
        `The system is functional but has ${riskFactors.length} area(s) ` +
        "that need attention. Review the risk factors below."
      );
    case "low":
      return (
        "The system has detected significant issues. " +
        `${riskFactors.length} risk factor(s) require immediate attention. ` +
        (input.historyIntegrity === "degraded"
          ? "Historical data integrity is compromised."
          : "Review and address all risk factors.")
      );
  }
}
