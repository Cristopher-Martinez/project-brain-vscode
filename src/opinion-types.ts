/**
 * Opinion Types — Shared types, constants, and utilities for the opinion system.
 *
 * Extracted from opinion-bank.ts to comply with 400-line limit.
 * All opinion-related types, constants, and pure utility functions live here.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Opinion {
  id: string;
  statement: string;
  confidence: number; // 0.0 – 1.0
  domain: string; // architecture, patterns, tools, debugging, workflow, preferences
  evidence: {
    supporting: string[];
    contradicting: string[];
  };
  createdAt: string;
  lastUpdated: string;
}

export type OpinionDomain =
  | "architecture"
  | "patterns"
  | "tools"
  | "debugging"
  | "workflow"
  | "preferences"
  | "general";

/** Report from the Reflect cycle — what changed during maintenance. */
export interface ReflectReport {
  total: number;
  pruned: { id: string; statement: string; reason: string }[];
  merged: { kept: string; removed: string; statement: string }[];
  contradictions: { id1: string; id2: string; statements: [string, string] }[];
  stale: { id: string; statement: string; confidence: number }[];
  lowConfidence: { id: string; statement: string; confidence: number }[];
  testArtifacts: { id: string; statement: string }[];
  dryRun: boolean;
}

/** Quick health metrics — no side effects, safe for cron auto-healing. */
export interface HealthReport {
  total: number;
  avgConfidence: number;
  staleCount: number;
  duplicatePairs: number;
  testArtifactCount: number;
  lowConfidenceCount: number;
  healthy: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const OPINIONS_FILE = "14_OPINIONS.md";
export const REINFORCE_DELTA = 0.05;
export const CONTRADICT_DELTA_WEAK = -0.1;
export const CONTRADICT_DELTA_STRONG = -0.25;
export const MAX_CONFIDENCE = 0.99;
export const MIN_CONFIDENCE = 0.05;
export const MAX_OPINIONS = 200;

/** Patterns that indicate test/fire-test artifacts (should be purged). */
export const TEST_ARTIFACT_PATTERNS = [
  /\bFIRE TEST\b/i,
  /\btest pipeline\b/i,
  /\btest result\b/i,
  /\bsmoke test\b/i,
  /^(FIRE TEST|TEST)\s*\d/i,
  /\bprueba de fuego\b/i,
];

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Clamp a number between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Strip surrounding punctuation and extract significant words (>3 chars).
 * Fixes: "deploy," ≠ "deploy" and "dist/" ≠ "dist" — now they match.
 */
export function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/^[^\wáéíóúñü]+|[^\wáéíóúñü]+$/g, ""))
      .filter((w) => w.length > 3),
  );
}

/** Check if two statements are similar (>60% word overlap). */
export function areSimilarStatements(a: string, b: string): boolean {
  const wordsA = extractWords(a);
  const wordsB = extractWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

/**
 * Detect opposite polarity between two similar statements.
 * Analyzes ONLY the main clause (before — . ; ,) to avoid
 * false positives from secondary clauses.
 */
export function isPolarityOpposite(
  newStmt: string,
  existingStmt: string,
): boolean {
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
