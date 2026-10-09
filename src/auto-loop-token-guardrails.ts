/**
 * auto-loop-token-guardrails — Hard-cap enforcement for Auto Loop Bridge PM calls.
 *
 * Phase E of the Auto Loop Bridge system.
 * Centralizes all budget constants and provides:
 *  - Hard ceiling values that override any user-supplied budget
 *  - Truncation metrics per PM call (for diagnostics)
 *  - Budget warning detection before hitting limits
 *  - Rate-limit check per session (calls per minute)
 *
 * These guardrails prevent accidental cost blowup from the PM channel.
 */

import { log, logWarn } from "./logger";
import type { BridgeTokenBudget } from "./auto-loop-bridge-types";

// ── Hard Ceilings ────────────────────────────────────────────────

/**
 * Absolute maximum values. Even if a session config provides higher,
 * these ceilings are enforced at assembly time.
 */
export const BRIDGE_HARD_CAPS = {
  /** Absolute max chars in the assembled context brief */
  maxContextChars: 16_000,
  /** Max retrieval chunks sent to PM per call */
  maxRetrievedChunks: 10,
  /** Max PM suggestion turns per session lifetime */
  maxSuggestionTurns: 50,
  /** Max tokens per single PM response */
  maxTokensPerTurn: 4096,
  /** Max PM calls per minute per session (rate-limit) */
  maxCallsPerMinute: 10,
} as const;

/**
 * Default budget values used when session config doesn't specify them.
 */
export const BRIDGE_DEFAULT_BUDGET: BridgeTokenBudget = {
  maxContextChars: 8000,
  maxRetrievedChunks: 5,
  maxSuggestionTurns: 50,
  maxTokensPerTurn: 2048,
  consumedTurns: 0,
};

// ── Budget Enforcement ───────────────────────────────────────────

/**
 * Clamp a user-supplied budget to hard ceilings.
 * Returns a new budget object (does not mutate input).
 */
export function clampBudget(budget: BridgeTokenBudget): BridgeTokenBudget {
  return {
    maxContextChars: Math.min(budget.maxContextChars, BRIDGE_HARD_CAPS.maxContextChars),
    maxRetrievedChunks: Math.min(budget.maxRetrievedChunks, BRIDGE_HARD_CAPS.maxRetrievedChunks),
    maxSuggestionTurns: Math.min(budget.maxSuggestionTurns, BRIDGE_HARD_CAPS.maxSuggestionTurns),
    maxTokensPerTurn: Math.min(
      budget.maxTokensPerTurn ?? BRIDGE_DEFAULT_BUDGET.maxTokensPerTurn!,
      BRIDGE_HARD_CAPS.maxTokensPerTurn
    ),
    consumedTurns: budget.consumedTurns,
  };
}

// ── Budget Warnings ──────────────────────────────────────────────

export type BudgetWarningLevel = "ok" | "approaching" | "critical" | "exhausted";

export interface BudgetWarning {
  level: BudgetWarningLevel;
  turnsRemaining: number;
  turnsTotal: number;
  message: string;
}

/**
 * Check turn budget status and return a warning if approaching limits.
 */
export function checkBudgetWarning(budget: BridgeTokenBudget): BudgetWarning {
  const remaining = budget.maxSuggestionTurns - budget.consumedTurns;
  const ratio = budget.consumedTurns / budget.maxSuggestionTurns;

  if (remaining <= 0) {
    return {
      level: "exhausted",
      turnsRemaining: 0,
      turnsTotal: budget.maxSuggestionTurns,
      message: `Turn budget exhausted (${budget.consumedTurns}/${budget.maxSuggestionTurns})`,
    };
  }
  if (ratio >= 0.9) {
    return {
      level: "critical",
      turnsRemaining: remaining,
      turnsTotal: budget.maxSuggestionTurns,
      message: `Only ${remaining} turns remaining`,
    };
  }
  if (ratio >= 0.7) {
    return {
      level: "approaching",
      turnsRemaining: remaining,
      turnsTotal: budget.maxSuggestionTurns,
      message: `${remaining} turns remaining (${Math.round(ratio * 100)}% used)`,
    };
  }
  return {
    level: "ok",
    turnsRemaining: remaining,
    turnsTotal: budget.maxSuggestionTurns,
    message: `${remaining} turns remaining`,
  };
}

// ── Truncation Metrics ───────────────────────────────────────────

export interface TruncationMetrics {
  synthesisOriginalChars: number;
  synthesisTrimmedChars: number;
  historyOriginalCount: number;
  historyTrimmedCount: number;
  retrievalOriginalCount: number;
  retrievalTrimmedCount: number;
  totalAssembledChars: number;
  budgetUtilization: number;
  truncationsApplied: string[];
}

/**
 * Log truncation metrics after context assembly.
 * Only logs a warning when truncations actually occurred.
 */
export function logTruncationMetrics(
  sessionId: string,
  metrics: TruncationMetrics
): void {
  if (metrics.truncationsApplied.length === 0) {
    log(
      `[TokenGuardrails] ${sessionId.slice(0, 8)}: context assembled ` +
        `${metrics.totalAssembledChars} chars (${Math.round(metrics.budgetUtilization * 100)}% budget)`
    );
    return;
  }

  logWarn(
    `[TokenGuardrails] ${sessionId.slice(0, 8)}: ` +
      `${metrics.truncationsApplied.length} truncation(s) applied — ` +
      metrics.truncationsApplied.join(", ") +
      ` | Total: ${metrics.totalAssembledChars} chars (${Math.round(metrics.budgetUtilization * 100)}% budget)`
  );
}

/**
 * Build truncation metrics by comparing pre/post assembly sizes.
 */
export function buildTruncationMetrics(
  pre: { synthesisChars: number; historyCount: number; retrievalCount: number },
  post: { synthesisChars: number; historyCount: number; retrievalCount: number; totalChars: number },
  budget: BridgeTokenBudget
): TruncationMetrics {
  const truncations: string[] = [];
  if (post.synthesisChars < pre.synthesisChars) {
    truncations.push(`synthesis: ${pre.synthesisChars}→${post.synthesisChars}`);
  }
  if (post.historyCount < pre.historyCount) {
    truncations.push(`history: ${pre.historyCount}→${post.historyCount} msgs`);
  }
  if (post.retrievalCount < pre.retrievalCount) {
    truncations.push(`retrieval: ${pre.retrievalCount}→${post.retrievalCount} chunks`);
  }
  return {
    synthesisOriginalChars: pre.synthesisChars,
    synthesisTrimmedChars: post.synthesisChars,
    historyOriginalCount: pre.historyCount,
    historyTrimmedCount: post.historyCount,
    retrievalOriginalCount: pre.retrievalCount,
    retrievalTrimmedCount: post.retrievalCount,
    totalAssembledChars: post.totalChars,
    budgetUtilization: budget.maxContextChars > 0
      ? post.totalChars / budget.maxContextChars
      : 0,
    truncationsApplied: truncations,
  };
}

// ── Rate Limiter ─────────────────────────────────────────────────

const callTimestamps = new Map<string, number[]>();

/**
 * Check if a PM call is allowed under the per-minute rate limit.
 * Returns false if rate-limited.
 */
export function checkPmChatRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const timestamps = callTimestamps.get(sessionId) ?? [];
  const recent = timestamps.filter((t) => now - t < window);

  if (recent.length >= BRIDGE_HARD_CAPS.maxCallsPerMinute) {
    logWarn(
      `[TokenGuardrails] Rate limit hit for ${sessionId.slice(0, 8)}: ` +
        `${recent.length}/${BRIDGE_HARD_CAPS.maxCallsPerMinute} calls in last 60s`
    );
    return false;
  }

  recent.push(now);
  callTimestamps.set(sessionId, recent);
  return true;
}

export function clearPmChatRateLimit(sessionId: string): void {
  callTimestamps.delete(sessionId);
}
