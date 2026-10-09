/**
 * Entity Graph — Maps relationships between files, topics, and concepts.
 * Builds a persistent co-occurrence graph from session diary entries:
 *   - Nodes: files and topics (with mention counts + last-seen dates)
 *   - Edges: co-occurrence weight (how often two entities appear together)
 * Updated at session-stop. Queried by context-predictor for richer suggestions.
 * Stored at `.project-brain/memory/sessions/entity-graph.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const GRAPH_FILE = "sessions/entity-graph.json";
const DIARY_FILE = "16_SESSION_DIARY.md";
const MAX_NODES = 200;
const MAX_EDGES = 500;
const DECAY_FACTOR = 0.95; // Per-update weight decay to fade old connections

// ─── Types (via JSDoc) ──────────────────────────────────────────────────────

/**
 * @typedef {{ type: "file"|"topic", mentions: number, lastSeen: string }} GraphNode
 * @typedef {{ from: string, to: string, weight: number }} GraphEdge
 * @typedef {{ nodes: Record<string, GraphNode>, edges: GraphEdge[] }} EntityGraph
 */

// ─── Graph I/O ──────────────────────────────────────────────────────────────

/**
 * Load existing graph or return empty one.
 * @param {string} memoryDir
 * @returns {EntityGraph}
 */
function loadGraph(memoryDir) {
  try {
    const path = join(memoryDir, GRAPH_FILE);
    if (!existsSync(path)) return { nodes: {}, edges: [] };
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { nodes: {}, edges: [] };
  }
}

/**
 * Save graph to disk.
 * @param {string} memoryDir
 * @param {EntityGraph} graph
 */
function saveGraph(memoryDir, graph) {
  const sessDir = join(memoryDir, "sessions");
  if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(memoryDir, GRAPH_FILE),
    JSON.stringify(graph, null, 2),
    "utf8",
  );
}

// ─── Diary Parsing (lightweight, reuses same format as context-predictor) ───

/**
 * @typedef {{ topics: string[], files: string[], date: string }} DiaryEntry
 */

/**
 * Parse diary into entries with topics, files, and date.
 * @param {string} raw
 * @returns {DiaryEntry[]}
 */
function parseDiaryForGraph(raw) {
  const entries = [];
  const blocks = raw.split(/^## /m).filter(Boolean).slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const headerLine = lines[0] || "";

    // Date from header: "2026-02-23 01:52 | branch"
    const dateMatch = headerLine.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch
      ? dateMatch[1]
      : new Date().toISOString().slice(0, 10);

    const topicsLine = lines.find((l) => l.startsWith("**Topics**:"));
    const topics = topicsLine
      ? topicsLine
          .replace("**Topics**:", "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const filesLine = lines.find((l) => l.startsWith("**Files**:"));
    const rawFiles = filesLine
      ? filesLine
          .replace("**Files**:", "")
          .replace(/\(\+\d+ more\)/, "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : [];

    // Normalize file names to basename for cleaner graph
    const files = rawFiles.map((f) => basename(f));

    if (topics.length > 0 || files.length > 0) {
      entries.push({ topics, files, date });
    }
  }

  return entries;
}

// ─── Graph Building ─────────────────────────────────────────────────────────

/**
 * Ensure a node exists in the graph, updating its metadata.
 * @param {EntityGraph} graph
 * @param {string} id
 * @param {"file"|"topic"} type
 * @param {string} date
 */
function touchNode(graph, id, type, date) {
  if (!graph.nodes[id]) {
    graph.nodes[id] = { type, mentions: 0, lastSeen: date };
  }
  graph.nodes[id].mentions++;
  graph.nodes[id].lastSeen = date;
}

/**
 * Add or increment an edge between two entities.
 * @param {EntityGraph} graph
 * @param {string} from
 * @param {string} to
 */
function addEdge(graph, from, to) {
  // Normalize direction (alphabetical) to avoid duplicates
  const [a, b] = from < to ? [from, to] : [to, from];
  const existing = graph.edges.find((e) => e.from === a && e.to === b);
  if (existing) {
    existing.weight++;
  } else {
    graph.edges.push({ from: a, to: b, weight: 1 });
  }
}

/**
 * Apply time decay to all edge weights.
 * @param {EntityGraph} graph
 */
function applyDecay(graph) {
  for (const edge of graph.edges) {
    edge.weight *= DECAY_FACTOR;
  }
  // Prune edges with negligible weight
  graph.edges = graph.edges.filter((e) => e.weight >= 0.1);
}

/**
 * Prune graph if it exceeds size limits.
 * Keeps highest-mention nodes and highest-weight edges.
 * @param {EntityGraph} graph
 */
function pruneGraph(graph) {
  // Prune nodes if over limit
  const nodeKeys = Object.keys(graph.nodes);
  if (nodeKeys.length > MAX_NODES) {
    const sorted = nodeKeys.sort(
      (a, b) => graph.nodes[b].mentions - graph.nodes[a].mentions,
    );
    const keep = new Set(sorted.slice(0, MAX_NODES));
    for (const key of nodeKeys) {
      if (!keep.has(key)) delete graph.nodes[key];
    }
    // Remove edges referencing pruned nodes
    graph.edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  // Prune edges if over limit
  if (graph.edges.length > MAX_EDGES) {
    graph.edges.sort((a, b) => b.weight - a.weight);
    graph.edges = graph.edges.slice(0, MAX_EDGES);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Update the entity graph from session diary data.
 * Called at session-stop to keep the graph fresh.
 * Strategy: Re-processes the diary entries and merges co-occurrences.
 * Uses decay to let old connections fade naturally.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ nodes: number, edges: number }} Stats
 */
export function updateEntityGraph(memoryDir) {
  const diaryPath = join(memoryDir, DIARY_FILE);
  if (!existsSync(diaryPath)) return { nodes: 0, edges: 0 };

  const raw = readFileSync(diaryPath, "utf8");
  const entries = parseDiaryForGraph(raw);
  if (entries.length === 0) return { nodes: 0, edges: 0 };

  const graph = loadGraph(memoryDir);

  // Apply decay before adding new data
  applyDecay(graph);

  // Process each diary entry
  for (const entry of entries) {
    const allEntities = [
      ...entry.topics.map((t) => ({
        id: t,
        type: /** @type {const} */ ("topic"),
      })),
      ...entry.files.map((f) => ({
        id: f,
        type: /** @type {const} */ ("file"),
      })),
    ];

    // Touch all nodes
    for (const entity of allEntities) {
      touchNode(graph, entity.id, entity.type, entry.date);
    }

    // Create edges for all co-occurring pairs
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        addEdge(graph, allEntities[i].id, allEntities[j].id);
      }
    }
  }

  // Prune to stay within limits
  pruneGraph(graph);

  // Save
  saveGraph(memoryDir, graph);

  return { nodes: Object.keys(graph.nodes).length, edges: graph.edges.length };
}

/**
 * Get entities related to the given entity, sorted by edge weight.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @param {string} entity - Entity name (file or topic)
 * @param {number} [limit=5] - Max results
 * @returns {{ id: string, type: string, weight: number }[]}
 */
export function getRelated(memoryDir, entity, limit = 5) {
  const graph = loadGraph(memoryDir);
  const related = [];

  for (const edge of graph.edges) {
    if (edge.from === entity) {
      const node = graph.nodes[edge.to];
      if (node)
        related.push({ id: edge.to, type: node.type, weight: edge.weight });
    } else if (edge.to === entity) {
      const node = graph.nodes[edge.from];
      if (node)
        related.push({ id: edge.from, type: node.type, weight: edge.weight });
    }
  }

  return related.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/**
 * Get the full graph summary (node count, edge count, top entities).
 * @param {string} memoryDir
 * @returns {{ nodes: number, edges: number, topEntities: string[] }}
 */
export function getGraphSummary(memoryDir) {
  const graph = loadGraph(memoryDir);
  const nodeKeys = Object.keys(graph.nodes);
  const top = nodeKeys
    .sort((a, b) => graph.nodes[b].mentions - graph.nodes[a].mentions)
    .slice(0, 10);

  return {
    nodes: nodeKeys.length,
    edges: graph.edges.length,
    topEntities: top,
  };
}
