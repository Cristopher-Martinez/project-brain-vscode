/**
 * bridge-conversation-rag — TF-IDF search over old PM conversation messages.
 *
 * When the sliding window drops older messages from the active context,
 * this module makes them queryable via lightweight TF-IDF scoring.
 * Same pattern as loop-history-rag.ts but for PM conversation entries.
 */

import { log } from "./logger";
import type { ConversationEntry } from "./bridge-conversation-store";
import { getOldMessages } from "./bridge-conversation-store";

// ── Config ────────────────────────────────────────────────────────

const MIN_SCORE = 0.03;
const DEFAULT_TOP_K = 3;
const RECENCY_BOOST = 0.15;

// ── Public API ────────────────────────────────────────────────────

/**
 * Query old conversation messages using TF-IDF scoring.
 * Only searches messages OUTSIDE the active sliding window.
 *
 * @returns Formatted strings like "[Old #5, user]: ..."
 */
export function queryConversationMemory(
  wsRoot: string,
  sessionId: string,
  query: string,
  windowSize: number,
  topK: number = DEFAULT_TOP_K,
): string[] {
  const oldMsgs = getOldMessages(wsRoot, sessionId, windowSize);
  if (oldMsgs.length === 0) { return []; }

  const scored = scoreMessages(oldMsgs, query);
  const top = scored
    .filter(s => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (top.length > 0) {
    log(`[ConvRAG] Query "${query.slice(0, 40)}..." → ${top.length}/${oldMsgs.length} above threshold`);
  }

  return top.map(s => formatChunk(s.msg));
}

// ── TF-IDF Scoring ───────────────────────────────────────────────

interface ScoredMessage {
  msg: ConversationEntry;
  score: number;
}

function scoreMessages(
  messages: ConversationEntry[],
  query: string,
): ScoredMessage[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) { return []; }

  // Document frequency
  const docFreq = new Map<string, number>();
  const msgTokenSets = messages.map(m => {
    const tokens = tokenize(m.text);
    const unique = new Set(tokens);
    for (const t of unique) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    return { msg: m, tokens };
  });

  const N = messages.length;
  const totalMessages = messages[messages.length - 1]?.id ?? N;

  return msgTokenSets.map(({ msg, tokens }) => {
    if (tokens.length === 0) { return { msg, score: 0 }; }

    // TF-IDF score
    let score = 0;
    const tokenCounts = countTokens(tokens);
    for (const qt of queryTokens) {
      const tf = (tokenCounts.get(qt) ?? 0) / tokens.length;
      const df = docFreq.get(qt) ?? 0;
      if (df === 0) { continue; }
      const idf = Math.log((N + 1) / (df + 1));
      score += tf * idf;
    }

    // Recency boost: newer messages score slightly higher
    const recency = 1 + ((msg.id ?? 0) / (totalMessages + 1)) * RECENCY_BOOST;
    score *= recency;

    return { msg, score };
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúñüà-ž0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

function formatChunk(msg: ConversationEntry): string {
  const preview = msg.text.length > 300 ? msg.text.slice(0, 297) + "..." : msg.text;
  return `[Old msg #${msg.id}, ${msg.role}]: ${preview}`;
}