/**
 * GraphMemory  Graphology-powered relationship graph
 * Inspired by mem0's graph_memory.ts/kuzu_memory.py
 *
 * Uses Graphology (pure JS, 2.7MB, 650K+ weekly downloads, MIT)
 * instead of Neo4j (Java server) or Kuzu (deprecated C++ embedded).
 *
 * Key features stolen from mem0:
 * - Entity nodes with metadata (mentions, created, type)
 * - CONNECTED_TO relationships with confidence scores
 * - Fuzzy entity matching for deduplication
 * - BFS traversal for deep context
 * - JSON persistence via graph.export()/import()
 * - Conflict resolution: add  search  delete contradictions  add
 */

import { MultiDirectedGraph } from "graphology";
import { bfsFromNode } from "graphology-traversal";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Types

export interface Relation {
  id: string;
  source: string;
  relationship: string;
  target: string;
  sourceFile: string;
  confidence: number;
  extractedFrom: string;
  timestamp: number;
  validFrom?: number;
  invalidatedAt?: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  relationshipTypes: Record<string, number>;
  topEntities: Array<{ name: string; connections: number }>;
  lastUpdated: number;
}

// Storage path

const DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".mcp-rag-docs",
);

// GraphMemory class

export class GraphMemory {
  private graph: MultiDirectedGraph;
  private projectId: string;
  private lastUpdated: number = 0;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.graph = new MultiDirectedGraph({ allowSelfLoops: false });
  }

  // -- Node management --

  private ensureNode(
    name: string,
    attrs: Record<string, unknown> = {},
  ): string {
    const key = this.normalizeKey(name);
    if (this.graph.hasNode(key)) {
      const existing = this.graph.getNodeAttributes(key);
      this.graph.mergeNodeAttributes(key, {
        mentions: ((existing.mentions as number) || 1) + 1,
        ...attrs,
      });
    } else {
      this.graph.addNode(key, {
        label: name,
        mentions: 1,
        created: Date.now(),
        ...attrs,
      });
    }
    return key;
  }

  private normalizeKey(name: string): string {
    return name.toLowerCase().replace(/\s+/g, "_").replace(/['"`]/g, "");
  }

  // -- Relation management --

  addRelation(rel: Relation): void {
    const srcKey = this.ensureNode(rel.source, { type: "entity" });
    const tgtKey = this.ensureNode(rel.target, { type: "entity" });

    if (srcKey === tgtKey) return;

    const edgeKey =
      srcKey + "__" + rel.relationship.toLowerCase() + "__" + tgtKey;

    if (this.graph.hasEdge(edgeKey)) {
      const existing = this.graph.getEdgeAttributes(edgeKey);
      this.graph.mergeEdgeAttributes(edgeKey, {
        mentions: ((existing.mentions as number) || 1) + 1,
        confidence: Math.max(
          (existing.confidence as number) || 0,
          rel.confidence,
        ),
      });
    } else {
      this.graph.addEdgeWithKey(edgeKey, srcKey, tgtKey, {
        relationship: rel.relationship,
        sourceFile: rel.sourceFile,
        confidence: rel.confidence,
        extractedFrom: rel.extractedFrom,
        mentions: 1,
        created: rel.timestamp,
      });
    }
  }

  // -- Conflict Resolution (mem0-style: add -> search -> delete -> add) --

  addWithConflictResolution(rel: Relation): {
    added: Relation[];
    deleted: Relation[];
  } {
    const srcKey = this.normalizeKey(rel.source);
    const relLower = rel.relationship.toLowerCase();
    const deleted: Relation[] = [];

    if (this.graph.hasNode(srcKey)) {
      const edgesToRemove: string[] = [];

      this.graph.forEachOutEdge(srcKey, (edge, attrs, _source, target) => {
        const existingRel = (
          (attrs.relationship as string) || ""
        ).toLowerCase();
        if (existingRel === relLower) {
          const newTgtKey = this.normalizeKey(rel.target);
          if (target !== newTgtKey) {
            const existingConfidence = (attrs.confidence as number) || 0.5;
            const existingMentions = (attrs.mentions as number) || 1;
            if (
              rel.confidence > existingConfidence ||
              (rel.confidence >= existingConfidence && existingMentions <= 1)
            ) {
              edgesToRemove.push(edge);
              deleted.push(this.edgeToRelation(edge, attrs, srcKey, target));
            }
          }
        }
      });

      for (const edge of edgesToRemove) {
        try {
          this.graph.setEdgeAttribute(edge, "invalidatedAt", Date.now());
        } catch {
          /* edge already gone */
        }
      }
    }

    this.addRelation(rel);
    return { added: [rel], deleted };
  }

  addBatchWithConflictResolution(relations: Relation[]): {
    added: number;
    deleted: number;
    conflicts: number;
  } {
    let added = 0;
    let deletedCount = 0;
    let conflicts = 0;

    for (const rel of relations) {
      const result = this.addWithConflictResolution(rel);
      added += result.added.length;
      deletedCount += result.deleted.length;
      if (result.deleted.length > 0) conflicts++;
    }

    return { added, deleted: deletedCount, conflicts };
  }

  removeRelationsFromFile(sourceFile: string): number {
    const edgesToRemove: string[] = [];

    this.graph.forEachEdge((edge, attrs) => {
      if ((attrs.sourceFile as string) === sourceFile) {
        edgesToRemove.push(edge);
      }
    });

    for (const edge of edgesToRemove) {
      try {
        this.graph.dropEdge(edge);
      } catch {
        /* ignore */
      }
    }

    const orphanNodes: string[] = [];
    this.graph.forEachNode((node) => {
      if (this.graph.degree(node) === 0) {
        orphanNodes.push(node);
      }
    });

    for (const node of orphanNodes) {
      try {
        this.graph.dropNode(node);
      } catch {
        /* ignore */
      }
    }

    return edgesToRemove.length;
  }

  // Blacklisted hub nodes: skip during BFS expansion (except starting node)
  private static readonly SERVER_BLACKLISTED_NODES = new Set([
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

  // Edge type weights for confidence-weighted BFS filtering
  private static readonly SERVER_EDGE_TYPE_WEIGHTS: Record<string, number> = {
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

  private static readonly BFS_CONFIDENCE_THRESHOLD = 0.3;

  // -- Search: BFS traversal from entity --

  searchRelated(entity: string, depth: number = 2): Relation[] {
    const node = this.findBestMatch(entity);
    if (!node) return [];

    // Attempt 1: BFS with confidence filter
    const filtered = this._bfsCollect(node, depth, true);
    if (filtered.length > 0) return filtered;

    // Fallback: unfiltered BFS (for sparse graphs)
    return this._bfsCollect(node, depth, false);
  }

  private _bfsCollect(
    startNode: string,
    depth: number,
    applyConfidenceFilter: boolean,
  ): Relation[] {
    const relations: Relation[] = [];
    const seenEdges = new Set<string>();

    bfsFromNode(
      this.graph,
      startNode,
      (n: string, _attrs: unknown, d: number) => {
        if (d > depth) return true;
        if (d > 0 && GraphMemory.SERVER_BLACKLISTED_NODES.has(n)) return true;

        this.graph.forEachOutEdge(n, (edge, edgeAttrs, source, target) => {
          if (seenEdges.has(edge)) return;
          if (edgeAttrs.invalidatedAt) return;

          if (applyConfidenceFilter) {
            const relType = (edgeAttrs.relationship as string) || "";
            const baseConf = (edgeAttrs.confidence as number) || 0.5;
            const typeWeight =
              GraphMemory.SERVER_EDGE_TYPE_WEIGHTS[relType] ?? 0.5;
            const effectiveConf = baseConf * typeWeight;
            if (effectiveConf < GraphMemory.BFS_CONFIDENCE_THRESHOLD) return;
          }

          seenEdges.add(edge);
          relations.push(this.edgeToRelation(edge, edgeAttrs, source, target));
        });

        if (d === 0) {
          this.graph.forEachInEdge(n, (edge, edgeAttrs, source, target) => {
            if (seenEdges.has(edge)) return;
            if (edgeAttrs.invalidatedAt) return;

            if (applyConfidenceFilter) {
              const relType = (edgeAttrs.relationship as string) || "";
              const baseConf = (edgeAttrs.confidence as number) || 0.5;
              const typeWeight =
                GraphMemory.SERVER_EDGE_TYPE_WEIGHTS[relType] ?? 0.5;
              const effectiveConf = baseConf * typeWeight;
              if (effectiveConf < GraphMemory.BFS_CONFIDENCE_THRESHOLD) return;
            }

            seenEdges.add(edge);
            relations.push(
              this.edgeToRelation(edge, edgeAttrs, source, target),
            );
          });
        }

        return false;
      },
    );

    return relations;
  }

  // -- Search: keyword matching --

  searchByQuery(query: string, limit: number = 10): Relation[] {
    const terms = query
      .toLowerCase()
      .split(/[\s\-_\/\.]+/)
      .filter((t) => t.length > 1);

    const scored: Array<{ relation: Relation; score: number }> = [];

    this.graph.forEachEdge((edge, attrs, source, target) => {
      const srcLabel =
        (this.graph.getNodeAttribute(source, "label") as string) || source;
      const tgtLabel =
        (this.graph.getNodeAttribute(target, "label") as string) || target;
      const relName = (attrs.relationship as string) || "";
      let score = 0;

      for (const term of terms) {
        if (source === term || target === term) score += 5;
        if (srcLabel.toLowerCase().includes(term)) score += 3;
        if (tgtLabel.toLowerCase().includes(term)) score += 3;
        if (relName.toLowerCase().includes(term)) score += 1;
      }

      score *= (attrs.confidence as number) || 0.5;
      if (score > 0) {
        scored.push({
          relation: this.edgeToRelation(edge, attrs, source, target),
          score,
        });
      }
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.relation);
  }

  // -- Entity context --

  getEntityContext(entity: string): {
    incoming: Relation[];
    outgoing: Relation[];
    mentions: number;
  } {
    const node = this.findBestMatch(entity);
    if (!node) return { incoming: [], outgoing: [], mentions: 0 };

    const incoming: Relation[] = [];
    const outgoing: Relation[] = [];

    this.graph.forEachInEdge(node, (edge, attrs, source, target) => {
      incoming.push(this.edgeToRelation(edge, attrs, source, target));
    });

    this.graph.forEachOutEdge(node, (edge, attrs, source, target) => {
      outgoing.push(this.edgeToRelation(edge, attrs, source, target));
    });

    const mentions =
      (this.graph.getNodeAttribute(node, "mentions") as number) || 0;

    return { incoming, outgoing, mentions };
  }

  // -- Getters --

  getAll(): Relation[] {
    const relations: Relation[] = [];
    this.graph.forEachEdge((edge, attrs, source, target) => {
      relations.push(this.edgeToRelation(edge, attrs, source, target));
    });
    return relations;
  }

  getStats(): GraphStats {
    const relationshipTypes: Record<string, number> = {};
    const nodeConnections: Array<{ name: string; connections: number }> = [];

    this.graph.forEachEdge((_edge, attrs) => {
      const rel = (attrs.relationship as string) || "UNKNOWN";
      relationshipTypes[rel] = (relationshipTypes[rel] || 0) + 1;
    });

    this.graph.forEachNode((node, attrs) => {
      nodeConnections.push({
        name: (attrs.label as string) || node,
        connections: this.graph.degree(node),
      });
    });

    nodeConnections.sort((a, b) => b.connections - a.connections);

    return {
      nodes: this.graph.order,
      edges: this.graph.size,
      relationshipTypes,
      topEntities: nodeConnections.slice(0, 10),
      lastUpdated: this.lastUpdated,
    };
  }

  // -- Persistence --

  save(): void {
    const graphPath = join(DATA_DIR, this.projectId + ".graph.json");
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const serialized = this.graph.export();
    this.lastUpdated = Date.now();
    const payload = JSON.stringify(
      {
        projectId: this.projectId,
        lastUpdated: this.lastUpdated,
        graphology: serialized,
      },
      null,
      2,
    );
    const tmp = graphPath + ".tmp";
    writeFileSync(tmp, payload);
    renameSync(tmp, graphPath);
  }

  load(): boolean {
    const graphPath = join(DATA_DIR, this.projectId + ".graph.json");
    if (!existsSync(graphPath)) return false;
    try {
      const data = JSON.parse(readFileSync(graphPath, "utf-8"));
      if (data.graphology) {
        this.graph = MultiDirectedGraph.from(data.graphology);
        this.lastUpdated = data.lastUpdated || 0;
      }
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.graph.clear();
  }

  // -- Helpers --

  private edgeToRelation(
    edge: string,
    attrs: Record<string, unknown>,
    source: string,
    target: string,
  ): Relation {
    return {
      id: edge,
      source:
        (this.graph.getNodeAttribute(source, "label") as string) || source,
      relationship: (attrs.relationship as string) || "RELATED_TO",
      target:
        (this.graph.getNodeAttribute(target, "label") as string) || target,
      sourceFile: (attrs.sourceFile as string) || "",
      confidence: (attrs.confidence as number) || 0.5,
      extractedFrom: (attrs.extractedFrom as string) || "",
      timestamp: (attrs.created as number) || Date.now(),
      validFrom: (attrs.validFrom as number) || (attrs.created as number) || undefined,
      invalidatedAt: (attrs.invalidatedAt as number) || undefined,
    };
  }

  private findBestMatch(entity: string): string | null {
    const key = this.normalizeKey(entity);
    if (this.graph.hasNode(key)) return key;

    let bestMatch: string | null = null;
    let bestScore = 0;

    // Pass 1: substring matching (fast, existing behavior)
    this.graph.forEachNode((node) => {
      let score = 0;
      if (node.includes(key)) {
        score = key.length / node.length;
      } else if (key.includes(node)) {
        score = node.length / key.length;
      }

      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = node;
      }
    });

    if (bestMatch) return bestMatch;

    // Pass 2: Levenshtein fuzzy matching (only for strings >= 3 chars)
    if (key.length >= 3) {
      this.graph.forEachNode((node) => {
        if (node.length < 3) return;
        const similarity = normalizedLevenshtein(key, node);
        if (similarity > bestScore && similarity >= 0.6) {
          bestScore = similarity;
          bestMatch = node;
        }
      });
    }

    return bestMatch;
  }
}

// -- Levenshtein distance for fuzzy matching --

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[m][n];
}

function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// Relation extraction patterns

interface ExtractionPattern {
  regex: RegExp;
  relationship: string;
  confidence: number;
  extract: (m: RegExpExecArray) => { source: string; target: string } | null;
}

const PATTERNS: ExtractionPattern[] = [
  {
    regex:
      /`([\w\-\.\/]+\.(?:ts|js|json))`\s*(?:\||->|=>|imports?|uses?|calls?|requires?)\s*`([\w\-\.\/]+\.(?:ts|js|json))`/g,
    relationship: "DEPENDS_ON",
    confidence: 0.95,
    extract: (m) => ({ source: m[1], target: m[2] }),
  },
  {
    regex: /\[([^\]]{2,60})\]\(([^)]+\.(?:ts|js|md|json))\)/g,
    relationship: "LINKS_TO",
    confidence: 0.8,
    extract: (m) => ({ source: m[1], target: m[2] }),
  },
  {
    regex:
      /[`"]?([\w\-\.\/]+)[`"]?\s+(?:depends on|uses|requires|imports?|calls?|invokes?|wraps?)\s+[`"]?([\w\-\.\/]+)[`"]?/gi,
    relationship: "DEPENDS_ON",
    confidence: 0.8,
    extract: (m) => {
      if (m[1].length < 2 || m[2].length < 2) return null;
      return { source: m[1], target: m[2] };
    },
  },
  {
    regex: /\b([\w]+)\s+(?:extends|implements)\s+([\w]+)/g,
    relationship: "EXTENDS",
    confidence: 0.9,
    extract: (m) => ({ source: m[1], target: m[2] }),
  },
  {
    regex: /\|\s*`?([\w\-\.\/]+\.(?:ts|js|mjs))`?\s*\|\s*([^|]{5,80})\s*\|/g,
    relationship: "DESCRIBED_AS",
    confidence: 0.65,
    extract: (m) => ({ source: m[1], target: m[2].trim() }),
  },
  {
    regex: /\b((?:src|server|dist|scripts)\/[\w\-\/]+\.(?:ts|js|mjs))\b/g,
    relationship: "MENTIONS",
    confidence: 0.5,
    extract: (m) => ({ source: "document", target: m[1] }),
  },
  {
    regex: /"([@\w\-\/]+)"\s*:\s*"[\^~]?[\d\.]+"/g,
    relationship: "DEPENDS_ON",
    confidence: 0.9,
    extract: (m) => ({ source: "project", target: m[1] }),
  },
  {
    regex:
      /(?:creates?|generates?|produces?|outputs?|emits?)\s+[`"]?([\w\-\.\/]+(?:\.(?:ts|js|md|json))?)[`"]?/gi,
    relationship: "PRODUCES",
    confidence: 0.7,
    extract: (m) => {
      if (m[1].length < 3) return null;
      return { source: "process", target: m[1] };
    },
  },
  // Documentation-specific patterns (for memory files)
  {
    regex:
      /\*\*(?:Related|See also|See)\*\*:\s*(?:-\s*)?\[?([^\]\n]{3,50})\]?/gi,
    relationship: "RELATED_TO",
    confidence: 0.85,
    extract: (m) => ({ source: "topic", target: m[1].trim() }),
  },
  {
    regex: /\*\*Tags?\*\*:\s*([\w\-]+(?:,\s*[\w\-]+)*)/gi,
    relationship: "TAGGED_AS",
    confidence: 0.7,
    extract: (m) => {
      if (!m[1] || m[1].trim().length < 3) return null;
      return { source: "entry", target: m[1].trim() };
    },
  },
  {
    regex: /\*\*Category\*\*:\s*(\w+)/gi,
    relationship: "CATEGORIZED_AS",
    confidence: 0.9,
    extract: (m) => ({ source: "entry", target: m[1] }),
  },
  {
    regex: /\[([^\]]{3,50})\]\((?:\.\.\/)?([^\)]+\.md)(?:#[^\)]+)?\)/g,
    relationship: "REFERENCES",
    confidence: 0.9,
    extract: (m) => ({ source: m[1], target: m[2] }),
  },
  {
    regex: /(?:Modified|Updated|Changed):\s*(?:-\s*)?`([^`]{3,60})`/gi,
    relationship: "MODIFIES",
    confidence: 0.8,
    extract: (m) => ({ source: "change", target: m[1] }),
  },
  {
    regex: /(?:Fixed|Resolved|Solved):\s*(?:-\s*)?([^\n]{5,60})/gi,
    relationship: "FIXES",
    confidence: 0.75,
    extract: (m) => ({ source: "solution", target: m[1].trim() }),
  },
  // Co-occurrence: two backticked entities on the same line → likely related
  {
    regex:
      /`([\w\-\.\/]+\.(?:ts|js|mjs))`[^`\n]{1,40}`([\w\-\.\/]+\.(?:ts|js|mjs))`/g,
    relationship: "CO_OCCURS_WITH",
    confidence: 0.6,
    extract: (m) => {
      if (m[1] === m[2]) return null;
      return { source: m[1], target: m[2] };
    },
  },
  // Function/class defined in file: "functionName (file.ts:123)" or "functionName in file.ts"
  {
    regex:
      /`?([\w]+(?:\.[\w]+)?(?:\(\))?)`?\s+(?:in|from|at|→)\s+`?([\w\-\.\/]+\.(?:ts|js|mjs))`?/gi,
    relationship: "DEFINED_IN",
    confidence: 0.75,
    extract: (m) => {
      if (m[1].length < 3 || m[2].length < 4) return null;
      return { source: m[1], target: m[2] };
    },
  },
  // Status markers: "✅ feature/file" or "🔴 issue"
  {
    regex:
      /[✅✓]\s+(?:`?)([\w\-\.\/]+(?:\.(?:ts|js|md))?|\w[\w\s]{2,40}?)(?:`?)\s*(?:—|[-–])/g,
    relationship: "COMPLETED",
    confidence: 0.7,
    extract: (m) => {
      const target = m[1].trim();
      if (target.length < 3) return null;
      return { source: "milestone", target };
    },
  },
  // Soul/personality patterns (for 09_AGENT_SOUL.md)
  {
    regex: /\*\*Tone\*\*:\s*(.{5,80})/gi,
    relationship: "HAS_TONE",
    confidence: 0.9,
    extract: (m) => ({ source: "agent", target: m[1].trim() }),
  },
  {
    regex: /## Lore[\s\S]*?(?=\n## |$)/gi,
    relationship: "HAS_BACKSTORY",
    confidence: 0.8,
    extract: (m) => {
      const items = m[0].split("\n").filter((l) => l.trim().startsWith("-"));
      if (items.length === 0) return null;
      return {
        source: "agent",
        target: items[0].replace(/^[-\s*]+/, "").trim(),
      };
    },
  },
  {
    regex: /## Topics[\s\S]*?- ([^\n]{3,60})/gi,
    relationship: "KNOWS_ABOUT",
    confidence: 0.85,
    extract: (m) => ({ source: "agent", target: m[1].trim() }),
  },
  {
    regex: /agent:\s*"([^"]{10,120})"/gi,
    relationship: "SPEAKS_LIKE",
    confidence: 0.75,
    extract: (m) => ({
      source: "agent",
      target: m[1].trim().slice(0, 60),
    }),
  },
];

function generateRelationId(
  source: string,
  rel: string,
  target: string,
): string {
  return createHash("md5")
    .update(source.toLowerCase() + ":" + rel + ":" + target.toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

// Extraction functions

// Generic source names that create supernode hubs — rewrite to sourceFile
const GENERIC_SOURCES = new Set([
  "document",
  "project",
  "process",
  "entry",
  "topic",
  "change",
  "solution",
]);

export function extractRelationsFromContent(
  content: string,
  sourceFile: string,
): Relation[] {
  const relations: Relation[] = [];
  const seen = new Set<string>();

  for (const { regex, relationship, confidence, extract } of PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const result = extract(match);
      if (!result) continue;

      const { source: rawSource, target } = result;
      if (rawSource === target) continue;
      if (rawSource.length < 2 || target.length < 2) continue;

      // Source-rewrite: replace generic supernode sources with actual sourceFile
      const effectiveSource = GENERIC_SOURCES.has(rawSource.toLowerCase())
        ? sourceFile || "unknown_source"
        : rawSource;

      // Multitag support: split TAGGED_AS targets by comma into N relations
      if (relationship === "TAGGED_AS" && target.includes(",")) {
        const tags = target
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length >= 3);
        for (const tag of tags) {
          const tagKey =
            effectiveSource.toLowerCase() +
            ":" +
            relationship +
            ":" +
            tag.toLowerCase();
          if (seen.has(tagKey)) continue;
          seen.add(tagKey);
          relations.push({
            id: generateRelationId(effectiveSource, relationship, tag),
            source: effectiveSource.trim(),
            relationship,
            target: tag,
            sourceFile,
            confidence,
            extractedFrom: match[0].slice(0, 120),
            timestamp: Date.now(),
          });
        }
        continue;
      }

      const key =
        effectiveSource.toLowerCase() +
        ":" +
        relationship +
        ":" +
        target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      relations.push({
        id: generateRelationId(effectiveSource, relationship, target),
        source: effectiveSource.trim(),
        relationship,
        target: target.trim(),
        sourceFile,
        confidence,
        extractedFrom: match[0].slice(0, 120),
        timestamp: Date.now(),
      });
    }
  }

  return relations;
}

export function extractHeaderHierarchy(
  content: string,
  sourceFile: string,
): Relation[] {
  const relations: Relation[] = [];
  const lines = content.split("\n");
  const stack: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;

    const level = m[1].length;
    const header = m[2].trim();

    while (stack.length >= level) stack.pop();

    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      relations.push({
        id: generateRelationId(parent, "CONTAINS", header),
        source: parent,
        relationship: "CONTAINS",
        target: header,
        sourceFile,
        confidence: 1.0,
        extractedFrom: line.trim(),
        timestamp: Date.now(),
      });
    }

    stack.push(header);
  }

  return relations;
}

// Graph building pipeline

export function buildGraphFromChunks(
  projectId: string,
  chunks: Array<{ content: string; filePath: string; relativePath: string }>,
): GraphMemory {
  const gm = new GraphMemory(projectId);

  let totalConflicts = 0;
  let totalDeleted = 0;

  for (const chunk of chunks) {
    const contentRels = extractRelationsFromContent(
      chunk.content,
      chunk.relativePath,
    );
    const headerRels = extractHeaderHierarchy(
      chunk.content,
      chunk.relativePath,
    );
    const allRels = [...contentRels, ...headerRels];

    const result = gm.addBatchWithConflictResolution(allRels);
    totalConflicts += result.conflicts;
    totalDeleted += result.deleted;
  }

  gm.save();
  const stats = gm.getStats();
  const conflictInfo =
    totalConflicts > 0
      ? " (" +
        totalConflicts +
        " conflicts resolved, " +
        totalDeleted +
        " old relations replaced)"
      : "";
  console.log(
    "Graph built: " +
      stats.nodes +
      " nodes, " +
      stats.edges +
      " edges, " +
      Object.keys(stats.relationshipTypes).length +
      " relationship types" +
      conflictInfo,
  );

  return gm;
}

export function loadOrBuildGraph(
  projectId: string,
  chunks?: Array<{ content: string; filePath: string; relativePath: string }>,
): GraphMemory {
  const gm = new GraphMemory(projectId);
  if (gm.load()) return gm;
  if (chunks) return buildGraphFromChunks(projectId, chunks);
  return gm;
}

// Formatting

export function formatRelations(relations: Relation[]): string {
  if (relations.length === 0) return "No relationships found.";

  const groups = new Map<string, Relation[]>();
  for (const rel of relations) {
    if (!groups.has(rel.relationship)) groups.set(rel.relationship, []);
    groups.get(rel.relationship)!.push(rel);
  }

  const lines: string[] = [];
  for (const [relType, rels] of groups) {
    lines.push("\n### " + relType);
    for (const r of rels) {
      const temporal = r.invalidatedAt ? " ⚠️ _invalidated_" : "";
      lines.push(
        "- **" +
          r.source +
          "** -> **" +
          r.target +
          "** _(" +
          r.sourceFile +
          ", " +
          (r.confidence * 100).toFixed(0) +
          "%)_" +
          temporal,
      );
    }
  }

  return lines.join("\n");
}

export function formatGraphStats(stats: GraphStats): string {
  const lines = [
    "**Graph Statistics:**",
    "- Nodes: " + stats.nodes,
    "- Edges: " + stats.edges,
    "- Last Updated: " +
      (stats.lastUpdated ? new Date(stats.lastUpdated).toISOString() : "Never"),
    "",
    "**Relationship Types:**",
  ];

  for (const [type, count] of Object.entries(stats.relationshipTypes)) {
    lines.push("- " + type + ": " + count);
  }

  if (stats.topEntities.length > 0) {
    lines.push("", "**Most Connected Entities:**");
    for (const e of stats.topEntities) {
      lines.push("- " + e.name + " (" + e.connections + " connections)");
    }
  }

  return lines.join("\n");
}
