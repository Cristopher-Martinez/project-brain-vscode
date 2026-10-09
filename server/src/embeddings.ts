/**
 * Embedding Orchestrator — Strategy Pattern registry + public API
 *
 * This file is a thin orchestrator. All provider logic lives in:
 *   embedding-remote.ts — Remote HTTP embedding server provider
 *   embedding-tfidf.ts  — Local TF-IDF fallback
 *   embedding-types.ts  — Interfaces, config, shared utilities
 *
 * Provider resolution order (auto-detect):
 *   1. Remote (if API key / built-in server available)
 *   2. TF-IDF (always available)
 *
 * Backward compatibility:
 *   - `embeddingType === "cloudflare"` or `"openai"` → treated as "remote"
 *   - All original exports preserved for consumers
 *
 * @module embeddings
 */

import type { ChunkWithoutEmbedding } from "./chunker.js";
import { RemoteEmbeddingProvider } from "./embedding-remote.js";
import { TfIdfEmbeddingProvider } from "./embedding-tfidf.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderName,
  EmbeddingResult,
} from "./embedding-types.js";
import { readEmbeddingConfig } from "./embedding-types.js";

// ─── Re-exports for backward compatibility ──────────────────────────────────

export { cosineSimilarity } from "./embedding-types.js";
export type { EmbeddingResult } from "./embedding-types.js";

// ─── Provider registry ──────────────────────────────────────────────────────

/**
 * Create provider instances from current config.
 * Order matters: first available provider wins in auto-detect mode.
 */
function createProviderRegistry(): EmbeddingProvider[] {
  const config = readEmbeddingConfig();
  return [new RemoteEmbeddingProvider(config), new TfIdfEmbeddingProvider()];
}

/** Normalize legacy embedding type names to current provider names */
function normalizeEmbeddingType(type: string): string {
  if (type === "cloudflare" || type === "openai") return "remote";
  return type;
}

/**
 * Resolve which provider to use based on config + availability.
 *
 * Priority:
 *   1. If user forced a provider via EMBEDDING_PROVIDER, use it
 *   2. Auto-detect: first available in registry order
 */
function resolveProvider(registry: EmbeddingProvider[]): EmbeddingProvider {
  const config = readEmbeddingConfig();
  const forced = normalizeEmbeddingType(config.provider) as EmbeddingProviderName;

  if (forced) {
    const provider = registry.find((p) => p.name === forced);
    if (provider?.isAvailable()) {
      return provider;
    }
    console.warn(
      `  EMBEDDING_PROVIDER=${forced} but provider unavailable. Falling back...`,
    );
  }

  // Auto-detect: first available
  for (const provider of registry) {
    if (provider.isAvailable()) {
      return provider;
    }
  }

  // Should never happen (TF-IDF is always available), but just in case
  throw new Error("No embedding provider available");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if remote provider is configured (has API key or built-in) */
export function checkRemoteProvider(): boolean {
  const config = readEmbeddingConfig();
  return !!config.apiKey;
}

/** @deprecated Use checkRemoteProvider() instead */
export const checkOpenAI = checkRemoteProvider;

/**
 * Generate embeddings for document chunks.
 * Auto-selects provider based on config and availability.
 * Pre-checks server health before using remote provider — falls back to TF-IDF if unreachable.
 *
 * Used by: vectorize.ts, watcher.ts
 */
export async function generateEmbeddings(
  chunks: ChunkWithoutEmbedding[],
  existingVocabulary?: string[],
): Promise<EmbeddingResult> {
  const registry = createProviderRegistry();
  let provider = resolveProvider(registry);

  // Health check: if remote is selected, verify server is reachable
  if (provider.name === "remote") {
    const remote = provider as RemoteEmbeddingProvider;
    const healthy = await remote.checkHealth();
    if (!healthy) {
      console.warn("  Embedding server unreachable — falling back to TF-IDF");
      const tfidf = registry.find((p) => p.name === "tfidf");
      if (tfidf) {
        provider = tfidf;
      }
    }
  }

  console.log(`  Using embedding provider: ${provider.name}`);

  const result = await provider.generateBatch(chunks, existingVocabulary);

  // If remote provider fails catastrophically (5 consecutive batch failures),
  // it returns zero-padded results. If ALL chunks are zero-padded, fall back to TF-IDF.
  if (
    provider.name === "remote" &&
    result.chunks.length > 0 &&
    result.chunks.every((c) => c.embedding.every((v) => v === 0))
  ) {
    console.warn(
      "  Remote provider produced all-zero embeddings — falling back to TF-IDF",
    );
    const tfidf = registry.find((p) => p.name === "tfidf");
    if (tfidf) {
      return tfidf.generateBatch(chunks, existingVocabulary);
    }
  }

  return result;
}

/**
 * Generate embedding for a search query.
 * Uses the same provider type that was used during indexing.
 *
 * Used by: search.ts
 */
export async function generateQueryEmbedding(
  query: string,
  vocabulary?: string[],
  embeddingType?: string,
): Promise<number[]> {
  const registry = createProviderRegistry();

  // Normalize legacy types to current provider names
  const resolvedType = normalizeEmbeddingType(embeddingType || "");

  // Match the provider used during indexing
  if (resolvedType === "remote") {
    const remote = registry.find((p) => p.name === "remote") as
      | RemoteEmbeddingProvider
      | undefined;
    if (remote?.isAvailable()) {
      const healthy = await remote.checkHealth();
      if (healthy) {
        try {
          return await remote.generateQuery(query);
        } catch (error) {
          console.warn(
            `  Remote query failed: ${error instanceof Error ? error.message : error}. Falling back to TF-IDF`,
          );
        }
      } else {
        console.warn(
          "  Embedding server unreachable for query — falling back to TF-IDF",
        );
      }
    } else {
      console.warn(
        "  Index was built with remote embeddings but server not available now",
      );
    }
  }

  // TF-IDF query
  const tfidf = registry.find((p) => p.name === "tfidf");
  if (tfidf) {
    return tfidf.generateQuery(query, vocabulary);
  }

  throw new Error("No embedding provider available for query");
}
