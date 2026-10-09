/**
 * Context Enricher — Ranking & Filtering
 *
 * Scores graph nodes and edges by relevance to the user intent.
 * Filters out generic hub nodes and low-confidence connections.
 */

import type { GraphData, GraphEdge, GraphNode } from "./graph-utils";
import type { ContextGraph, ContextGraphEdge, ContextGraphNode, ParsedIntent } from "./context-enricher-types";

// ─── Hub Blacklist ─────────────────────────────────────────────────────────

/** Generic nodes that appear in almost every query — penalized heavily */
const HUB_BLACKLIST = new Set([
  // English generic terms
  "document", "project", "file", "the", "code", "function", "module",
  "data", "type", "class", "method", "value", "name", "path", "error",
  "string", "number", "object", "array", "null", "undefined", "true", "false",
  // Spanish stopwords (common in bilingual codebases)
  "de", "en", "el", "la", "los", "las", "del", "al", "con", "por", "para",
  "que", "una", "uno", "este", "esta", "como", "pero", "más", "todo",
  "ser", "hay", "son", "fue", "sin", "sobre", "entre", "cada", "también",
]);

// ─── Scoring ───────────────────────────────────────────────────────────────

/**
 * Score a graph node based on relevance to the parsed intent.
 */
function scoreNode(node: GraphNode, intent: ParsedIntent): number {
  const id = node.id.toLowerCase();

  // Very short node IDs are almost always noise (stopwords, prepositions)
  if (id.length < 3) return 0.01;

  // Blacklisted hubs get minimal score
  if (HUB_BLACKLIST.has(id)) return 0.05;

  let score = 0;

  // Direct match with domain keywords
  for (const domain of intent.domain) {
    if (id.includes(domain)) {
      score += 0.4;
      break;
    }
  }

  // Direct match with extracted entities (require meaningful overlap)
  for (const entity of intent.entities) {
    const entityLower = entity.toLowerCase();
    // Require exact match or that both id and entity are long enough for substring match
    if (id === entityLower || (id.length >= 4 && entityLower.includes(id)) || id.includes(entityLower)) {
      score += 0.5;
      break;
    }
  }

  // Node type bonus
  if (node.type === "file") score += 0.1;
  if (node.type === "concept") score += 0.05;

  return Math.min(score, 1.0);
}

/**
 * Score an edge by the type of relationship.
 * Stronger relationships get higher scores.
 */
function scoreEdge(edge: GraphEdge): number {
  const typeScores: Record<string, number> = {
    "DEPENDS_ON": 0.9,
    "FIXES": 0.85,
    "MODIFIES": 0.8,
    "IMPLEMENTS": 0.8,
    "IMPORTS": 0.75,
    "MENTIONS": 0.6,
    "TAGGED_AS": 0.5,
    "RELATED_TO": 0.4,
    "CO_OCCURS_WITH": 0.3,
  };
  return typeScores[edge.type] ?? 0.3;
}

// ─── Graph Filtering ───────────────────────────────────────────────────────

interface RankingOptions {
  maxNodes?: number;
  maxEdges?: number;
  minNodeScore?: number;
}

/**
 * Build a scored and filtered subgraph relevant to the intent.
 * Performs BFS from matching seed nodes, scoring as it goes.
 */
export function buildContextGraph(
  fullGraph: GraphData,
  intent: ParsedIntent,
  options: RankingOptions = {},
): ContextGraph {
  const { maxNodes = 20, maxEdges = 30, minNodeScore = 0.15 } = options;

  // Score all nodes
  const scoredNodes: Array<ContextGraphNode & { originalNode: GraphNode }> = [];
  for (const node of fullGraph.nodes) {
    const relevance = scoreNode(node, intent);
    if (relevance >= minNodeScore) {
      scoredNodes.push({ id: node.id, type: node.type, relevance, originalNode: node });
    }
  }

  // Sort by relevance, take top N
  scoredNodes.sort((a, b) => b.relevance - a.relevance);
  const topNodes = scoredNodes.slice(0, maxNodes);
  const nodeIds = new Set(topNodes.map(n => n.id));

  // Filter edges: only those connecting our top nodes
  const scoredEdges: ContextGraphEdge[] = [];
  for (const edge of fullGraph.edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      // Skip invalidated edges
      if (edge.invalidatedAt) continue;
      scoredEdges.push({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        weight: scoreEdge(edge) * (edge.weight ?? 1),
      });
    }
  }

  // Sort edges by weight, take top M
  scoredEdges.sort((a, b) => b.weight - a.weight);

  return {
    nodes: topNodes.map(({ id, type, relevance }) => ({ id, type, relevance })),
    edges: scoredEdges.slice(0, maxEdges),
  };
}

// ─── Risk Detection ────────────────────────────────────────────────────────

/** Known risk patterns per action type */
const RISK_PATTERNS: Record<string, string[]> = {
  refactor: [
    "Files exceeding 400-line limit need extraction",
    "Circular dependency introduction risk",
    "Breaking existing consumers of moved exports",
  ],
  debug: [
    "Async race condition if state is shared",
    "Error swallowing in catch blocks",
  ],
  implement: [
    "New file may conflict with existing module boundaries",
    "Existing patterns must be followed (DI, named exports)",
  ],
  fix: [
    "Regression risk if no test coverage exists",
    "Side effects in callers if signature changes",
  ],
};

/**
 * Detect risks based on intent action and graph shape.
 */
export function detectRisks(intent: ParsedIntent, graph: ContextGraph): string[] {
  const risks: string[] = [];

  // Action-based risks
  const actionRisks = RISK_PATTERNS[intent.action] || [];
  risks.push(...actionRisks.slice(0, 2));

  // Graph-based risks: high-degree nodes = fragile
  const nodeConnections = new Map<string, number>();
  for (const edge of graph.edges) {
    nodeConnections.set(edge.from, (nodeConnections.get(edge.from) || 0) + 1);
    nodeConnections.set(edge.to, (nodeConnections.get(edge.to) || 0) + 1);
  }
  for (const [nodeId, count] of nodeConnections) {
    if (count >= 5) {
      risks.push(`"${nodeId}" is a high-coupling hub (${count} connections) — changes propagate widely`);
    }
  }

  return risks.slice(0, 5);
}

// ─── Dynamic Constraints ───────────────────────────────────────────────────

/**
 * Derive context-specific constraints based on intent, file map, and graph.
 * These complement the static defaults with situation-aware rules.
 */
export function deriveContextualConstraints(
  intent: ParsedIntent,
  fileMap: { path: string; lines: number }[],
  graph: ContextGraph,
): string[] {
  const extra: string[] = [];

  // Action-specific constraints
  if (intent.action === "test") {
    extra.push("Follow existing test patterns in __tests__/ or *.test.ts files");
    extra.push("Use describe/it blocks with descriptive names");
  }
  if (intent.action === "refactor") {
    extra.push("Verify 0 tsc errors before AND after refactoring (npx tsc --noEmit)");
    extra.push("Move one responsibility at a time — atomic commits");
  }
  if (intent.action === "debug") {
    extra.push("Log with context: logError(`[Module] operation: ${error}`)");
    extra.push("Never swallow errors silently");
  }

  // File-based constraints
  const webviewFiles = fileMap.filter(f => f.path.includes("webview") || f.path.endsWith(".tsx"));
  if (webviewFiles.length > 0) {
    extra.push("React functional components only — no class components");
    extra.push("Webview ↔ extension communication via postMessage typed unions");
  }

  const nearLimitFiles = fileMap.filter(f => f.lines > 330);
  for (const f of nearLimitFiles.slice(0, 2)) {
    extra.push(`${f.path} is at ${f.lines} lines — near 400-line limit, consider extracting`);
  }

  const depsFiles = fileMap.filter(f => /Deps/.test(f.path) || intent.entities.some(e => /Deps$/.test(e)));
  if (depsFiles.length > 0) {
    extra.push("Use dependency injection via *Deps interface — never import singletons");
  }

  // Graph-based: if touching high-coupling nodes, warn about interface changes
  const highCouplingNodes = graph.nodes.filter(n => n.relevance > 0.7);
  if (highCouplingNodes.length > 3) {
    extra.push("Multiple highly-connected modules involved — test callers after changes");
  }

  return extra.slice(0, 5);
}
