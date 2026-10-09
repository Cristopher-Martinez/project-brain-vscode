import { cosineSimilarity, generateQueryEmbedding } from "./embeddings.js";
import type {
  DocumentChunk,
  ProjectIndex,
  SearchOptions,
  SearchResult,
} from "./types.js";

// ─── Confidence Scoring ────────────────────────────────────────────────────

// SYNC: duplicated in src/graph-utils.ts (CJS target) — keep both in sync
export const CONFIDENCE_HIGH = 0.7;
export const CONFIDENCE_MEDIUM = 0.4;

/**
 * Visual confidence indicator for search/graph scores.
 * 🟢 >70% — High confidence, trustworthy result
 * 🟡 40-70% — Medium confidence, may need verification
 * 🔴 <40% — Low confidence, treat with caution
 */
export function getConfidenceEmoji(score: number): string {
  if (!Number.isFinite(score)) return "🔴";
  if (score >= CONFIDENCE_HIGH) return "🟢";
  if (score >= CONFIDENCE_MEDIUM) return "🟡";
  return "🔴";
}

// Query expansion dictionary — broader coverage for common project concepts
const QUERY_EXPANSIONS: Record<string, string[]> = {
  memory: ["memory", "rag", "embedding", "vector", "documentation", "knowledge", "recall"],
  agent: ["agent", "ai", "claude", "copilot", "assistant", "identity", "persona"],
  database: ["database", "db", "prisma", "postgresql", "postgres", "sqlite", "sql", "drizzle"],
  config: ["config", "configuration", "settings", "preferences", "options"],
  auth: ["auth", "authentication", "login", "token", "session", "credentials", "vault"],
  test: ["test", "testing", "jest", "mocha", "vitest", "spec", "assertion", "coverage"],
  deploy: ["deploy", "deployment", "ci", "cd", "pipeline", "build", "release"],
  api: ["api", "endpoint", "route", "rest", "graphql", "handler", "controller"],
  error: ["error", "bug", "fix", "issue", "troubleshooting", "debug", "exception"],
  architecture: ["architecture", "design", "pattern", "structure", "module", "component"],
  search: ["search", "query", "find", "lookup", "semantic", "similarity", "embedding"],
  vectorize: ["vectorize", "vectorization", "embedding", "index", "chunk", "reindex"],
  session: ["session", "handoff", "context", "continuity", "state", "resume"],
  opinion: ["opinion", "preference", "learning", "pattern", "convention", "rule"],
  identity: ["identity", "soul", "persona", "character", "name", "creature", "vibe"],
  cron: ["cron", "schedule", "timer", "job", "task", "reminder", "periodic"],
  cloud: ["cloud", "sync", "backup", "saas", "remote", "server", "upload"],
  swarm: ["swarm", "orchestration", "worker", "parallel", "delegate", "multi-agent"],
  loop: ["loop", "feedback", "iteration", "cycle", "round", "approval"],
  skill: ["skill", "recipe", "template", "howto", "guide", "tutorial"],
};

// Simple cache with TTL
const queryCache = new Map<
  string,
  { results: SearchResult[]; timestamp: number }
>();
const CACHE_TTL = 5 * 60 * 1000;

function normalizeTopicFilter(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getCacheKey(
  query: string,
  projectId: string,
  options: SearchOptions,
): string {
  return `${projectId}:${query}:${options.topK}:${options.minScore}:${options.hybridWeight}:${options.fileFilter || ""}:${options.category || ""}:${options.topic || ""}`;
}

export function expandQuery(query: string): string {
  const terms = query.toLowerCase().split(/\s+/);
  const expanded = new Set(terms);

  for (const term of terms) {
    const expansions = QUERY_EXPANSIONS[term];
    if (expansions) {
      for (const exp of expansions) {
        expanded.add(exp);
      }
    }
  }

  return Array.from(expanded).join(" ");
}

function computeKeywordScore(query: string, chunk: DocumentChunk): number {
  const expandedQuery = expandQuery(query);
  const queryTerms = expandedQuery.split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) return 0;

  const chunkKeywords = new Set(chunk.keywords || []);
  const contentLower = chunk.content.toLowerCase();

  let matches = 0;
  for (const term of queryTerms) {
    if (chunkKeywords.has(term)) {
      matches += 2;
    } else if (contentLower.includes(term)) {
      matches += 1;
    }
  }

  return matches / (queryTerms.length * 2);
}

function rerank(results: SearchResult[], query: string): SearchResult[] {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

  return results
    .map((r) => {
      const contentLower = r.chunk.content.toLowerCase();
      let boost = 0;

      // Exact query match in content
      if (contentLower.includes(queryLower)) boost += 0.15;

      // All query terms present
      const allTermsPresent = queryTerms.every((t) => contentLower.includes(t));
      if (allTermsPresent) boost += 0.1;

      // Section header match
      const section = r.chunk.metadata.section?.toLowerCase() || "";
      if (queryTerms.some((t) => section.includes(t))) boost += 0.05;

      // Title match — strong signal
      const title = r.chunk.metadata.title?.toLowerCase() || "";
      if (queryTerms.some((t) => title.includes(t))) boost += 0.05;

      // Category match — boost if query maps to a known category
      const category = r.chunk.metadata.category || "";
      const categoryMap: Record<string, string[]> = {
        troubleshooting: ["error", "bug", "fix", "issue", "problem"],
        learnings: ["learned", "lesson", "discovery", "root cause"],
        architecture: ["architecture", "design", "pattern", "structure"],
        session: ["session", "handoff", "context"],
        opinions: ["opinion", "preference", "convention"],
      };
      for (const [cat, terms] of Object.entries(categoryMap)) {
        if (category === cat && queryTerms.some((t) => terms.includes(t))) {
          boost += 0.05;
          break;
        }
      }

      // Penalize very short chunks (likely noise)
      if (r.chunk.content.length < 50) boost -= 0.1;

      // Recency boost for session/handoff content
      if (category === "session" && r.chunk.metadata.modifiedAt) {
        const ageHours = (Date.now() - r.chunk.metadata.modifiedAt) / 3_600_000;
        if (ageHours < 24) boost += 0.03;
      }

      return { ...r, score: Math.min(Math.max(r.score + boost, 0), 1.0) };
    })
    .sort((a, b) => b.score - a.score);
}

export async function searchDocuments(
  index: ProjectIndex,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { topK = 5, minScore = 0.1, hybridWeight = 0.7, fileFilter, category, topic } = options;

  const cacheKey = getCacheKey(query, index.projectId, options);
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }

  const expandedQuery = expandQuery(query);
  const queryEmbedding = await generateQueryEmbedding(
    expandedQuery,
    index.vocabulary,
    index.embeddingType,
  );

  let chunks = index.chunks;
  if (fileFilter) {
    const filterLower = fileFilter.toLowerCase();
    chunks = chunks.filter(
      (c) =>
        c.relativePath.toLowerCase().includes(filterLower) ||
        c.filePath.toLowerCase().includes(filterLower),
    );
  }
  if (category) {
    const catLower = category.toLowerCase();
    chunks = chunks.filter((c) => c.metadata.category?.toLowerCase() === catLower);
  }
  if (topic) {
    const normalizedTopic = normalizeTopicFilter(topic);
    chunks = chunks.filter((c) => {
      const chunkTopic = c.metadata.topic?.toLowerCase();
      return chunkTopic ? chunkTopic.includes(normalizedTopic) : false;
    });
  }

  const scoredChunks: Array<{
    chunk: DocumentChunk;
    semanticScore: number;
    keywordScore: number;
    score: number;
  }> = [];

  for (const chunk of chunks) {
    const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
    const keywordScore = computeKeywordScore(query, chunk);
    const score =
      hybridWeight * semanticScore + (1 - hybridWeight) * keywordScore;

    if (score >= minScore) {
      scoredChunks.push({ chunk, semanticScore, keywordScore, score });
    }
  }

  scoredChunks.sort((a, b) => b.score - a.score);
  const candidates = scoredChunks.slice(0, Math.max(topK * 4, 20));

  let results: SearchResult[] = candidates.map(
    ({ chunk, semanticScore, keywordScore, score }) => ({
      chunk,
      score,
      semanticScore,
      keywordScore,
    }),
  );

  results = rerank(results, query).slice(0, topK);

  queryCache.set(cacheKey, { results, timestamp: Date.now() });

  // Periodic cache cleanup
  if (queryCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of queryCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) queryCache.delete(key);
    }
  }

  return results;
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No relevant results found.";
  }

  return results
    .map((r, i) => {
      const meta = r.chunk.metadata;
      const parentContext = meta.parentHeaders?.length
        ? ` (${meta.parentHeaders.join(" > ")})`
        : "";
      const categoryLabel = meta.category ? ` [${meta.category}]` : "";
      const scoreBreakdown =
        r.semanticScore !== undefined
          ? ` [sem:${(r.semanticScore * 100).toFixed(0)}% kw:${((r.keywordScore || 0) * 100).toFixed(0)}%]`
          : "";

      return `---\n## Result ${i + 1}: ${r.chunk.relativePath}${categoryLabel}\nSection: ${meta.section || "(intro)"}${parentContext}\n${getConfidenceEmoji(r.score)} Score: ${(r.score * 100).toFixed(1)}%${scoreBreakdown}\n\n${r.chunk.content}\n`;
    })
    .join("\n");
}

export function clearCache(): void {
  queryCache.clear();
}
