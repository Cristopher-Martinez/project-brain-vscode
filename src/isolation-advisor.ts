/**
 * Isolation Advisor — STRAT-5
 *
 * Evaluates the risk level of a goal/task and recommends
 * an appropriate isolation level. Heuristic-based — no LLM call needed.
 *
 * Levels:
 *   - "branch-only" → lightweight, branch created but no fork (future)
 *   - "fork" → standard isolated fork (full local clone)
 *   - "fork-checkpoint" → fork + auto-checkpoint before starting
 *
 * Design: pure functions, no side effects, fully testeable.
 */

import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export type IsolationLevel = "branch-only" | "fork" | "fork-checkpoint";

export interface IsolationAdvice {
  /** Recommended isolation level. */
  level: IsolationLevel;
  /** Confidence 0-1 in the recommendation. */
  confidence: number;
  /** Human-readable reason for the recommendation. */
  reason: string;
  /** Whether to auto-create a checkpoint at session start. */
  autoCheckpoint: boolean;
  /** Risk score 0-100. */
  riskScore: number;
}

// ─── Risk Keywords ──────────────────────────────────────────────────────────

/** Keywords indicating HIGH risk operations (destructive/structural). */
const HIGH_RISK_KEYWORDS = [
  /\brefactor/i,
  /\breestructur/i,
  /\brestructur/i,
  /\bdelete\b/i,
  /\beliminar?\b/i,
  /\bborrar?\b/i,
  /\bmigrat/i,
  /\boverhaul/i,
  /\brewrite/i,
  /\breescribir/i,
  /\bremove all/i,
  /\bbreak.?apart/i,
  /\bsplit.?file/i,
  /\bextra(ct|er)/i,
  /\bmerge.?conflict/i,
  /\bforce.?push/i,
  /\bgit.?reset/i,
  /\bdrop.?table/i,
  /\bschema.?change/i,
  /\bbreaking.?change/i,
];

/** Keywords indicating MEDIUM risk (additive but multi-file). */
const MEDIUM_RISK_KEYWORDS = [
  /\bfeature/i,
  /\bimplement/i,
  /\bimplementar/i,
  /\badd.?support/i,
  /\bintegrat/i,
  /\bnew.?module/i,
  /\bnuevo.?m[oó]dulo/i,
  /\bupgrade/i,
  /\bactualizar/i,
  /\boptimiz/i,
  /\bperformance/i,
  /\bmulti.?file/i,
  /\bcross.?cutting/i,
  /\bapi.?change/i,
];

/** Keywords indicating LOW risk (single file, cosmetic). */
const LOW_RISK_KEYWORDS = [
  /\bfix.?typo/i,
  /\btypo/i,
  /\breadme/i,
  /\bcomment/i,
  /\bcomentario/i,
  /\bformat/i,
  /\blint/i,
  /\bupdate.?doc/i,
  /\bdocument/i,
  /\bbump.?version/i,
  /\brename.?variable/i,
  /\bconfig/i,
  /\bcss.?change/i,
  /\bestilo/i,
  /\bcolor/i,
];

// ─── Risk Assessment ────────────────────────────────────────────────────────

/**
 * Assess the risk level of a goal and recommend an isolation level.
 * Pure function — no side effects.
 *
 * @param goal — The user's goal or task description
 * @param context — Optional additional context (file count, session type, etc.)
 * @returns IsolationAdvice with level, confidence, and reason
 */
export function assessIsolationLevel(
  goal: string,
  context?: AssessmentContext,
): IsolationAdvice {
  const scores = {
    high: countMatches(goal, HIGH_RISK_KEYWORDS),
    medium: countMatches(goal, MEDIUM_RISK_KEYWORDS),
    low: countMatches(goal, LOW_RISK_KEYWORDS),
  };

  let riskScore = 0;
  riskScore += scores.high * 30;
  riskScore += scores.medium * 15;
  riskScore -= scores.low * 10;

  // Context-based adjustments
  if (context?.estimatedFileCount) {
    if (context.estimatedFileCount > 10) riskScore += 20;
    else if (context.estimatedFileCount > 5) riskScore += 10;
  }
  if (context?.hasTests === false) riskScore += 10;
  if (context?.isProduction) riskScore += 15;

  // Clamp to 0-100
  riskScore = Math.max(0, Math.min(100, riskScore));

  // Determine level
  let level: IsolationLevel;
  let reason: string;
  let confidence: number;

  if (riskScore >= 60) {
    level = "fork-checkpoint";
    reason = buildReason("Alto riesgo", scores, goal);
    confidence = Math.min(0.95, 0.7 + riskScore / 200);
  } else if (riskScore >= 25) {
    level = "fork";
    reason = buildReason("Riesgo moderado", scores, goal);
    confidence = Math.min(0.9, 0.6 + riskScore / 200);
  } else {
    level = "branch-only";
    reason = buildReason("Bajo riesgo", scores, goal);
    confidence = Math.min(0.85, 0.5 + (100 - riskScore) / 200);
  }

  const advice: IsolationAdvice = {
    level,
    confidence,
    reason,
    autoCheckpoint: level === "fork-checkpoint",
    riskScore,
  };

  log(
    `[IsolationAdvisor] goal="${goal.substring(0, 50)}" → ${level} (risk=${riskScore}, conf=${confidence.toFixed(2)})`,
  );

  return advice;
}

// ─── Context ────────────────────────────────────────────────────────────────

export interface AssessmentContext {
  /** Estimated number of files the task will touch. */
  estimatedFileCount?: number;
  /** Whether the code has tests covering the affected area. */
  hasTests?: boolean;
  /** Whether this is a production branch/environment. */
  isProduction?: boolean;
}

// ─── Format ─────────────────────────────────────────────────────────────────

/**
 * Format isolation advice as a compact string for injection into prompts.
 */
export function formatAdvice(advice: IsolationAdvice): string {
  const icon =
    advice.level === "fork-checkpoint"
      ? "🛡️"
      : advice.level === "fork"
        ? "🔒"
        : "📋";

  const lines = [
    `${icon} **Isolation Level: ${advice.level}** (risk: ${advice.riskScore}/100)`,
    `   ${advice.reason}`,
  ];

  if (advice.autoCheckpoint) {
    lines.push("   → Auto-checkpoint activado al inicio de la sesión.");
  }

  return lines.join("\n");
}

// ─── Internal ───────────────────────────────────────────────────────────────

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

function buildReason(
  prefix: string,
  scores: { high: number; medium: number; low: number },
  _goal: string,
): string {
  const parts: string[] = [prefix];
  if (scores.high > 0)
    parts.push(`${scores.high} indicador(es) de alto riesgo`);
  if (scores.medium > 0) parts.push(`${scores.medium} de riesgo medio`);
  if (scores.low > 0) parts.push(`${scores.low} de bajo riesgo`);
  return parts.join(" — ");
}
