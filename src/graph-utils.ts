/**
 * Graph data utilities — extracted from lm-tools.ts for testability.
 *
 * These pure functions handle:
 * - Graphology JSON → GraphData transformation
 * - Graph statistics formatting
 * - Query-based graph search
 * - BFS entity traversal
 * - Confidence scoring (visual indicators)
 */

// ─── Confidence Scoring ────────────────────────────────────────────────────

// SYNC: duplicated in server/src/search.ts (ESM target) — keep both in sync
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

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  weight?: number;
  validFrom?: number;
  invalidatedAt?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Graphology Transform ──────────────────────────────────────────────────

/**
 * Transform graphology JSON export into normalized GraphData.
 * Graphology exports: { graphology: { nodes: [{key, attributes}], edges: [{source, target, attributes}] } }
 * We normalize to: { nodes: [{id, type}], edges: [{from, to, type, weight}] }
 */
export function parseGraphologyExport(raw: unknown): GraphData {
  const parsed = raw as Record<string, unknown>;
  const gData = (parsed.graphology || parsed) as Record<string, unknown>;

  const nodes: GraphNode[] = ((gData.nodes as unknown[]) || []).map(
    (n: unknown) => {
      const node = n as {
        key?: string;
        id?: string;
        attributes?: Record<string, unknown>;
      };
      return {
        id: node.key || node.id || "",
        type: (node.attributes?.type as string) || "entity",
        metadata: node.attributes,
      };
    },
  );

  const edges: GraphEdge[] = ((gData.edges as unknown[]) || []).map(
    (e: unknown) => {
      const edge = e as {
        source?: string;
        target?: string;
        from?: string;
        to?: string;
        attributes?: Record<string, unknown>;
      };
      return {
        from: edge.source || edge.from || "",
        to: edge.target || edge.to || "",
        type:
          (edge.attributes?.relationship as string) ||
          (edge as unknown as GraphEdge).type ||
          "RELATED_TO",
        weight: (edge.attributes?.confidence as number) ?? undefined,
        validFrom: (edge.attributes?.validFrom as number) ?? (edge.attributes?.created as number) ?? undefined,
        invalidatedAt: (edge.attributes?.invalidatedAt as number) ?? undefined,
      };
    },
  );

  return { nodes, edges };
}

// ─── Index Parsing ─────────────────────────────────────────────────────────

/**
 * Extract embedding type from index JSON.
 * The field has been called different names across versions.
 */
export function parseEmbeddingType(index: Record<string, unknown>): string {
  return (
    (index.embeddingType as string) ||
    (index.embeddingProvider as string) ||
    ((index.config as Record<string, unknown>)?.embeddingProvider as string) ||
    "unknown"
  );
}

/**
 * Extract graph node/edge counts from raw graph JSON file content.
 */
export function parseGraphCounts(graphJson: Record<string, unknown>): {
  nodes: number;
  edges: number;
} {
  const gData = (graphJson.graphology || graphJson) as Record<string, unknown>;
  return {
    nodes: (gData.nodes as unknown[])?.length ?? 0,
    edges: (gData.edges as unknown[])?.length ?? 0,
  };
}

// ─── Score Extraction ──────────────────────────────────────────────────────

/**
 * Extract the highest confidence score from formatted search results.
 *
 * CONTRACT: Parses the format produced by `server/src/search.ts` → `formatSearchResults()`.
 * Expected format: "Score: 85.3%" or "🟢 Score: 85.3%" (with optional confidence emoji prefix).
 * If the format in `formatSearchResults()` changes, this regex MUST be updated.
 *
 * @returns Best score as 0-1 float. Returns 0 if no scores found (triggers fallback).
 */
export function extractBestScore(output: string): number {
  const scoreRegex = /Score:\s*([\d.]+)%/g;
  let best = 0;
  let match: RegExpExecArray | null;
  while ((match = scoreRegex.exec(output)) !== null) {
    const score = parseFloat(match[1]) / 100;
    if (Number.isFinite(score) && score > best) best = score;
  }
  return best;
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatGraphStats(graph: GraphData): string {
  const nodesByType: Record<string, number> = {};
  for (const node of graph.nodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }
  return [
    `## Knowledge Graph Statistics`,
    ``,
    `**Total Nodes:** ${graph.nodes.length}`,
    `**Total Edges:** ${graph.edges.length}`,
    ``,
    `### Nodes by Type`,
    ...Object.entries(nodesByType)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `- ${type}: ${count}`),
    ``,
    `### Edges by Type`,
    ...Object.entries(edgesByType)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `- ${type}: ${count}`),
  ].join("\n");
}

export function formatQueryResults(graph: GraphData, query: string): string {
  const q = query.toLowerCase();
  const matchingNodes = graph.nodes.filter(
    (n) => n.id.toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
  );
  const matchingEdges = graph.edges.filter(
    (e) =>
      e.from.toLowerCase().includes(q) ||
      e.to.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q),
  );

  const lines = [
    `## Graph Query: "${query}"`,
    ``,
    `**Matching Nodes:** ${matchingNodes.length}`,
  ];
  for (const node of matchingNodes.slice(0, 20)) {
    lines.push(`- [${node.type}] ${node.id}`);
  }
  if (matchingNodes.length > 20) {
    lines.push(`  ... and ${matchingNodes.length - 20} more`);
  }
  lines.push(``, `**Matching Edges:** ${matchingEdges.length}`);
  for (const edge of matchingEdges.slice(0, 20)) {
    lines.push(
      `- ${edge.from} —[${edge.type}]→ ${edge.to}${edge.weight != null ? ` ${getConfidenceEmoji(edge.weight)} (w: ${edge.weight.toFixed(2)})` : ""}`,
    );
  }
  if (matchingEdges.length > 20) {
    lines.push(`  ... and ${matchingEdges.length - 20} more`);
  }
  return lines.join("\n");
}

export function formatEntityBFS(
  graph: GraphData,
  query: string,
  maxDepth: number,
): string {
  const q = query.toLowerCase();
  const startNodes = graph.nodes.filter((n) => n.id.toLowerCase().includes(q));

  if (startNodes.length === 0) {
    return `No entity found matching "${query}". Try mode "query" for broader search.`;
  }

  const adjacency = new Map<
    string,
    Array<{ target: string; type: string; weight?: number }>
  >();
  for (const edge of graph.edges) {
    if (edge.invalidatedAt) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency
      .get(edge.from)!
      .push({ target: edge.to, type: edge.type, weight: edge.weight });
    adjacency
      .get(edge.to)!
      .push({ target: edge.from, type: edge.type, weight: edge.weight });
  }

  const visited = new Set<string>();
  const results: Array<{ node: string; depth: number; via: string }> = [];
  const queue: Array<{ node: string; depth: number; via: string }> = [];

  for (const start of startNodes.slice(0, 3)) {
    queue.push({ node: start.id, depth: 0, via: "(root)" });
  }

  while (queue.length > 0) {
    const { node, depth, via } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    results.push({ node, depth, via });

    if (depth < maxDepth) {
      const neighbors = adjacency.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.target)) {
          queue.push({
            node: neighbor.target,
            depth: depth + 1,
            via: `${neighbor.type}${neighbor.weight != null ? ` ${getConfidenceEmoji(neighbor.weight)} (${neighbor.weight.toFixed(2)})` : ""}`,
          });
        }
      }
    }
  }

  const lines = [
    `## Entity Relations: "${query}"`,
    ``,
    `**Start nodes:** ${startNodes
      .slice(0, 3)
      .map((n) => n.id)
      .join(", ")}`,
    `**Depth:** ${maxDepth}`,
    `**Nodes reached:** ${results.length}`,
    ``,
  ];

  for (const r of results) {
    const indent = "  ".repeat(r.depth);
    const icon = r.depth === 0 ? "🔷" : "→";
    lines.push(
      `${indent}${icon} ${r.node} ${r.depth > 0 ? `[via: ${r.via}]` : ""}`,
    );
  }

  return lines.join("\n");
}

// ─── Strategy Ranking ──────────────────────────────────────────────────────

export interface StrategyDefinition {
  name: string;
  description: string;
  tags: string[];
}

export interface RankedStrategy {
  strategy: StrategyDefinition;
  score: number;
  keywordScore: number;
  graphScore: number;
  matchedKeywords: string[];
  graphPaths: number;
}

/** Nodos genéricos que generan ruido en BFS — excluidos del ranking.
 *  Sincronizado con SERVER_BLACKLISTED_NODES en server/src/graph.ts */
const BLACKLISTED_NODES = new Set([
  "document",
  "project",
  "topic",
  "agent",
  "process",
  "entry",
  "change",
  "solution",
  "unknown_source",
]);

/** Pesos por tipo de edge para modular la señal del grafo. */
const EDGE_TYPE_WEIGHTS: Record<string, number> = {
  DEPENDS_ON: 1.0,
  EXTENDS: 1.0,
  DEFINED_IN: 0.8,
  LINKS_TO: 0.7,
  REFERENCES: 0.7,
  RELATED_TO: 0.5,
  TAGGED_AS: 0.5,
  CO_OCCURS_WITH: 0.3,
  DESCRIBED_AS: 0.1,
  MENTIONS: 0.1,
};

/** Stopwords bilingüe (ES/EN) — mínimo viable. */
const STOPWORDS = new Set([
  // EN
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "about",
  "as",
  "into",
  "through",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  // ES
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "en",
  "con",
  "por",
  "para",
  "al",
  "que",
  "es",
  "son",
  "ser",
  "estar",
  "como",
  "más",
  "pero",
  "sin",
  "sobre",
  "entre",
  "hasta",
  "desde",
  "este",
  "esta",
  "estos",
  "estas",
  "ese",
  "esa",
  "esos",
  "esas",
  "lo",
  "le",
  "se",
  "su",
  "sus",
  "nos",
  "les",
]);

/** Tokenize text into normalized, meaningful keywords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s-]/g, " ")
    .split(/[\s\-_,]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Compute keyword overlap score between task and strategy tokens. */
function keywordOverlap(
  taskTokens: string[],
  strategyTokens: string[],
): { score: number; matched: string[] } {
  if (taskTokens.length === 0 || strategyTokens.length === 0) {
    return { score: 0, matched: [] };
  }
  const strategySet = new Set(strategyTokens);
  const taskSet = new Set(taskTokens);
  const matched = [...taskSet].filter((t) => strategySet.has(t));
  // Overlap Coefficient: matched / min(|query|, |strategy|)
  // No penaliza estrategias ricas — si todos los tokens del query matchean, score = 1.0
  const minSize = Math.min(taskSet.size, strategySet.size);
  return { score: matched.length / minSize, matched };
}

/** Find graph nodes matching any of the given tokens. */
export function findMatchingNodes(
  graph: GraphData,
  tokens: string[],
): string[] {
  const matches: string[] = [];
  for (const node of graph.nodes) {
    if (BLACKLISTED_NODES.has(node.id.toLowerCase())) continue;
    const nodeId = node.id.toLowerCase();
    for (const token of tokens) {
      if (nodeId.includes(token) || token.includes(nodeId)) {
        matches.push(node.id);
        break;
      }
    }
  }
  return matches;
}

/** Build adjacency map from graph data (reusable across strategies). */
export function buildWeightedAdjacency(
  graph: GraphData,
): Map<string, Array<{ target: string; weight: number }>> {
  const adj = new Map<string, Array<{ target: string; weight: number }>>();
  for (const edge of graph.edges) {
    const edgeWeight = EDGE_TYPE_WEIGHTS[edge.type] ?? 0.5;
    const confidence = edge.weight ?? 1.0;
    const w = edgeWeight * confidence;

    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push({ target: edge.to, weight: w });
    adj.get(edge.to)!.push({ target: edge.from, weight: w });
  }
  return adj;
}

/** Compute graph proximity score between task nodes and strategy nodes via BFS. */
export function graphProximity(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  taskNodes: string[],
  strategyNodes: string[],
  maxDepth: number,
): { score: number; pathCount: number } {
  if (taskNodes.length === 0 || strategyNodes.length === 0) {
    return { score: 0, pathCount: 0 };
  }

  const strategySet = new Set(strategyNodes.map((n) => n.toLowerCase()));
  let totalWeight = 0;
  let pathCount = 0;

  for (const startNode of taskNodes) {
    const visited = new Set<string>();
    const queue: Array<{ node: string; depth: number; accWeight: number }> = [
      { node: startNode, depth: 0, accWeight: 1.0 },
    ];

    while (queue.length > 0) {
      const { node, depth, accWeight } = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);

      if (depth > 0 && strategySet.has(node.toLowerCase())) {
        // Penalize by depth: closer = stronger signal
        const depthPenalty = 1.0 / (depth + 1);
        totalWeight += accWeight * depthPenalty;
        pathCount++;
      }

      if (depth < maxDepth) {
        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
          if (
            !visited.has(neighbor.target) &&
            !BLACKLISTED_NODES.has(neighbor.target.toLowerCase())
          ) {
            queue.push({
              node: neighbor.target,
              depth: depth + 1,
              accWeight: accWeight * neighbor.weight,
            });
          }
        }
      }
    }
  }

  // Normalize score to 0-1 (cap at reasonable maximum)
  const maxExpected = taskNodes.length * strategyNodes.length;
  const score = maxExpected > 0 ? Math.min(totalWeight / maxExpected, 1.0) : 0;
  return { score, pathCount };
}

/**
 * Rank strategies by relevance to a task description using hybrid scoring.
 * Combines keyword overlap (50%) + knowledge graph proximity (50%).
 * Falls back to keyword-only when graph is null or empty.
 */
export function rankStrategies(
  taskDescription: string,
  strategies: StrategyDefinition[],
  graph: GraphData | null,
  options?: {
    keywordWeight?: number;
    graphWeight?: number;
    maxBfsDepth?: number;
    minScore?: number;
  },
): RankedStrategy[] {
  const kw = options?.keywordWeight ?? 0.5;
  const gw =
    graph && graph.nodes.length > 0 ? (options?.graphWeight ?? 0.5) : 0;
  const effectiveKw = gw === 0 ? 1.0 : kw;
  const maxBfsDepth = options?.maxBfsDepth ?? 3;
  const minScore = options?.minScore ?? 0;

  const taskTokens = tokenize(taskDescription);

  // Build graph structures once (reuse for all strategies)
  const adjacency =
    graph && graph.nodes.length > 0 ? buildWeightedAdjacency(graph) : null;
  const taskNodes =
    graph && adjacency ? findMatchingNodes(graph, taskTokens) : [];

  const results: RankedStrategy[] = strategies.map((strategy) => {
    // Keyword scoring
    const strategyTokens = [
      ...tokenize(strategy.name),
      ...tokenize(strategy.description),
      ...strategy.tags.flatMap((t) => tokenize(t)),
    ];
    const { score: kwScore, matched } = keywordOverlap(
      taskTokens,
      strategyTokens,
    );

    // Graph scoring (skip if no graph)
    let gScore = 0;
    let paths = 0;
    if (adjacency && taskNodes.length > 0) {
      const strategyNodeMatches = findMatchingNodes(graph!, [
        ...tokenize(strategy.name),
        ...strategy.tags.flatMap((t) => tokenize(t)),
      ]);
      const result = graphProximity(
        adjacency,
        taskNodes,
        strategyNodeMatches,
        maxBfsDepth,
      );
      gScore = result.score;
      paths = result.pathCount;
    }

    const finalScore = kwScore * effectiveKw + gScore * gw;

    return {
      strategy,
      score: finalScore,
      keywordScore: kwScore,
      graphScore: gScore,
      matchedKeywords: matched,
      graphPaths: paths,
    };
  });

  return results
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
