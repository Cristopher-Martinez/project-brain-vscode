/**
 * Context Enricher — Type definitions
 *
 * Types for the mechanical prompt enrichment system that transforms
 * raw user prompts into context-packed prompts using project memory.
 */

// ─── Intent Detection ──────────────────────────────────────────────────────

export type EnrichAction = "refactor" | "debug" | "implement" | "review" | "explain" | "fix" | "test";

export interface ParsedIntent {
  action: EnrichAction;
  domain: string[];
  entities: string[];
  rawQuery: string;
}

// ─── File References ───────────────────────────────────────────────────────

export interface FileReference {
  path: string;
  lines: number;
  summary: string;
  relevance: number;
  hotspot: boolean;
  relatedLearnings: string[];
}

// ─── Context Blocks ────────────────────────────────────────────────────────

export type ContextBlockType = "learning" | "opinion" | "troubleshooting" | "architecture" | "risk";

export interface ContextBlock {
  type: ContextBlockType;
  title: string;
  content: string;
  confidence: number;
  source: string;
}

// ─── Graph Subset ──────────────────────────────────────────────────────────

export interface ContextGraphNode {
  id: string;
  type: string;
  relevance: number;
}

export interface ContextGraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

export interface ContextGraph {
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
}

// ─── Main Output ───────────────────────────────────────────────────────────

export interface EnrichedPromptPack {
  originalPrompt: string;
  rewrittenPrompt: string;
  intent: ParsedIntent;
  memoryGraph: ContextGraph;
  contextBlocks: ContextBlock[];
  fileMap: FileReference[];
  constraints: string[];
  risks: string[];
  confidence: number;
}

// ─── Enricher Dependencies ─────────────────────────────────────────────────

export interface EnricherDeps {
  searchMemory: (query: string, topK?: number, opts?: { category?: string; topic?: string }) => Promise<string>;
  getWorkspaceRoot: () => string;
  getGraphPath: () => string | null;
  log: (msg: string) => void;
  /** Optional LLM function for context validation (free-tier model) */
  validateContext?: (prompt: string) => Promise<string>;
}

// ─── Enrichment Mode ───────────────────────────────────────────────────────

export type EnrichMode = "off" | "preview" | "auto";

export interface EnrichRequest {
  prompt: string;
  mode: EnrichMode;
  sessionId?: string;
  source: "goal" | "feedback";
}

/** Optional context passed alongside the prompt for richer enrichment */
export interface EnrichContext {
  /** Last LLM synthesis — provides technical context for semantic search */
  lastSynthesis?: string;
  /** Original loop goal — anchors the enrichment to the overarching objective */
  loopGoal?: string;
  /** Session ID — enables progressive context accumulation across rounds */
  sessionId?: string;
}

export interface EnrichResult {
  pack: EnrichedPromptPack;
  formattedMarkdown: string;
  durationMs: number;
}
