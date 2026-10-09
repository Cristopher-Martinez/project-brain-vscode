/**
 * Semantic Capture — Phase B of the multilingual capture gate.
 *
 * When the lexical (regex) capture finds nothing, this layer embeds each
 * sentence of the input and compares it (cosine) against the multilingual
 * CAPTURE_ANCHORS. Sentences that look like a learning in ANY language are
 * persisted as opinions, reusing the existing clean/safety/dedup machinery.
 *
 * Strategy: hybrid. Lexical fast-path first (cheap, offline). Semantic
 * slow-path only when lexical captures nothing AND the remote embedding
 * provider is available. If embeddings are unreachable, we degrade gracefully
 * to the lexical result (never block the user).
 *
 * @module semantic-capture
 */

import { getAnchorEmbeddings } from "./capture-anchors.js";
import { cosineSimilarity, generateQueryEmbedding } from "./embeddings.js";
import {
  areSimilarStatements,
  captureLearnings,
  cleanStatement,
  isCaptureSafe,
  persistOpinions,
  readOpinions,
  type CaptureResult,
  type Opinion,
} from "./learning.js";

/** Cosine threshold above which a sentence is considered a learning. */
const SEM_THRESHOLD = Number(process.env.CAPTURE_SEM_THRESHOLD) || 0.6;
const MIN_SENTENCE_LEN = 20;
const MAX_SENTENCES = 40;

interface SemanticHit {
  statement: string;
  score: number;
}

/** Split text into candidate sentences (sentence punctuation + newlines/semicolons). */
export function segmentSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN)
    .slice(0, MAX_SENTENCES);
}

/**
 * Score each sentence against the multilingual anchors. Returns null when the
 * embedding provider is unavailable (signals the caller to fall back).
 */
async function scoreSentences(text: string): Promise<SemanticHit[] | null> {
  const anchors = await getAnchorEmbeddings();
  if (!anchors) return null;
  const dim = anchors[0].length;
  const hits: SemanticHit[] = [];
  for (const sentence of segmentSentences(text)) {
    let emb: number[];
    try {
      emb = await generateQueryEmbedding(sentence, undefined, "remote");
    } catch {
      return null;
    }
    if (emb.length !== dim) return null; // provider fell back to TF-IDF
    let best = 0;
    for (const anchor of anchors) {
      const sim = cosineSimilarity(emb, anchor);
      if (sim > best) best = sim;
    }
    if (best >= SEM_THRESHOLD) hits.push({ statement: sentence, score: best });
  }
  return hits;
}

/** Persist semantic hits as opinions, reusing clean/safety/dedup machinery. */
function persistSemanticHits(
  memoryPath: string,
  hits: SemanticHit[],
  source: string | undefined,
): CaptureResult {
  const existing: Opinion[] = readOpinions(memoryPath);
  const evidence = source || `mcp-sem-${new Date().toISOString().split("T")[0]}`;
  const newStatements: string[] = [];

  for (const hit of hits) {
    const cleaned = cleanStatement(hit.statement);
    if (!cleaned || !isCaptureSafe(cleaned)) continue;
    if (existing.some((o) => areSimilarStatements(o.statement, cleaned))) continue;
    if (newStatements.some((s) => areSimilarStatements(s, cleaned))) continue;
    const now = new Date().toISOString().split("T")[0];
    existing.push({
      id: `op_${Math.random().toString(36).substring(2, 8)}`,
      statement: cleaned,
      confidence: Math.min(0.8, Math.max(0.5, hit.score)),
      domain: "general",
      evidence: { supporting: [`${evidence} (semantic ${hit.score.toFixed(2)})`], contradicting: [] },
      createdAt: now,
      lastUpdated: now,
    });
    newStatements.push(cleaned);
  }

  if (newStatements.length > 0) persistOpinions(memoryPath, existing);
  return { captured: newStatements.length, total: existing.length, statements: newStatements };
}

/**
 * Hybrid capture: lexical fast-path, then multilingual semantic slow-path.
 *
 * 1. Run the (diacritic-folded) regex capture. If it captures anything, done.
 * 2. Otherwise, if embeddings are available, run the semantic gate.
 * 3. If embeddings are unavailable, return the lexical result unchanged.
 */
export async function captureLearningHybrid(
  memoryPath: string,
  text: string,
  source?: string,
): Promise<CaptureResult & { mode: "lexical" | "semantic" | "none" }> {
  const lexical = captureLearnings(memoryPath, text, source);
  if (lexical.captured > 0) return { ...lexical, mode: "lexical" };

  const hits = await scoreSentences(text);
  if (!hits || hits.length === 0) {
    return { ...lexical, mode: "none" };
  }

  const semantic = persistSemanticHits(memoryPath, hits, source);
  return { ...semantic, mode: semantic.captured > 0 ? "semantic" : "none" };
}
