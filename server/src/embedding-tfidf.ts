/**
 * TF-IDF Embedding Provider — Local, zero-dependency fallback
 *
 * Uses Term Frequency–Inverse Document Frequency to create sparse
 * 768-dimensional embeddings from text. No API key needed.
 *
 * When to use:
 *   - No external API available
 *   - Privacy-sensitive environments
 *   - Offline/air-gapped systems
 *   - User explicitly sets `projectBrain.embeddings: "tfidf"`
 *
 * Limitations:
 *   - No semantic understanding (bag-of-words)
 *   - Vocabulary must be shared between indexing and query
 *   - Quality degrades with very small corpora
 *
 * @module embedding-tfidf
 */

import type { ChunkWithoutEmbedding } from "./chunker.js";
import type { EmbeddingProvider, EmbeddingResult } from "./embedding-types.js";
import type { DocumentChunk } from "./types.js";

const VOCAB_SIZE = 768;

/**
 * Basic suffix-stripping stemmer for English programming terms.
 * Not a full Porter stemmer, but handles the most common suffixes
 * in technical documentation (e.g., "authentication" → "authent",
 * "configuring" → "configur", "dependencies" → "dependen").
 */
function stem(word: string): string {
  if (word.length < 4) return word;
  return word
    .replace(/ies$/, "i")
    .replace(/tion$/, "t")
    .replace(/sion$/, "s")
    .replace(/ment$/, "")
    .replace(/ness$/, "")
    .replace(/ing$/, "")
    .replace(/ous$/, "")
    .replace(/ble$/, "")
    .replace(/ful$/, "")
    .replace(/ally$/, "")
    .replace(/ize$/, "")
    .replace(/ise$/, "")
    .replace(/ent$/, "")
    .replace(/ant$/, "")
    .replace(/ed$/, "")
    .replace(/er$/, "")
    .replace(/es$/, "")
    .replace(/ly$/, "")
    .replace(/s$/, "");
}

/** Tokenize + stem text into terms */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
    .map(stem);
}

/**
 * Build vocabulary from corpus. Selects the top N most informative terms
 * (appearing in >= 2 docs and <= 80% of docs).
 */
function buildVocabulary(chunks: ChunkWithoutEmbedding[]): string[] {
  const wordCounts = new Map<string, number>();

  for (const chunk of chunks) {
    const words = tokenize(chunk.content);
    const uniqueWords = new Set(words);
    for (const word of uniqueWords) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  const numDocs = chunks.length;
  const minDocs = 2;
  const maxDocs = Math.floor(numDocs * 0.8);

  return Array.from(wordCounts.entries())
    .filter(([, count]) => count >= minDocs && count <= maxDocs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, VOCAB_SIZE)
    .map(([word]) => word);
}

/** Compute TF-IDF vector for a single text against vocabulary */
function computeTfIdf(
  text: string,
  vocabulary: string[],
  idfScores: Map<string, number>,
): number[] {
  const words = tokenize(text);
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }
  const maxCount = Math.max(...Array.from(wordCounts.values()), 1);

  return vocabulary.map((term) => {
    const tf = (wordCounts.get(term) || 0) / maxCount;
    const idf = idfScores.get(term) || 0;
    return tf * idf;
  });
}

/** Compute IDF scores for a corpus + vocabulary */
function computeIdfScores(
  chunks: ChunkWithoutEmbedding[],
  vocabulary: string[],
): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const chunk of chunks) {
    const words = new Set(tokenize(chunk.content));
    for (const word of vocabulary) {
      if (words.has(word)) {
        docFreq.set(word, (docFreq.get(word) || 0) + 1);
      }
    }
  }

  const idfScores = new Map<string, number>();
  for (const [word, freq] of docFreq) {
    idfScores.set(word, Math.log(chunks.length / (freq + 1)) + 1);
  }
  return idfScores;
}

/**
 * TF-IDF embedding provider.
 * Local, deterministic, no external dependencies.
 */
export class TfIdfEmbeddingProvider implements EmbeddingProvider {
  readonly name = "tfidf" as const;

  isAvailable(): boolean {
    return true; // Always available — no external deps
  }

  async generateBatch(
    chunks: ChunkWithoutEmbedding[],
    existingVocabulary?: string[],
  ): Promise<EmbeddingResult> {
    console.log(`  Generating TF-IDF embeddings (${chunks.length} chunks)...`);

    const vocabulary = existingVocabulary || buildVocabulary(chunks);
    const idfScores = computeIdfScores(chunks, vocabulary);

    const result: DocumentChunk[] = chunks.map((chunk) => ({
      ...chunk,
      embedding: computeTfIdf(chunk.content, vocabulary, idfScores),
    }));

    return { chunks: result, vocabulary, embeddingType: "tfidf" };
  }

  async generateQuery(query: string, vocabulary?: string[]): Promise<number[]> {
    if (!vocabulary || vocabulary.length === 0) {
      throw new Error("Vocabulary required for TF-IDF query embedding");
    }

    const words = tokenize(query);
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    // Simple binary presence vector for queries (fast, good enough)
    return vocabulary.map((term) => ((wordCounts.get(term) || 0) > 0 ? 1 : 0));
  }
}
