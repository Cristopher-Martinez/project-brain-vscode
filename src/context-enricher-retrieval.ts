/**
 * Context Enricher — Retrieval layer
 *
 * Multi-signal retrieval: memory search, knowledge graph, opinions, learnings.
 * Pure data fetching — no scoring or ranking logic here.
 */

import * as fs from "fs";
import * as path from "path";
import { parseGraphologyExport, type GraphData } from "./graph-utils";
import type { ContextBlock, EnricherDeps, ParsedIntent } from "./context-enricher-types";

// ─── Intent Parsing ────────────────────────────────────────────────────────

const ACTION_PATTERNS: Array<{ pattern: RegExp; action: ParsedIntent["action"] }> = [
  { pattern: /refactori[zs]|reestructur|extraer|split|separar/i, action: "refactor" },
  { pattern: /debug|depurar|investigar.*error|por.*qu[eé].*falla/i, action: "debug" },
  { pattern: /implement|crear|a[gñ]adir|nuevo|nueva|agregar/i, action: "implement" },
  { pattern: /review|revis[ae]|audit|validar/i, action: "review" },
  { pattern: /explic|c[oó]mo.*funciona|qu[eé].*hace|entender/i, action: "explain" },
  { pattern: /fix|arregla|corregir|solucionar|reparar/i, action: "fix" },
  { pattern: /test|prueba|cobertura|spec/i, action: "test" },
];

/**
 * Parse user prompt into structured intent using regex patterns.
 * No LLM needed — fast, deterministic extraction.
 */
export function parseIntent(prompt: string): ParsedIntent {
  let action: ParsedIntent["action"] = "implement";
  for (const { pattern, action: act } of ACTION_PATTERNS) {
    if (pattern.test(prompt)) {
      action = act;
      break;
    }
  }

  // Extract domain keywords (2+ char words, exclude stopwords)
  const stopwords = new Set([
    "the", "los", "las", "del", "que", "con", "para", "por", "una", "uno",
    "este", "esta", "como", "pero", "más", "todo", "todos", "toda", "todas",
    "hay", "ser", "hacer", "quiero", "necesito", "puede", "debe",
  ]);
  const words = prompt.toLowerCase().match(/[a-záéíóúñü]{3,}/g) || [];
  const domain = [...new Set(words.filter(w => !stopwords.has(w)))].slice(0, 8);

  // Extract potential entity names (PascalCase, kebab-case, or quoted)
  const entities: string[] = [];
  const pascalMatches = prompt.match(/[A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]+)+/g) || [];
  const kebabMatches = prompt.match(/[a-z]+-[a-z]+(?:-[a-z]+)*/g) || [];
  const quotedMatches = prompt.match(/[`"']([^`"']+)[`"']/g) || [];
  entities.push(
    ...pascalMatches,
    ...kebabMatches,
    ...quotedMatches.map(q => q.slice(1, -1)),
  );

  return { action, domain, entities: [...new Set(entities)].slice(0, 10), rawQuery: prompt };
}

// ─── Memory Search ─────────────────────────────────────────────────────────

interface MemorySearchResult {
  learnings: ContextBlock[];
  troubleshooting: ContextBlock[];
  opinions: ContextBlock[];
}

/**
 * Search memory across multiple categories relevant to the intent.
 */
export async function searchMemoryMulti(
  intent: ParsedIntent,
  deps: EnricherDeps,
): Promise<MemorySearchResult> {
  const queryTerms = [...intent.domain, ...intent.entities].slice(0, 5).join(" ");
  const result: MemorySearchResult = { learnings: [], troubleshooting: [], opinions: [] };

  // Parallel searches across categories
  const [learningsRaw, troubleshootingRaw, opinionsRaw] = await Promise.all([
    deps.searchMemory(queryTerms, 5, { category: "learnings" }).catch(() => ""),
    deps.searchMemory(queryTerms, 3, { category: "troubleshooting" }).catch(() => ""),
    deps.searchMemory(queryTerms, 3, { category: "opinions" }).catch(() => ""),
  ]);

  result.learnings = parseSearchResults(learningsRaw, "learning");
  result.troubleshooting = parseSearchResults(troubleshootingRaw, "troubleshooting");
  result.opinions = parseSearchResults(opinionsRaw, "opinion");

  return result;
}

/**
 * Parse raw search output into structured ContextBlocks.
 */
function parseSearchResults(raw: string, type: ContextBlock["type"]): ContextBlock[] {
  if (!raw || raw === "No results found.") return [];

  const blocks: ContextBlock[] = [];
  // Split by result separators (the CLI uses --- or numbered results)
  const sections = raw.split(/(?:^|\n)(?:---+|\d+\.\s)/m).filter(s => s.trim());

  for (const section of sections.slice(0, 5)) {
    const lines = section.trim().split("\n");
    const title = lines[0]?.replace(/^#+\s*/, "").trim() || "Untitled";
    const content = lines.slice(1).join("\n").trim();

    // Extract score if present
    const scoreMatch = section.match(/Score:\s*([\d.]+)%/);
    const confidence = scoreMatch ? parseFloat(scoreMatch[1]) / 100 : 0.5;

    blocks.push({ type, title, content: content.slice(0, 500), confidence, source: "memory" });
  }

  // Filter out low-confidence results (likely noise)
  return blocks.filter(b => b.confidence >= 0.4);
}

// ─── Knowledge Graph ───────────────────────────────────────────────────────

/**
 * Load and filter knowledge graph for entities related to the intent.
 */
export function loadGraphSubset(intent: ParsedIntent, deps: EnricherDeps): GraphData | null {
  const graphPath = deps.getGraphPath();
  if (!graphPath || !fs.existsSync(graphPath)) return null;

  try {
    const raw = fs.readFileSync(graphPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parseGraphologyExport(parsed);
  } catch {
    deps.log("[ContextEnricher] Failed to load graph");
    return null;
  }
}

// ─── Opinion Bank (file-based) ─────────────────────────────────────────────

/**
 * Read opinions directly from 14_OPINIONS.md for domain-related entries.
 */
export function readRelevantOpinions(
  intent: ParsedIntent,
  workspaceRoot: string,
): ContextBlock[] {
  const opinionsPath = path.join(workspaceRoot, ".project-brain", "memory", "14_OPINIONS.md");
  if (!fs.existsSync(opinionsPath)) return [];

  try {
    const content = fs.readFileSync(opinionsPath, "utf-8");
    const blocks: ContextBlock[] = [];
    const queryLower = intent.domain.join(" ").toLowerCase();

    // Parse opinion entries: ## Title\n**Category**: ...\n**Confidence**: ...\n...
    const entries = content.split(/(?=^## )/m);
    for (const entry of entries) {
      if (!entry.trim()) continue;
      const titleMatch = entry.match(/^## (.+)/m);
      if (!titleMatch) continue;

      const title = titleMatch[1].trim();
      const confMatch = entry.match(/confidence[:\s]*([\d.]+)/i);
      const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

      // Check relevance by keyword overlap
      const entryLower = entry.toLowerCase();
      const isRelevant = intent.domain.some(d => entryLower.includes(d)) ||
        intent.entities.some(e => entryLower.includes(e.toLowerCase()));

      if (isRelevant) {
        blocks.push({
          type: "opinion",
          title,
          content: entry.slice(0, 300),
          confidence,
          source: "14_OPINIONS.md",
        });
      }
    }

    return blocks.slice(0, 5);
  } catch {
    return [];
  }
}

// ─── Synthesis Signal Extraction ───────────────────────────────────────────

export interface SynthesisSignals {
  filePaths: string[];
  codeEntities: string[];
  decisions: string[];
}

/**
 * Extract high-quality signals from an LLM synthesis.
 * Returns only structured data (file paths, code entities, decisions)
 * instead of dumping raw prose into the search query.
 */
export function extractSynthesisSignals(synthesis: string): SynthesisSignals {
  const filePaths: string[] = [];
  const codeEntities: string[] = [];
  const decisions: string[] = [];

  // 1. File paths (src/foo/bar.ts, ./context-enricher.ts, etc.)
  const fileMatches = synthesis.match(/(?:src\/|\.\/)?[\w/-]+\.(?:ts|tsx|js|jsx|mjs|json|md)\b/g) || [];
  filePaths.push(...new Set(fileMatches));

  // 2. Inline code mentions (backtick-wrapped)
  const inlineCode = synthesis.match(/`([^`]{2,60})`/g) || [];
  for (const ic of inlineCode) {
    const inner = ic.slice(1, -1);
    // Only keep identifiers, not sentences
    if (/^[\w.()[\]<>]+$/.test(inner) && !inner.includes(" ")) {
      codeEntities.push(inner);
    }
  }

  // 3. PascalCase and camelCase identifiers
  const identifiers = synthesis.match(/\b[A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]+)+\b/g) || [];
  codeEntities.push(...identifiers);

  // 4. Decision patterns (Spanish + English)
  const decisionPatterns = /(?:decidí|cambié|extraje|moví|creé|agregué|eliminé|refactoricé|implementé|I (?:moved|extracted|created|changed|added|removed|refactored|implemented))\s+(.{10,100}?)(?:\.|$)/gim;
  let match;
  while ((match = decisionPatterns.exec(synthesis)) !== null) {
    decisions.push(match[0].trim());
  }

  return {
    filePaths: [...new Set(filePaths)].slice(0, 10),
    codeEntities: [...new Set(codeEntities)].slice(0, 15),
    decisions: decisions.slice(0, 5),
  };
}
