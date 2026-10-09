/**
 * Reflect — portable opinion hygiene (zero vscode deps).
 *
 * Migrated from the extension's opinion-reflect. Runs maintenance on
 * 14_OPINIONS.md: time decay, dedup-merge, contradiction detection,
 * test-artifact purge, low-confidence prune/flag. Pure fs via learning.ts.
 */

import {
  type Opinion,
  areSimilarStatements,
  persistOpinions,
  readOpinions,
} from "./learning.js";

const MAX_CONFIDENCE = 0.99;
const MIN_CONFIDENCE = 0.05;
const AUTO_PRUNE_THRESHOLD = 0.15;

const TEST_ARTIFACT_PATTERNS = [
  /\bFIRE TEST\b/i,
  /\btest pipeline\b/i,
  /\btest result\b/i,
  /\bsmoke test\b/i,
  /^(FIRE TEST|TEST)\s*\d/i,
  /\bprueba de fuego\b/i,
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isPolarityOpposite(newStmt: string, existingStmt: string): boolean {
  const mainClause = (s: string): string => s.split(/\s*[—;.]\s*/)[0] || s;
  const cleanForPolarity = (s: string): string =>
    s
      .replace(/\bno solo\b/gi, "")
      .replace(/\bnot only\b/gi, "")
      .replace(/\bnot just\b/gi, "");
  const negPattern =
    /\b(nunca|never|no|don't|dont|avoid|not|jamás|jamas|prohibido|forbidden|evitar|stop|malo|bad|incorrecto|incorrect|wrong)\b/gi;
  const newMain = cleanForPolarity(mainClause(newStmt));
  const existMain = cleanForPolarity(mainClause(existingStmt));
  const newHasNeg = negPattern.test(newMain);
  negPattern.lastIndex = 0;
  const existHasNeg = negPattern.test(existMain);
  return newHasNeg !== existHasNeg;
}

export interface ReflectReport {
  total: number;
  pruned: { id: string; statement: string; reason: string }[];
  merged: { kept: string; removed: string }[];
  contradictions: { id1: string; id2: string }[];
  stale: { id: string; confidence: number }[];
  lowConfidence: { id: string; confidence: number }[];
  testArtifacts: { id: string }[];
  dryRun: boolean;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function applyDecay(opinions: Opinion[], now: Date, staleDate: string, report: ReflectReport, dryRun: boolean): void {
  for (const op of opinions) {
    if (op.lastUpdated < staleDate) {
      const daysSince = Math.floor((now.getTime() - new Date(op.lastUpdated).getTime()) / 86400000);
      const cycles = Math.floor(daysSince / 30);
      if (cycles > 0 && !dryRun) {
        const evidenceFactor = Math.min(op.evidence.supporting.length, 5) / 5;
        const rate = 0.05 - evidenceFactor * 0.03;
        const oldConf = op.confidence;
        op.confidence = clamp(op.confidence - cycles * rate, MIN_CONFIDENCE, MAX_CONFIDENCE);
        if (op.confidence !== oldConf) op.lastUpdated = now.toISOString().split("T")[0];
      }
    }
    if (op.confidence < 0.3 && op.lastUpdated < staleDate && op.evidence.supporting.length <= 1) {
      report.stale.push({ id: op.id, confidence: op.confidence });
    }
  }
}

function mergeDuplicates(opinions: Opinion[], now: Date, toRemove: Set<string>, report: ReflectReport, dryRun: boolean): void {
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
        }
        toRemove.add(discard.id);
        report.merged.push({ kept: keep.id, removed: discard.id });
      }
    }
  }
}

function detectContradictions(opinions: Opinion[], toRemove: Set<string>, report: ReflectReport): void {
  for (let i = 0; i < opinions.length; i++) {
    if (toRemove.has(opinions[i].id)) continue;
    for (let j = i + 1; j < opinions.length; j++) {
      if (toRemove.has(opinions[j].id)) continue;
      if (opinions[i].domain !== opinions[j].domain) continue;
      if (
        areSimilarStatements(opinions[i].statement, opinions[j].statement) &&
        isPolarityOpposite(opinions[i].statement, opinions[j].statement)
      ) {
        report.contradictions.push({ id1: opinions[i].id, id2: opinions[j].id });
      }
    }
  }
}

function purgeAndFlag(opinions: Opinion[], toRemove: Set<string>, report: ReflectReport): void {
  for (const op of opinions) {
    if (TEST_ARTIFACT_PATTERNS.some((p) => p.test(op.statement)) && !toRemove.has(op.id)) {
      toRemove.add(op.id);
      report.testArtifacts.push({ id: op.id });
    }
  }
  for (const op of opinions) {
    if (op.confidence <= AUTO_PRUNE_THRESHOLD && !toRemove.has(op.id)) {
      toRemove.add(op.id);
      report.pruned.push({ id: op.id, statement: op.statement, reason: `very low confidence (${op.confidence.toFixed(2)})` });
    }
  }
  for (const op of opinions) {
    if (op.confidence < 0.3 && !toRemove.has(op.id)) {
      report.lowConfidence.push({ id: op.id, confidence: op.confidence });
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Run opinion maintenance on a project. Persists unless dryRun. */
export function reflectOpinions(memoryPath: string, dryRun: boolean): ReflectReport {
  const opinions = readOpinions(memoryPath);
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

  applyDecay(opinions, now, staleDate, report, dryRun);
  const toRemove = new Set<string>();
  mergeDuplicates(opinions, now, toRemove, report, dryRun);
  detectContradictions(opinions, toRemove, report);
  purgeAndFlag(opinions, toRemove, report);

  const remaining = opinions.filter((o) => !toRemove.has(o.id));
  report.total = remaining.length;

  if (!dryRun && (toRemove.size > 0 || report.merged.length > 0)) {
    persistOpinions(memoryPath, remaining);
  }

  return report;
}
