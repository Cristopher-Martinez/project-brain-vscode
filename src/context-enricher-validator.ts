/**
 * Context Enricher — LLM Validator
 *
 * Uses a free-tier LLM to validate enriched context blocks for relevance.
 * Filters out blocks that the LLM identifies as unrelated to the user's intent,
 * reducing noise in the final enriched prompt.
 */

import type { ContextBlock, EnrichedPromptPack, FileReference, ParsedIntent } from "./context-enricher-types";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Function signature for the LLM validation call */
export type ValidateContextFn = (
  prompt: string,
) => Promise<string>;

export interface ValidationResult {
  /** Blocks that passed validation (relevant to intent) */
  validBlocks: ContextBlock[];
  /** Blocks that were filtered out */
  filteredOut: ContextBlock[];
  /** Files that passed validation */
  validFiles: FileReference[];
  /** Files that were filtered out */
  filteredFiles: FileReference[];
  /** Graph node indices that passed validation (if graph was included) */
  keepNodeIndices: number[] | null;
  /** LLM reasoning summary */
  reasoning: string;
  /** Whether validation ran successfully */
  success: boolean;
}

// ─── Prompt Construction ───────────────────────────────────────────────────

function buildValidationPrompt(
  intent: ParsedIntent,
  blocks: ContextBlock[],
  files: FileReference[],
  graphNodes?: { id: string; type: string; relevance: number }[],
): string {
  const blockList = blocks
    .map((b, i) => `[${i}] type=${b.type} title="${b.title}" confidence=${b.confidence.toFixed(2)} source="${b.source}"`)
    .join("\n");

  const fileList = files
    .map((f, i) => `[${i}] path="${f.path}" relevance=${f.relevance.toFixed(2)} hotspot=${f.hotspot}`)
    .join("\n");

  const nodeList = graphNodes
    ? graphNodes.map((n, i) => `[${i}] id="${n.id}" type=${n.type} relevance=${n.relevance.toFixed(2)}`).join("\n")
    : "";

  const graphSection = nodeList
    ? `\nGRAPH NODES (from knowledge graph):\n${nodeList}\n`
    : "";

  const graphJsonField = nodeList ? `\n  "keepNodes": [0, 1, 3],` : "";
  const graphRule = nodeList
    ? "\n- Filter graph nodes that are natural-language stopwords, prepositions, or articles in ANY language (e.g. 'de', 'the', 'en', 'el')\n- Keep only nodes that represent meaningful code entities, concepts, or file references"
    : "";

  return `You are a context relevance validator for a code enrichment system.

USER INTENT:
- Action: ${intent.action}
- Domains: ${intent.domain.join(", ")}
- Entities: ${intent.entities.join(", ")}
- Query: "${intent.rawQuery}"

CONTEXT BLOCKS (retrieved from project memory):
${blockList || "(none)"}

FILE REFERENCES (resolved from project):
${fileList || "(none)"}${graphSection}
TASK: Evaluate each item for relevance to the user's intent.

Output a JSON object with this exact structure:
{
  "keepBlocks": [0, 2, 3],
  "keepFiles": [0, 1],${graphJsonField}
  "reasoning": "Brief explanation of what was filtered and why"
}

Rules:
- Keep blocks directly relevant to the action, domains, or entities
- Filter blocks about unrelated features, modules, or concerns
- Keep files that the user is likely working on or that relate to their intent
- Filter files with no clear connection to the intent${graphRule}
- When in doubt, KEEP the item (false negatives are worse than false positives)
- Use the indices from the lists above
- ONLY output the JSON, nothing else`;
}

// ─── Validation Logic ──────────────────────────────────────────────────────

/**
 * Validate enriched context using an LLM to filter irrelevant blocks.
 * Falls back gracefully if LLM call fails (returns original pack unchanged).
 */
export async function validateEnrichedContext(
  pack: EnrichedPromptPack,
  validateFn: ValidateContextFn,
  logFn: (msg: string) => void,
): Promise<ValidationResult> {
  const { intent, contextBlocks, fileMap, memoryGraph } = pack;
  const graphNodes = memoryGraph.nodes.length > 0 ? memoryGraph.nodes : undefined;

  // Skip validation if there's very little context (nothing to filter)
  if (contextBlocks.length <= 2 && fileMap.length <= 2 && !graphNodes) {
    return {
      validBlocks: contextBlocks,
      filteredOut: [],
      validFiles: fileMap,
      filteredFiles: [],
      keepNodeIndices: null,
      reasoning: "Skipped — too few items to validate",
      success: true,
    };
  }

  const prompt = buildValidationPrompt(intent, contextBlocks, fileMap, graphNodes);

  try {
    const raw = await validateFn(prompt);
    const totalNodes = graphNodes?.length ?? 0;
    const parsed = parseValidationResponse(raw, contextBlocks.length, fileMap.length, totalNodes);

    const validBlocks = parsed.keepBlocks
      .filter(i => i >= 0 && i < contextBlocks.length)
      .map(i => contextBlocks[i]);
    const filteredOut = contextBlocks.filter((_, i) => !parsed.keepBlocks.includes(i));

    const validFiles = parsed.keepFiles
      .filter(i => i >= 0 && i < fileMap.length)
      .map(i => fileMap[i]);
    const filteredFiles = fileMap.filter((_, i) => !parsed.keepFiles.includes(i));

    const keepNodeIndices = totalNodes > 0 ? parsed.keepNodes : null;

    logFn(`[Validator] Kept ${validBlocks.length}/${contextBlocks.length} blocks, ${validFiles.length}/${fileMap.length} files${keepNodeIndices ? `, ${keepNodeIndices.length}/${totalNodes} nodes` : ""}`);
    if (filteredOut.length > 0) {
      logFn(`[Validator] Filtered: ${filteredOut.map(b => b.title).join(", ")}`);
    }

    return {
      validBlocks,
      filteredOut,
      validFiles,
      filteredFiles,
      keepNodeIndices,
      reasoning: parsed.reasoning,
      success: true,
    };
  } catch (err) {
    logFn(`[Validator] LLM validation failed, keeping all: ${err instanceof Error ? err.message : String(err)}`);
    return {
      validBlocks: contextBlocks,
      filteredOut: [],
      validFiles: fileMap,
      filteredFiles: [],
      keepNodeIndices: null,
      reasoning: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    };
  }
}

// ─── Response Parsing ──────────────────────────────────────────────────────

interface ParsedValidation {
  keepBlocks: number[];
  keepFiles: number[];
  keepNodes: number[];
  reasoning: string;
}

function parseValidationResponse(
  raw: string,
  totalBlocks: number,
  totalFiles: number,
  totalNodes: number,
): ParsedValidation {
  const allIndices = (n: number) => Array.from({ length: n }, (_, i) => i);
  // Extract JSON from response (LLM might wrap it in markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      keepBlocks: allIndices(totalBlocks),
      keepFiles: allIndices(totalFiles),
      keepNodes: allIndices(totalNodes),
      reasoning: "Could not parse LLM response — keeping all",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const filterNums = (arr: unknown) => Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === "number") : null;
    return {
      keepBlocks: filterNums(parsed.keepBlocks) ?? allIndices(totalBlocks),
      keepFiles: filterNums(parsed.keepFiles) ?? allIndices(totalFiles),
      keepNodes: filterNums(parsed.keepNodes) ?? allIndices(totalNodes),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    return {
      keepBlocks: allIndices(totalBlocks),
      keepFiles: allIndices(totalFiles),
      keepNodes: allIndices(totalNodes),
      reasoning: "JSON parse error — keeping all",
    };
  }
}
