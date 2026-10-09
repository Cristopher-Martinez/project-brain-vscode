/**
 * loop-history-rag — Lightweight RAG over loop iteration history.
 *
 * Reads history.json for a given loop session and provides keyword-based
 * retrieval chunks that the PM can use as grounding context.
 *
 * Strategy: TF-IDF-lite scoring over chunked iterations.
 * No external embedding model needed — runs entirely in-process.
 *
 * @module loop-history-rag
 */

import { log, logWarn } from "./logger";
import { readLoopHistory, type LoopHistory, type HistoryIteration } from "./loop-history";
import type { BridgeSynthesis } from "./auto-loop-bridge-types";

// ── Types ────────────────────────────────────────────────────────

export interface HistoryChunk {
  /** Source iteration index (1-based). */
  round: number;
  /** Chunk type: synthesis, feedback, or combined. */
  type: "synthesis" | "feedback" | "combined";
  /** The chunk text content. */
  content: string;
  /** Relevance score (0-1) when scored against a query. */
  score: number;
}

export interface HistoryRAGResult {
  /** Top-K relevant chunks, sorted by score descending. */
  chunks: HistoryChunk[];
  /** Total iterations in the history. */
  totalIterations: number;
  /** Session goal (for context). */
  goal: string;
}

// ── Constants ────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 1500;
const DEFAULT_TOP_K = 5;
const MIN_SCORE_THRESHOLD = 0.05;

// ── Public API ───────────────────────────────────────────────────

/**
 * Load loop history and build a retrieval-ready chunk index.
 * Returns all chunks (unscored) for pre-caching at session creation.
 */
export function loadHistoryChunks(
  loopSessionId: string,
  repoRoot?: string,
): HistoryChunk[] {
  const history = readLoopHistory(loopSessionId, repoRoot);
  if (!history || history.iterations.length === 0) {
    logWarn(`[HistoryRAG] No history found for ${loopSessionId.substring(0, 8)}`);
    return [];
  }

  const chunks = chunkIterations(history);
  log(`[HistoryRAG] Loaded ${chunks.length} chunks from ${history.iterations.length} iterations`);
  return chunks;
}

/**
 * Query loop history with a user message and return relevant chunks.
 * Uses lightweight TF-IDF scoring — no external model needed.
 */
export function queryLoopHistory(
  loopSessionId: string,
  query: string,
  topK: number = DEFAULT_TOP_K,
  repoRoot?: string,
): HistoryRAGResult {
  const history = readLoopHistory(loopSessionId, repoRoot);
  if (!history) {
    return { chunks: [], totalIterations: 0, goal: "" };
  }

  const allChunks = chunkIterations(history);
  const scored = scoreChunks(allChunks, query);
  const filtered = scored
    .filter((c) => c.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  log(
    `[HistoryRAG] Query "${query.substring(0, 40)}..." → ${filtered.length}/${allChunks.length} chunks above threshold`,
  );

  return {
    chunks: filtered,
    totalIterations: history.totalIterations,
    goal: history.goal,
  };
}

/**
 * Build a context summary from the full loop history.
 * Used as a baseline retrieval pack when no specific query exists yet.
 */
export function buildHistorySummaryChunks(
  loopSessionId: string,
  maxChunks: number = 3,
  repoRoot?: string,
): string[] {
  const history = readLoopHistory(loopSessionId, repoRoot);
  if (!history || history.iterations.length === 0) return [];

  const summaryParts: string[] = [];

  // Always include the goal
  summaryParts.push(
    `[Loop Goal]: ${history.goal}`,
  );

  // Include latest N iterations as combined chunks
  const recent = history.iterations.slice(-maxChunks);
  for (const iter of recent) {
    const parts: string[] = [`[Round ${iter.index}]`];
    if (iter.synthesis) {
      parts.push(`Synthesis: ${truncate(iter.synthesis, 600)}`);
    }
    if (iter.feedback) {
      parts.push(`Feedback: ${truncate(iter.feedback, 300)}`);
    }
    summaryParts.push(parts.join("\n"));
  }

  log(
    `[HistoryRAG] Built ${summaryParts.length} summary chunks for ${loopSessionId.substring(0, 8)}`,
  );

  return summaryParts;
}


/**
 * Load loop history and convert iterations with syntheses into BridgeSynthesis[].
 * Used to pre-populate bridge sessions with historical context.
 */
export function loadHistoryAsBridgeSyntheses(
  loopSessionId: string,
  repoRoot?: string,
): BridgeSynthesis[] {
  const history = readLoopHistory(loopSessionId, repoRoot);
  if (!history || history.iterations.length === 0) {
    logWarn(`[HistoryRAG] No history for bridge syntheses: ${loopSessionId.substring(0, 8)}`);
    return [];
  }

  const syntheses: BridgeSynthesis[] = [];
  for (const iter of history.iterations) {
    if (!iter.synthesis) continue;
    const rand = Math.random().toString(36).slice(2, 8);
    syntheses.push({
      synthesisId: `synth_hist_${loopSessionId.slice(0, 8)}_${iter.index}_${rand}`,
      sessionId: loopSessionId,
      content: iter.synthesis,
      round: iter.index,
      timestamp: iter.completedAt
        ? new Date(iter.completedAt).getTime()
        : Date.now(),
    });
  }

  log(`[HistoryRAG] Converted ${syntheses.length} iterations to bridge syntheses for ${loopSessionId.substring(0, 8)}`);
  return syntheses;
}

// ── Chunking ─────────────────────────────────────────────────────

function chunkIterations(history: LoopHistory): HistoryChunk[] {
  const chunks: HistoryChunk[] = [];

  for (const iter of history.iterations) {
    if (iter.synthesis) {
      chunks.push({
        round: iter.index,
        type: "synthesis",
        content: truncate(iter.synthesis, MAX_CHUNK_CHARS),
        score: 0,
      });
    }

    if (iter.feedback) {
      chunks.push({
        round: iter.index,
        type: "feedback",
        content: truncate(iter.feedback, MAX_CHUNK_CHARS),
        score: 0,
      });
    }

    // Combined chunk for short iterations
    if (iter.synthesis && iter.feedback) {
      const combined = `[Round ${iter.index}]\nSynthesis: ${truncate(iter.synthesis, 600)}\nFeedback: ${truncate(iter.feedback, 300)}`;
      if (combined.length < MAX_CHUNK_CHARS) {
        chunks.push({
          round: iter.index,
          type: "combined",
          content: combined,
          score: 0,
        });
      }
    }
  }

  return chunks;
}

// ── Scoring (TF-IDF lite) ────────────────────────────────────────

function scoreChunks(chunks: HistoryChunk[], query: string): HistoryChunk[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return chunks.map((c) => ({ ...c, score: 0 }));

  // Build IDF: how many chunks contain each token
  const docFreq = new Map<string, number>();
  const chunkTokenSets = chunks.map((c) => new Set(tokenize(c.content)));

  for (const tokenSet of chunkTokenSets) {
    for (const token of tokenSet) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const totalDocs = chunks.length || 1;

  return chunks.map((chunk, i) => {
    const chunkTokens = tokenize(chunk.content);
    const tokenSet = chunkTokenSets[i];
    let score = 0;

    for (const qt of queryTokens) {
      if (!tokenSet.has(qt)) continue;

      // TF: frequency in chunk
      const tf = chunkTokens.filter((t) => t === qt).length / chunkTokens.length;
      // IDF: inverse document frequency
      const df = docFreq.get(qt) ?? 1;
      const idf = Math.log(totalDocs / df);
      score += tf * idf;
    }

    // Recency boost: newer iterations score slightly higher
    const recencyBoost = 1 + (chunk.round / (totalDocs + 1)) * 0.2;
    score *= recencyBoost;

    return { ...chunk, score };
  });
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// ── Utilities ────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + " [truncated]";
}
