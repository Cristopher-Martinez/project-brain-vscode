/**
 * Context Enricher — Format layer
 *
 * Converts the EnrichedPromptPack into:
 * 1. A rewritten prompt (structured for agent consumption)
 * 2. A Markdown preview (for webview display)
 */

import { getConfidenceEmoji } from "./graph-utils";
import type { ContextBlock, ContextGraph, EnrichedPromptPack, FileReference } from "./context-enricher-types";

// ─── Prompt Rewriting ──────────────────────────────────────────────────────

/**
 * Generate the rewritten prompt that will be sent to the agent.
 * This is the "enriched" version that makes a small model perform like a larger one.
 */
export function buildRewrittenPrompt(pack: Omit<EnrichedPromptPack, "rewrittenPrompt">): string {
  const sections: string[] = [];

  // Header
  sections.push(`**Objetivo**: ${pack.originalPrompt}`);
  sections.push("");

  // Context blocks (top learnings/opinions)
  const topBlocks = pack.contextBlocks
    .filter(b => b.confidence >= 0.4)
    .slice(0, 5);

  if (topBlocks.length > 0) {
    sections.push("**Contexto crítico (de memoria del proyecto)**:");
    for (const block of topBlocks) {
      sections.push(`- [${block.type}] ${block.title}: ${block.content.slice(0, 150)}`);
    }
    sections.push("");
  }

  // File map
  if (pack.fileMap.length > 0) {
    sections.push("**Archivos relevantes**:");
    for (const file of pack.fileMap.slice(0, 8)) {
      const hot = file.hotspot ? " 🔥" : "";
      sections.push(`- \`${file.path}\` (${file.lines}L)${hot} — ${file.summary}`);
    }
    sections.push("");
  }

  // Graph connections (compact)
  if (pack.memoryGraph.edges.length > 0) {
    sections.push("**Grafo de dependencias**:");
    const topEdges = pack.memoryGraph.edges.slice(0, 8);
    for (const edge of topEdges) {
      sections.push(`- ${edge.from} → ${edge.to} [${edge.type}]`);
    }
    sections.push("");
  }

  // Risks
  if (pack.risks.length > 0) {
    sections.push("**Riesgos identificados**:");
    for (const risk of pack.risks) {
      sections.push(`- ⚠️ ${risk}`);
    }
    sections.push("");
  }

  // Constraints
  if (pack.constraints.length > 0) {
    sections.push("**Restricciones**:");
    for (const c of pack.constraints) {
      sections.push(`- ${c}`);
    }
    sections.push("");
  }

  sections.push("**Tarea**: " + pack.originalPrompt);

  return sections.join("\n");
}

// ─── Markdown Preview (for webview) ────────────────────────────────────────

/**
 * Generate a human-readable Markdown preview of the enrichment result.
 * This is displayed in the webview for user review before sending.
 */
export function formatPreviewMarkdown(pack: EnrichedPromptPack): string {
  const sections: string[] = [];

  // Intent summary
  sections.push(`### 🎯 Intent detectado`);
  sections.push(`**Acción**: ${pack.intent.action} | **Dominio**: ${pack.intent.domain.join(", ")}`);
  if (pack.intent.entities.length > 0) {
    sections.push(`**Entidades**: ${pack.intent.entities.join(", ")}`);
  }
  sections.push("");

  // File map table
  if (pack.fileMap.length > 0) {
    sections.push(`### 📂 Archivos relevantes`);
    sections.push("");
    sections.push("| # | Archivo | Líneas | Resumen | Rel. |");
    sections.push("|---|---------|--------|---------|------|");
    pack.fileMap.forEach((file, i) => {
      const emoji = getConfidenceEmoji(file.relevance);
      const hot = file.hotspot ? " 🔥" : "";
      sections.push(
        `| ${i + 1} | \`${file.path}\`${hot} | ${file.lines} | ${file.summary.slice(0, 50)} | ${emoji} ${(file.relevance * 100).toFixed(0)}% |`,
      );
    });
    sections.push("");
  }

  // Context blocks
  const learnings = pack.contextBlocks.filter(b => b.type === "learning");
  const opinions = pack.contextBlocks.filter(b => b.type === "opinion");
  const troubles = pack.contextBlocks.filter(b => b.type === "troubleshooting");

  if (learnings.length > 0) {
    sections.push(`### 📚 Aprendizajes relacionados`);
    for (const l of learnings.slice(0, 3)) {
      sections.push(`- **${l.title}**: ${l.content.slice(0, 100)}...`);
    }
    sections.push("");
  }

  if (opinions.length > 0) {
    sections.push(`### 💡 Opiniones del proyecto`);
    for (const o of opinions.slice(0, 3)) {
      sections.push(`- ${o.title} (confianza: ${(o.confidence * 100).toFixed(0)}%)`);
    }
    sections.push("");
  }

  if (troubles.length > 0) {
    sections.push(`### 🔧 Troubleshooting relevante`);
    for (const t of troubles.slice(0, 2)) {
      sections.push(`- **${t.title}**: ${t.content.slice(0, 100)}...`);
    }
    sections.push("");
  }

  // Risks
  if (pack.risks.length > 0) {
    sections.push(`### ⚠️ Riesgos`);
    for (const risk of pack.risks) {
      sections.push(`- ${risk}`);
    }
    sections.push("");
  }

  // Graph mini-view
  if (pack.memoryGraph.nodes.length > 0) {
    sections.push(`### 🕸️ Grafo de contexto (${pack.memoryGraph.nodes.length} nodos, ${pack.memoryGraph.edges.length} aristas)`);
    const topEdges = pack.memoryGraph.edges.slice(0, 5);
    for (const e of topEdges) {
      sections.push(`- ${e.from} → ${e.to} \`${e.type}\``);
    }
    sections.push("");
  }

  // Confidence footer
  sections.push(`---`);
  sections.push(`${getConfidenceEmoji(pack.confidence)} Confianza global: ${(pack.confidence * 100).toFixed(0)}%`);

  return sections.join("\n");
}
