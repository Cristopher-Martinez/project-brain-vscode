/**
 * Opinion Reflect — Standalone reflect & health-check logic.
 *
 * Extracted from opinion-bank.ts to comply with 400-line limit.
 * Pure analysis functions with dependency injection for side effects.
 */

import type { HealthReport, Opinion, ReflectReport } from "./opinion-types";
import {
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  TEST_ARTIFACT_PATTERNS,
  areSimilarStatements,
  clamp,
  isPolarityOpposite,
} from "./opinion-types";

// ─── Dependency interface ───────────────────────────────────────────────────

/** Dependencies injected by OpinionBank into reflect operations. */
export interface ReflectContext {
  log: (msg: string) => void;
  markDirty: () => void;
}

/** Result of reflectOpinions — report + IDs to remove (caller handles removal). */
export interface ReflectResult {
  report: ReflectReport;
  toRemove: Set<string>;
}

// ─── Reflect ────────────────────────────────────────────────────────────────

/**
 * Perform opinion hygiene analysis + optional mutations.
 *
 * Steps:
 * 1. Evidence-weighted time decay on stale opinions
 * 2. Detect & merge near-duplicates (>60% word overlap)
 * 2.5. Detect contradictions (same domain, opposite polarity)
 * 3. Detect test artifacts
 * 4. Auto-prune very low confidence
 * 5. Flag low-confidence for review
 *
 * Returns report + set of IDs to remove. Caller handles
 * actual array filtering and persistence (step 6).
 *
 * @param opinions — Mutable array. Decay (step 1) and merge (step 2) mutate in-place.
 * @param ctx — Logger and dirty-flag callback.
 * @param dryRun — When true, skip all mutations. Pure analysis.
 */
export function reflectOpinions(
  opinions: Opinion[],
  ctx: ReflectContext,
  dryRun: boolean,
): ReflectResult {
  const report: ReflectReport = {
    total: opinions.length,
    pruned: [],
    merged: [],
    contradictions: [],
    stale: [],
    lowConfidence: [],
    testArtifacts: [],
    dryRun,
  };

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const staleDate = thirtyDaysAgo.toISOString().split("T")[0];

  // ── Step 1: Evidence-weighted time decay ──────────────────────────
  applyDecay(opinions, now, staleDate, report, ctx, dryRun);

  // ── Step 2: Find near-duplicates and merge ────────────────────────
  const toRemove = new Set<string>();
  findAndMergeDuplicates(opinions, now, toRemove, report, ctx, dryRun);

  // ── Step 2.5: Detect contradictions ───────────────────────────────
  detectContradictions(opinions, toRemove, report);

  // ── Step 3: Detect test artifacts ─────────────────────────────────
  detectTestArtifacts(opinions, toRemove, report);

  // ── Step 4: Auto-prune very low confidence ────────────────────────
  autoPruneLowConfidence(opinions, toRemove, report);

  // ── Step 5: Flag low-confidence ───────────────────────────────────
  flagLowConfidence(opinions, toRemove, report);

  // Step 6 (removal + save) is handled by caller

  report.total = dryRun ? opinions.length - toRemove.size : opinions.length;

  const mode = dryRun ? "[DRY RUN] " : "";
  ctx.log(
    `[OpinionBank] ${mode}Reflect: ${report.pruned.length} pruned, ${report.merged.length} merged, ` +
      `${report.contradictions.length} contradictions, ${report.testArtifacts.length} test artifacts, ` +
      `${report.stale.length} stale, ${report.lowConfidence.length} low-confidence. ` +
      `${report.total} opinions ${dryRun ? "would remain" : "remaining"}.`,
  );

  return { report, toRemove };
}

// ─── Step helpers ───────────────────────────────────────────────────────────

function applyDecay(
  opinions: Opinion[],
  now: Date,
  staleDate: string,
  report: ReflectReport,
  ctx: ReflectContext,
  dryRun: boolean,
): void {
  for (const op of opinions) {
    if (op.lastUpdated < staleDate) {
      const daysSinceUpdate = Math.floor(
        (now.getTime() - new Date(op.lastUpdated).getTime()) /
          (1000 * 60 * 60 * 24),
      );
      const decayCycles = Math.floor(daysSinceUpdate / 30);
      if (decayCycles > 0 && !dryRun) {
        const evidenceFactor = Math.min(op.evidence.supporting.length, 5) / 5;
        const ratePerCycle = 0.05 - evidenceFactor * 0.03;
        const decay = decayCycles * ratePerCycle;
        const oldConf = op.confidence;
        op.confidence = clamp(
          op.confidence - decay,
          MIN_CONFIDENCE,
          MAX_CONFIDENCE,
        );
        if (op.confidence !== oldConf) {
          op.lastUpdated = now.toISOString().split("T")[0];
          ctx.markDirty();
          ctx.log(
            `[OpinionBank] Decay: "${op.statement.substring(0, 40)}" ` +
              `${oldConf.toFixed(2)} → ${op.confidence.toFixed(2)} ` +
              `(${decayCycles} cycles, rate=${ratePerCycle.toFixed(3)})`,
          );
        }
      }
    }

    if (
      op.confidence < 0.3 &&
      op.lastUpdated < staleDate &&
      op.evidence.supporting.length <= 1
    ) {
      report.stale.push({
        id: op.id,
        statement: op.statement,
        confidence: op.confidence,
      });
    }
  }
}

function findAndMergeDuplicates(
  opinions: Opinion[],
  now: Date,
  toRemove: Set<string>,
  report: ReflectReport,
  ctx: ReflectContext,
  dryRun: boolean,
): void {
  for (let i = 0; i < opinions.length; i++) {
    if (toRemove.has(opinions[i].id)) continue;
    for (let j = i + 1; j < opinions.length; j++) {
      if (toRemove.has(opinions[j].id)) continue;
      if (areSimilarStatements(opinions[i].statement, opinions[j].statement)) {
        const [keep, discard] =
          opinions[i].confidence >= opinions[j].confidence
            ? [opinions[i], opinions[j]]
            : [opinions[j], opinions[i]];

        if (!dryRun) {
          keep.evidence.supporting.push(...discard.evidence.supporting);
          keep.evidence.contradicting.push(...discard.evidence.contradicting);
          keep.lastUpdated = now.toISOString().split("T")[0];
          ctx.markDirty();
        }

        toRemove.add(discard.id);
        report.merged.push({
          kept: keep.id,
          removed: discard.id,
          statement: keep.statement,
        });
      }
    }
  }
}

function detectContradictions(
  opinions: Opinion[],
  toRemove: Set<string>,
  report: ReflectReport,
): void {
  for (let i = 0; i < opinions.length; i++) {
    if (toRemove.has(opinions[i].id)) continue;
    for (let j = i + 1; j < opinions.length; j++) {
      if (toRemove.has(opinions[j].id)) continue;
      if (opinions[i].domain !== opinions[j].domain) continue;
      if (
        areSimilarStatements(opinions[i].statement, opinions[j].statement) &&
        isPolarityOpposite(opinions[i].statement, opinions[j].statement)
      ) {
        report.contradictions.push({
          id1: opinions[i].id,
          id2: opinions[j].id,
          statements: [opinions[i].statement, opinions[j].statement],
        });
      }
    }
  }
}

function detectTestArtifacts(
  opinions: Opinion[],
  toRemove: Set<string>,
  report: ReflectReport,
): void {
  for (const op of opinions) {
    if (TEST_ARTIFACT_PATTERNS.some((p) => p.test(op.statement))) {
      if (!toRemove.has(op.id)) {
        toRemove.add(op.id);
        report.testArtifacts.push({ id: op.id, statement: op.statement });
      }
    }
  }
}

function autoPruneLowConfidence(
  opinions: Opinion[],
  toRemove: Set<string>,
  report: ReflectReport,
): void {
  const autoPruneThreshold = 0.15;
  for (const op of opinions) {
    if (op.confidence <= autoPruneThreshold && !toRemove.has(op.id)) {
      toRemove.add(op.id);
      report.pruned.push({
        id: op.id,
        statement: op.statement,
        reason: `very low confidence (${op.confidence.toFixed(2)})`,
      });
    }
  }
}

function flagLowConfidence(
  opinions: Opinion[],
  toRemove: Set<string>,
  report: ReflectReport,
): void {
  for (const op of opinions) {
    if (op.confidence < 0.3 && !toRemove.has(op.id)) {
      report.lowConfidence.push({
        id: op.id,
        statement: op.statement,
        confidence: op.confidence,
      });
    }
  }
}

// ─── Health Check ───────────────────────────────────────────────────────────

/**
 * Quick health metrics — pure read-only analysis, no side effects.
 * Safe for cron auto-healing.
 */
export function opinionHealthCheck(opinions: Opinion[]): HealthReport {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const staleDate = thirtyDaysAgo.toISOString().split("T")[0];

  let totalConf = 0;
  let staleCount = 0;
  let lowConfCount = 0;
  let testArtifactCount = 0;
  let duplicatePairs = 0;

  for (const op of opinions) {
    totalConf += op.confidence;
    if (op.confidence < 0.3) lowConfCount++;
    if (op.lastUpdated < staleDate && op.evidence.supporting.length <= 1) {
      staleCount++;
    }
    if (TEST_ARTIFACT_PATTERNS.some((p) => p.test(op.statement))) {
      testArtifactCount++;
    }
  }

  for (let i = 0; i < opinions.length; i++) {
    for (let j = i + 1; j < opinions.length; j++) {
      if (areSimilarStatements(opinions[i].statement, opinions[j].statement)) {
        duplicatePairs++;
      }
    }
  }

  const avgConfidence = opinions.length > 0 ? totalConf / opinions.length : 0;

  const healthy =
    duplicatePairs === 0 &&
    testArtifactCount === 0 &&
    lowConfCount <= Math.ceil(opinions.length * 0.3) &&
    staleCount <= Math.ceil(opinions.length * 0.2);

  return {
    total: opinions.length,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    staleCount,
    duplicatePairs,
    testArtifactCount,
    lowConfidenceCount: lowConfCount,
    healthy,
  };
}
