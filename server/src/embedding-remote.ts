/**
 * Remote Embedding Provider — Connects to any HTTP embedding server
 * (TEI, vLLM, llama.cpp, or any endpoint using the embeddings API format).
 *
 * Configuration via environment variables:
 *   EMBEDDING_API_KEY  — API key (default: "community" for built-in server)
 *   EMBEDDING_MODEL    — Model name (default: BAAI/bge-small-en-v1.5)
 *   EMBEDDING_BASE_URL — Base URL (default: Project Brain TEI server)
 *
 * OpenRouter auto-detection:
 *   If base URL contains "openrouter.ai", model name gets auto-prefixed
 *   with "openai/" for compatibility.
 *
 * @module embedding-remote
 */

import type { ChunkWithoutEmbedding } from "./chunker.js";
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingResult,
} from "./embedding-types.js";
import { sanitizeForEmbedding } from "./embedding-types.js";
import type { DocumentChunk } from "./types.js";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const MAX_CONSECUTIVE_FAILURES = 5;

/** Adaptive batch size based on total chunks — larger projects get bigger batches */
function adaptiveBatchSize(totalChunks: number, baseBatch: number): number {
  if (totalChunks > 3000) return Math.min(baseBatch * 4, 128);
  if (totalChunks > 1500) return Math.min(baseBatch * 2, 64);
  return baseBatch;
}

/** Auto-prefix model name for OpenRouter compatibility */
function resolveModelName(model: string, baseUrl: string): string {
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  if (isOpenRouter && !model.includes("/")) {
    return `openai/${model}`;
  }
  return model;
}

/**
 * Remote embedding provider.
 * Connects to any HTTP embedding server via configurable base URL.
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly name = "remote" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTextLength: number;
  private readonly batchSize: number;
  private readonly resolvedModel: string;
  private healthChecked = false;
  private healthy = true;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.maxTextLength = config.maxTextLength;
    this.batchSize = config.batchSize;
    this.resolvedModel = resolveModelName(this.model, this.baseUrl);
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Check if the embedding server is reachable.
   * TEI exposes /health at the root URL. We derive it from baseUrl.
   * Caches the result to avoid repeated pings within the same session.
   */
  async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.healthy;

    try {
      // baseUrl is like ".../brain-embed/v1" → health is at ".../brain-embed/health"
      const healthUrl = this.baseUrl.replace(/\/v1\/?$/, "/health");
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      this.healthy = response.ok;
    } catch {
      this.healthy = false;
    }

    this.healthChecked = true;
    if (!this.healthy) {
      console.warn(
        "  Embedding server health check failed — server unreachable",
      );
    }
    return this.healthy;
  }

  async generateBatch(
    chunks: ChunkWithoutEmbedding[],
  ): Promise<EmbeddingResult> {
    const result: DocumentChunk[] = [];
    let consecutiveFailures = 0;
    let skippedChunks = 0;
    const effectiveBatch = adaptiveBatchSize(chunks.length, this.batchSize);

    console.log(
      `  Generating embeddings via remote server (${this.resolvedModel}, ${chunks.length} chunks, batch=${effectiveBatch})...`,
    );

    for (let i = 0; i < chunks.length; i += effectiveBatch) {
      const batch = chunks.slice(i, i + effectiveBatch);
      let batchSuccess = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const embeddings = await this.callEmbeddingAPI(
            batch.map((c) => c.content),
          );
          for (let j = 0; j < batch.length; j++) {
            result.push({ ...batch[j], embedding: embeddings[j] });
          }
          batchSuccess = true;
          consecutiveFailures = 0;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(
            `\n  Batch ${Math.floor(i / effectiveBatch) + 1} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg}`,
          );

          if (attempt < MAX_RETRIES - 1) {
            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
            console.log(`  Retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      if (!batchSuccess) {
        consecutiveFailures++;
        skippedChunks += batch.length;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `\n  ${consecutiveFailures} consecutive batch failures — aborting remote provider`,
          );
          // Return what we have + zero-padded remaining
          const dims = result.length > 0 ? result[0].embedding.length : 768;
          for (const chunk of chunks.slice(i)) {
            result.push({ ...chunk, embedding: new Array(dims).fill(0) });
          }
          break;
        }

        // Retry individual items for resilience
        console.log(`  Retrying batch items individually...`);
        for (const chunk of batch) {
          try {
            const [embedding] = await this.callEmbeddingAPI([chunk.content]);
            result.push({ ...chunk, embedding });
          } catch {
            const dims = result.length > 0 ? result[0].embedding.length : 768;
            result.push({ ...chunk, embedding: new Array(dims).fill(0) });
            skippedChunks++;
          }
        }
      }

      const progress = Math.min(i + effectiveBatch, chunks.length);
      process.stdout.write(`\r  Progress: ${progress}/${chunks.length} chunks`);
    }

    if (skippedChunks > 0) {
      console.log(`\n  ⚠ ${skippedChunks} chunks used zero-vector fallback`);
    }
    console.log();
    return { chunks: result, vocabulary: [], embeddingType: "remote" };
  }

  async generateQuery(query: string): Promise<number[]> {
    // BGE models perform significantly better with instruction prefix
    const prefixed = this.isBgeModel()
      ? `Represent this sentence for searching relevant passages: ${query}`
      : query;
    const [embedding] = await this.callEmbeddingAPI([prefixed]);
    return embedding;
  }

  /** Check if the model is a BGE variant (benefits from instruction prefix) */
  private isBgeModel(): boolean {
    return this.model.toLowerCase().includes("bge-");
  }

  /** Prepend BGE instruction prefix for document embeddings */
  private addDocumentPrefix(text: string): string {
    return this.isBgeModel()
      ? `Represent this document for retrieval: ${text}`
      : text;
  }

  /** Call the remote embedding API */
  private async callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.resolvedModel,
        input: texts.map((t) =>
          this.addDocumentPrefix(sanitizeForEmbedding(t).slice(0, this.maxTextLength)),
        ),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Remote embedding failed (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((d) => d.embedding);
  }
}
