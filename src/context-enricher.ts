/**
 * Context Enricher — Main Orchestrator
 *
 * Coordinates the enrichment pipeline:
 * 1. Parse intent from raw prompt
 * 2. Retrieve memory (search + graph + opinions)
 * 3. Resolve relevant files
 * 4. Rank and filter
 * 5. Format output
 */

import type { EnrichedPromptPack, EnrichContext, EnricherDeps, EnrichResult, ParsedIntent } from "./context-enricher-types";
import { linkLearningsToFiles, resolveRelevantFiles } from "./context-enricher-files";
import { buildRewrittenPrompt, formatPreviewMarkdown } from "./context-enricher-format";
import { buildContextGraph, deriveContextualConstraints, detectRisks } from "./context-enricher-ranking";
import { extractSynthesisSignals, loadGraphSubset, parseIntent, readRelevantOpinions, searchMemoryMulti } from "./context-enricher-retrieval";
import { getSessionAccumulation, recordEnrichRound } from "./context-enricher-session";
import { validateEnrichedContext } from "./context-enricher-validator";

// ─── Constraints ───────────────────────────────────────────────────────────

/** Default project constraints always injected */
const DEFAULT_CONSTRAINTS: string[] = [
  "Max 400 lines per file — extract if exceeded",
  "Named exports only (no export default)",
  "Dependency injection via *Deps interfaces",
  "No circular dependencies",
  "Use centralized logger (log, logError, logWarn)",
];

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Enrich a raw user prompt with full project context.
 * This is the main function called by the message handler.
 *
 * @param prompt - Raw user text (goal or feedback)
 * @param deps - Injected dependencies (search, workspace, graph)
 * @returns Enriched result with pack, markdown preview, and timing
 */
export async function enrichPrompt(
  prompt: string,
  deps: EnricherDeps,
  ctx?: EnrichContext,
): Promise<EnrichResult> {
  const startTime = Date.now();
  const lastSynthesis = ctx?.lastSynthesis;
  const loopGoal = ctx?.loopGoal;
  deps.log(`[ContextEnricher] Enriching prompt: "${prompt.slice(0, 80)}..."${lastSynthesis ? " (with synthesis)" : ""}${loopGoal ? " (with goal)" : ""}`);

  // 1. Load accumulated context from previous rounds (if in a session)
  const sessionId = ctx?.sessionId;
  const prevAccum = sessionId ? getSessionAccumulation(sessionId) : null;
  if (prevAccum && prevAccum.roundCount > 0) {
    deps.log(`[ContextEnricher] Session ${sessionId}: round ${prevAccum.roundCount + 1}, ${prevAccum.entities.length} accumulated entities`);
  }

  // 2. Parse intent — combine user prompt + goal + synthesis signals + prior session entities
  const synthesisSignals = lastSynthesis ? extractSynthesisSignals(lastSynthesis) : null;
  const contextParts = [prompt];
  if (loopGoal && loopGoal !== prompt) contextParts.push(loopGoal);
  // Use extracted signals instead of raw synthesis (less noise, more precision)
  if (synthesisSignals) {
    const signalText = [
      ...synthesisSignals.filePaths,
      ...synthesisSignals.codeEntities,
      ...synthesisSignals.decisions,
    ].join(" ");
    if (signalText.trim()) contextParts.push(signalText);
  }
  // Inject accumulated entities from previous rounds
  if (prevAccum && prevAccum.entities.length > 0) {
    contextParts.push(prevAccum.entities.slice(0, 10).join(" "));
  }
  const combinedContext = contextParts.join("\n---\n");
  const intent = parseIntent(combinedContext);
  // Keep the original prompt as rawQuery (not the combined one)
  intent.rawQuery = prompt;
  deps.log(`[ContextEnricher] Intent: action=${intent.action}, domain=[${intent.domain.slice(0, 4).join(",")}]`);

  // 2. Retrieve memory + graph in parallel
  const [memoryResults, graphData, opinions] = await Promise.all([
    searchMemoryMulti(intent, deps),
    Promise.resolve(loadGraphSubset(intent, deps)),
    Promise.resolve(readRelevantOpinions(intent, deps.getWorkspaceRoot())),
  ]);

  // 2b. Supplementary search using synthesis signals (weighted lower)
  if (synthesisSignals && synthesisSignals.filePaths.length > 0) {
    const synthQuery = synthesisSignals.filePaths.slice(0, 3).join(" ");
    try {
      const extraRaw = await deps.searchMemory(synthQuery, 3);
      const extraBlocks = extraRaw && extraRaw !== "No results found."
        ? extraRaw.split(/(?:^|\n)(?:---+|\d+\.\s)/m)
            .filter(s => s.trim())
            .slice(0, 3)
            .map(section => {
              const lines = section.trim().split("\n");
              const title = lines[0]?.replace(/^#+\s*/, "").trim() || "Untitled";
              const content = lines.slice(1).join("\n").trim();
              const scoreMatch = section.match(/Score:\s*([\d.]+)%/);
              const confidence = scoreMatch ? parseFloat(scoreMatch[1]) / 100 * 0.7 : 0.35;
              return { type: "learning" as const, title, content: content.slice(0, 500), confidence, source: "synthesis-context" };
            })
        : [];
      memoryResults.learnings.push(...extraBlocks);
    } catch { /* non-critical — synthesis search is supplementary */ }
  }

  // 3. Build context graph (ranked/filtered)
  const contextGraph = graphData
    ? buildContextGraph(graphData, intent)
    : { nodes: [], edges: [] };

  // 4. Resolve relevant files
  const workspaceRoot = deps.getWorkspaceRoot();
  const fileMap = resolveRelevantFiles(intent, contextGraph, workspaceRoot);

  // 5. Link learnings to files
  const learningTitles = memoryResults.learnings.map(l => l.title);
  linkLearningsToFiles(fileMap, learningTitles);

  // 6. Combine all context blocks
  const contextBlocks = [
    ...memoryResults.learnings,
    ...memoryResults.troubleshooting,
    ...memoryResults.opinions,
    ...opinions,
  ];

  // 7. Detect risks
  const risks = detectRisks(intent, contextGraph);

  // 8. Calculate overall confidence
  const confidence = calculateConfidence(intent, contextBlocks, fileMap, contextGraph);

  // 9. Derive dynamic constraints based on context
  const dynamicConstraints = deriveContextualConstraints(intent, fileMap, contextGraph);
  const allConstraints = [...DEFAULT_CONSTRAINTS, ...dynamicConstraints];

  // 10. Build the pack (without rewrittenPrompt yet)
  const partialPack = {
    originalPrompt: prompt,
    intent,
    memoryGraph: contextGraph,
    contextBlocks,
    fileMap,
    constraints: allConstraints,
    risks,
    confidence,
  };

  // 10. Generate rewritten prompt
  const rewrittenPrompt = buildRewrittenPrompt(partialPack);

  let pack: EnrichedPromptPack = {
    ...partialPack,
    rewrittenPrompt,
  };

  // 11. LLM validation — filter irrelevant blocks, files, and graph nodes
  if (deps.validateContext) {
    const validation = await validateEnrichedContext(pack, deps.validateContext, deps.log);
    if (validation.success && (validation.filteredOut.length > 0 || validation.keepNodeIndices)) {
      // Rebuild graph if node filtering was applied
      let validatedGraph = pack.memoryGraph;
      if (validation.keepNodeIndices) {
        const keptNodes = validation.keepNodeIndices
          .filter(i => i >= 0 && i < pack.memoryGraph.nodes.length)
          .map(i => pack.memoryGraph.nodes[i]);
        const keptNodeIds = new Set(keptNodes.map(n => n.id));
        const keptEdges = pack.memoryGraph.edges.filter(e => keptNodeIds.has(e.from) && keptNodeIds.has(e.to));
        validatedGraph = { nodes: keptNodes, edges: keptEdges };
      }
      // Rebuild pack with validated blocks, files, and graph
      const validatedPack = {
        ...pack,
        contextBlocks: validation.validBlocks,
        fileMap: validation.validFiles,
        memoryGraph: validatedGraph,
      };
      validatedPack.rewrittenPrompt = buildRewrittenPrompt(validatedPack);
      pack = validatedPack;
      deps.log(`[ContextEnricher] Validation reasoning: ${validation.reasoning}`);
    }
  }

  // 12. Format preview markdown
  const formattedMarkdown = formatPreviewMarkdown(pack);

  const durationMs = Date.now() - startTime;
  deps.log(`[ContextEnricher] Enrichment complete in ${durationMs}ms (confidence: ${(confidence * 100).toFixed(0)}%)`);

  // 12. Record this round's context for progressive accumulation
  if (sessionId) {
    recordEnrichRound(sessionId, {
      entities: intent.entities,
      domains: intent.domain,
      files: fileMap.map(f => f.path),
    });
  }

  return { pack, formattedMarkdown, durationMs };
}

// ─── Confidence Calculation ────────────────────────────────────────────────

function calculateConfidence(
  intent: ParsedIntent,
  blocks: { confidence: number }[],
  files: { relevance: number }[],
  graph: { nodes: { relevance: number }[] },
): number {
  let score = 0.3; // Base

  // More context blocks = higher confidence
  if (blocks.length >= 3) score += 0.2;
  else if (blocks.length >= 1) score += 0.1;

  // Files found = higher confidence
  if (files.length >= 3) score += 0.2;
  else if (files.length >= 1) score += 0.1;

  // Graph has relevant nodes
  if (graph.nodes.length >= 5) score += 0.15;
  else if (graph.nodes.length >= 2) score += 0.08;

  // Intent parsed with entities
  if (intent.entities.length > 0) score += 0.1;

  // Average confidence of blocks
  if (blocks.length > 0) {
    const avgConf = blocks.reduce((sum, b) => sum + b.confidence, 0) / blocks.length;
    score += avgConf * 0.15;
  }

  return Math.min(score, 0.99);
}
