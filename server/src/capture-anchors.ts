/**
 * Capture Anchors — multilingual prototype phrases that represent "a learning".
 *
 * Phase B of the multilingual capture gate (see docs/MULTILINGUAL_CAPTURE_GATE_PLAN.md).
 * Instead of matching exact trigger phrases per language, we embed candidate
 * sentences and compare them (cosine) against these anchors. A high similarity
 * means "this sentence expresses a lesson/decision/fix" regardless of language.
 *
 * The anchor embeddings are computed once per process and cached in memory.
 *
 * @module capture-anchors
 */

import { generateQueryEmbedding } from "./embeddings.js";

/** Prototype "this is a learning" phrases across languages (EN/ES/DE/FR/PT/IT). */
export const CAPTURE_ANCHORS: string[] = [
  // English
  "I learned that this approach works better",
  "the root cause of the bug was identified",
  "the fix was to change the configuration",
  "always remember to use this pattern, never that one",
  "watch out for this pitfall, it causes issues",
  // Spanish
  "aprendí que esta solución funciona mejor",
  "la causa raíz del error fue identificada",
  "la solución fue cambiar la configuración",
  "hay que recordar usar siempre este patrón, nunca aquel",
  "cuidado con este problema, causa fallos",
  // German
  "die Ursache des Fehlers war ein veralteter Cache",
  "die Lösung war, den Index neu aufzubauen",
  // French
  "la cause racine du bogue était une mauvaise configuration",
  "la solution consistait à invalider le cache",
  // Portuguese
  "a causa raiz do erro foi identificada",
  "aprendi que devemos sempre usar este padrão",
];

let anchorCache: number[][] | null = null;

/**
 * Embed all anchors once, caching the result for the process lifetime.
 * Returns null if the remote embedding provider is unavailable (caller should
 * fall back to lexical capture).
 */
export async function getAnchorEmbeddings(): Promise<number[][] | null> {
  if (anchorCache) return anchorCache;
  try {
    const embeddings = await Promise.all(
      CAPTURE_ANCHORS.map((a) => generateQueryEmbedding(a, undefined, "remote")),
    );
    // Guard: if the provider silently fell back to TF-IDF, embeddings will not
    // share the model dimension across calls reliably. Require a consistent,
    // non-trivial dimension (model embeddings are >= 128 dims; TF-IDF varies).
    const dim = embeddings[0]?.length ?? 0;
    if (dim < 128 || embeddings.some((e) => e.length !== dim)) return null;
    anchorCache = embeddings;
    return anchorCache;
  } catch {
    return null;
  }
}

/** Test hook: reset the in-memory anchor cache. */
export function resetAnchorCache(): void {
  anchorCache = null;
}
