/**
 * Embedding Provider Types — Strategy Pattern interfaces
 *
 * Architecture:
 *   embedding-types.ts  ← Interfaces (this file)
 *   embedding-remote.ts ← Remote HTTP embedding server provider
 *   embedding-tfidf.ts  ← TF-IDF local provider
 *   embeddings.ts       ← Orchestrator (registry + public API)
 *
 * Adding a new provider:
 *   1. Create `embedding-{name}.ts` implementing `EmbeddingProvider`
 *   2. Register it in `embeddings.ts` → `createProviderRegistry()`
 *   3. Add the provider name to `EmbeddingProviderName` union
 *   4. Add VS Code setting value to `projectBrain.embeddings` enum in package.json
 *
 * @module embedding-types
 */

import type { ChunkWithoutEmbedding } from "./chunker.js";
import type { DocumentChunk } from "./types.js";

// ─── Provider names ──────────────────────────────────────────────────────────

/** All registered embedding provider identifiers */
export type EmbeddingProviderName = "remote" | "tfidf";

// ─── Provider interface ──────────────────────────────────────────────────────

/** Result from batch embedding generation */
export interface EmbeddingResult {
  chunks: DocumentChunk[];
  vocabulary: string[];
  embeddingType: EmbeddingProviderName;
}

/**
 * Strategy interface for embedding providers.
 *
 * Each provider must:
 * - Report its name and availability
 * - Generate embeddings for document chunks (batch)
 * - Generate a single query embedding (for search)
 */
export interface EmbeddingProvider {
  /** Unique provider identifier (matches EmbeddingProviderName) */
  readonly name: EmbeddingProviderName;

  /**
   * Check if this provider is available (e.g., API key present).
   * Called during auto-detect to determine provider priority.
   */
  isAvailable(): boolean;

  /**
   * Generate embeddings for a batch of document chunks.
   * @param chunks - Document chunks without embeddings
   * @param existingVocabulary - Reuse existing vocabulary (TF-IDF only)
   */
  generateBatch(
    chunks: ChunkWithoutEmbedding[],
    existingVocabulary?: string[],
  ): Promise<EmbeddingResult>;

  /**
   * Generate embedding for a single search query.
   * @param query - Search query text
   * @param vocabulary - Vocabulary for TF-IDF providers
   */
  generateQuery(query: string, vocabulary?: string[]): Promise<number[]>;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Embedding configuration from environment variables */
export interface EmbeddingConfig {
  /** Forced provider ("remote"|"tfidf") or "" for auto-detect */
  provider: string;
  /** API key for embedding server */
  apiKey: string;
  /** Model name for embedding API */
  model: string;
  /** Base URL for embedding API */
  baseUrl: string;
  /** Max text length per chunk (tokens vary by model) */
  maxTextLength: number;
  /** Batch size for API calls */
  batchSize: number;
}

/**
 * Read embedding configuration from environment variables.
 * Environment variables are set by:
 * - VS Code extension via `getEmbeddingEnvVars()` in mcp-manager.ts
 * - `.vscode/mcp.json` env block for MCP stdio server
 * - Direct env vars for CLI usage
 */
/** Built-in Project Brain embedding gateway (SaaS, OpenAI-compatible → TEI on VPS) */
const BUILT_IN_BASE_URL = "https://api.projectbrain.tech/api/v1";
const BUILT_IN_MODEL = "BAAI/bge-small-en-v1.5";
const BUILT_IN_KEY = "community";

export function readEmbeddingConfig(): EmbeddingConfig {
  return {
    provider: process.env.EMBEDDING_PROVIDER || "",
    apiKey: process.env.EMBEDDING_API_KEY || BUILT_IN_KEY,
    model: process.env.EMBEDDING_MODEL || BUILT_IN_MODEL,
    baseUrl: process.env.EMBEDDING_BASE_URL || BUILT_IN_BASE_URL,
    maxTextLength: 2048,
    batchSize: 32,
  };
}

// ─── Shared utilities ────────────────────────────────────────────────────────

const EMPTY_PLACEHOLDER = "empty document";

/**
 * Sanitize text for embedding providers.
 * Strips null bytes, control characters, and lone surrogate pairs
 * (which break JSON serialization for strict parsers like Rust/TEI).
 * Replaces empty/whitespace-only strings with a placeholder.
 */
export function sanitizeForEmbedding(text: string): string {
  const cleaned = text
    // Strip control characters (except \t, \n, \r which are valid in JSON)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Strip lone surrogates that break JSON.stringify for strict parsers
    // High surrogate not followed by low surrogate, or lone low surrogate
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "",
    )
    .trim();
  return cleaned.length === 0 ? EMPTY_PLACEHOLDER : cleaned;
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
