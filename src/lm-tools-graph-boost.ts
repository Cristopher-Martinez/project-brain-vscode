/**
 * Graph-based semantic boost for skill matching.
 *
 * Uses the knowledge graph (BFS proximity) to break ties between
 * keyword-scored skills. When two skills have similar keyword scores,
 * the graph resolves which one is semantically closer to the query
 * via entity relationships (DEPENDS_ON, EXTENDS, RELATED_TO, etc.).
 *
 * Extracted from lm-tools-shared.ts to respect the 400-line limit.
 */

import * as fs from "fs";
import * as path from "path";
import {
  buildWeightedAdjacency,
  findMatchingNodes,
  graphProximity,
  tokenize as graphTokenize,
  parseGraphologyExport,
  type GraphData,
} from "./graph-utils";

// ——— Graph Semantic Boost for Skills ———————————————————————————————

/** Max boost points the graph can add to a skill's keyword score. */
const GRAPH_BOOST_MAX = 3;

/** Minimum boost threshold to apply — prevents micro-noise from flipping rankings */
const GRAPH_BOOST_THRESHOLD = 0.3;

/** Filter graph nodes to exclude source file paths (they're structural, not semantic) */
function filterSemanticNodes(nodeIds: string[]): string[] {
  return nodeIds.filter(
    (id) => !id.includes("/") && !id.includes("\\") && !id.match(/\.\w{2,4}$/),
  );
}

/** Cache: parsed graph + adjacency map, keyed by projectId. Reloaded if file changes. */
let _graphBoostCache: {
  projectId: string;
  mtime: number;
  graph: GraphData;
  adjacency: ReturnType<typeof buildWeightedAdjacency>;
} | null = null;

/**
 * Load graph data (with caching) for semantic boost.
 * Returns null if graph doesn't exist or is empty.
 */
export function loadGraphForBoost(
  homeDir: string,
  projectId: string,
): {
  graph: GraphData;
  adjacency: ReturnType<typeof buildWeightedAdjacency>;
} | null {
  try {
    const graphPath = path.join(
      homeDir,
      ".mcp-rag-docs",
      `${projectId}.graph.json`,
    );
    if (!fs.existsSync(graphPath)) return null;

    const stat = fs.statSync(graphPath);
    const mtime = stat.mtimeMs;

    // Return cached if same project and file hasn't changed
    if (
      _graphBoostCache &&
      _graphBoostCache.projectId === projectId &&
      _graphBoostCache.mtime === mtime
    ) {
      return {
        graph: _graphBoostCache.graph,
        adjacency: _graphBoostCache.adjacency,
      };
    }

    const raw = fs.readFileSync(graphPath, "utf-8");
    const graph = parseGraphologyExport(JSON.parse(raw));

    if (graph.nodes.length === 0) return null;

    const adjacency = buildWeightedAdjacency(graph);
    _graphBoostCache = { projectId, mtime, graph, adjacency };
    return { graph, adjacency };
  } catch {
    return null;
  }
}

export interface ScoredSkill {
  score: number;
  coverage: number;
  graphBoost: number;
  [key: string]: unknown;
}

/**
 * Apply graph-based semantic boost to pre-scored skills.
 *
 * For each skill, finds matching nodes in the knowledge graph for
 * both the query and the skill name/description, then computes
 * BFS proximity. The proximity score (0-1) is scaled to GRAPH_BOOST_MAX
 * and added to the keyword score.
 *
 * This resolves "fragile" matches where keyword scores are close —
 * the graph breaks ties using entity relationships (DEPENDS_ON,
 * EXTENDS, RELATED_TO, etc.).
 */
export function graphBoostSkills<T extends ScoredSkill>(
  scoredSkills: T[],
  query: string,
  homeDir: string,
  projectId: string,
  log?: (msg: string) => void,
): T[] {
  if (scoredSkills.length === 0) return scoredSkills;

  const graphData = loadGraphForBoost(homeDir, projectId);
  if (!graphData) return scoredSkills;

  const { graph, adjacency } = graphData;
  const queryTokens = graphTokenize(query);
  const queryNodes = filterSemanticNodes(findMatchingNodes(graph, queryTokens));

  // No semantic query nodes in graph → can't compute proximity
  if (queryNodes.length === 0) return scoredSkills;

  let boostedCount = 0;
  for (const entry of scoredSkills) {
    // Extract skill name from the entry (works with both matcher shapes)
    const skillName = (entry as Record<string, unknown>).skill
      ? (
          (entry as Record<string, unknown>).skill as {
            manifest: { name: string; description: string };
          }
        ).manifest.name
      : String((entry as Record<string, unknown>).name ?? "");
    const skillDesc = (entry as Record<string, unknown>).skill
      ? (
          (entry as Record<string, unknown>).skill as {
            manifest: { name: string; description: string };
          }
        ).manifest.description
      : "";

    const skillTokens = graphTokenize(`${skillName} ${skillDesc}`);
    const skillNodes = filterSemanticNodes(
      findMatchingNodes(graph, skillTokens),
    );

    if (skillNodes.length === 0) continue;

    const proximity = graphProximity(adjacency, queryNodes, skillNodes, 2);
    const boost = proximity.score * GRAPH_BOOST_MAX;

    // Only apply boost above threshold to avoid micro-noise flipping rankings
    if (boost >= GRAPH_BOOST_THRESHOLD) {
      entry.score += boost;
      entry.graphBoost = boost;
      boostedCount++;
    }
  }

  if (boostedCount > 0 && log) {
    log(
      `[Graph Boost] ${boostedCount} skill(s) boosted via knowledge graph (${queryNodes.length} query nodes)`,
    );
  }

  return scoredSkills;
}
