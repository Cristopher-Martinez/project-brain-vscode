/**
 * Self-Learning Context — Builds rich context for analysis agents.
 *
 * Provides:
 * - Structural map (file tree + stats)
 * - Key file reading (package.json, README, configs)
 * - RAG CLI search queries per agent
 * - Cross-agent context injection
 *
 * @module self-learning-context
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { log, logError } from "./logger";
import type {
  AnalysisAgentId,
  LocalEmbeddingConfig,
} from "./self-learning-types";
import {
  AGENT_QUERIES,
  KEY_FILES,
  MAX_KEY_FILE_CHARS,
  MAX_RAG_CHARS,
  MAX_TOTAL_CONTEXT,
  MAX_TREE_DEPTH,
  MAX_TREE_FILES,
  SKIP_DIRS,
  SKIP_EXTS,
  SKIP_FILES,
  type TreeEntry,
} from "./self-learning-constants";
export type { AgentContext } from "./self-learning-constants";

const execFileAsync = promisify(execFile);

// ─── Structural Map Builder ─────────────────────────────────────────────

export function buildStructuralMap(repoPath: string): string {
  const lines: string[] = ["## Estructura del Proyecto\n"];
  const stats = { files: 0, dirs: 0, byExt: new Map<string, number>() };
  let fileCount = 0;

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > MAX_TREE_DEPTH || fileCount > MAX_TREE_FILES) return;

    let entries: TreeEntry[];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      entries = items
        .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          ext: e.isDirectory() ? undefined : path.extname(e.name).toLowerCase(),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount > MAX_TREE_FILES) break;

      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stats.dirs++;
        lines.push(`${prefix}${entry.name}/`);
        walk(path.join(dir, entry.name), prefix + "  ", depth + 1);
      } else {
        if (SKIP_FILES.has(entry.name)) continue;
        if (entry.ext && SKIP_EXTS.has(entry.ext)) continue;
        stats.files++;
        fileCount++;
        lines.push(`${prefix}${entry.name}`);

        // Track extensions
        const ext = entry.ext ?? "(none)";
        stats.byExt.set(ext, (stats.byExt.get(ext) ?? 0) + 1);
      }
    }
  }

  walk(repoPath, "  ", 0);

  // Add stats summary
  const extSummary = [...stats.byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(", ");

  lines.push("");
  lines.push(
    `**Estadísticas**: ${stats.files} archivos, ${stats.dirs} directorios`,
  );
  lines.push(`**Extensiones**: ${extSummary}`);

  return lines.join("\n");
}

// ─── Key Files Reader ───────────────────────────────────────────────────

export function readKeyFiles(repoPath: string): string {
  const sections: string[] = ["## Archivos Clave\n"];

  for (const relPath of KEY_FILES) {
    const fullPath = path.join(repoPath, relPath);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 100_000) {
        sections.push(
          `### ${relPath}\n(archivo demasiado grande: ${(stat.size / 1024).toFixed(0)}KB — omitido)\n`,
        );
        continue;
      }

      let content = fs.readFileSync(fullPath, "utf-8");
      if (content.length > MAX_KEY_FILE_CHARS) {
        content = content.slice(0, MAX_KEY_FILE_CHARS) + "\n... (truncado)";
      }

      sections.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`);
    } catch {
      // Skip unreadable files
    }
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

// ─── RAG Search ─────────────────────────────────────────────────────────

export async function searchRAG(
  cliPath: string,
  repoPath: string,
  queries: string[],
  config: LocalEmbeddingConfig,
): Promise<string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EMBEDDING_PROVIDER: "openai",
    OPENAI_BASE_URL: config.baseUrl,
    OPENAI_MODEL: config.model,
    OPENAI_API_KEY: config.apiKey,
  };

  const results: string[] = ["## Contexto RAG (código relevante)\n"];

  for (const query of queries) {
    try {
      const { stdout } = await execFileAsync(
        "node",
        [cliPath, "search", query, "-p", repoPath, "-k", "3"],
        { timeout: 30_000, maxBuffer: 5 * 1024 * 1024, env },
      );

      if (stdout.trim() && !stdout.includes("No relevant results")) {
        const trimmed =
          stdout.length > MAX_RAG_CHARS
            ? stdout.slice(0, MAX_RAG_CHARS) + "\n... (truncado)"
            : stdout;
        results.push(`### Búsqueda: "${query}"\n${trimmed}\n`);
      }
    } catch (err) {
      log(
        `[SelfLearning] RAG search failed for "${query}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return results.length > 1 ? results.join("\n") : "";
}

// ─── Context Builder ────────────────────────────────────────────────────

export function getAgentQueries(agentId: AnalysisAgentId): string[] {
  return AGENT_QUERIES[agentId] ?? [];
}

/** Read previous agent outputs for cross-agent context (cookbook, auditor) */
export function readPreviousOutputs(
  analysisDir: string,
  excludeAgentId: AnalysisAgentId,
): string {
  const sections: string[] = ["## Reportes de Agentes Anteriores\n"];

  const agentFiles: Array<{ id: string; file: string; name: string }> = [
    { id: "architect", file: "01_arquitectura.md", name: "Arquitecto" },
    { id: "patterns", file: "02_patrones_y_calidad.md", name: "Patrones" },
    {
      id: "components",
      file: "03_componentes_reutilizables.md",
      name: "Componentes",
    },
    {
      id: "business-logic",
      file: "04_logica_negocio.md",
      name: "Lógica de Negocio",
    },
    {
      id: "infrastructure",
      file: "05_infraestructura.md",
      name: "Infraestructura",
    },
    { id: "security", file: "06_seguridad.md", name: "Seguridad" },
    { id: "performance", file: "07_performance.md", name: "Performance" },
    { id: "devops", file: "08_devops_y_escalabilidad.md", name: "DevOps" },
  ];

  for (const agent of agentFiles) {
    if (agent.id === excludeAgentId) continue;
    const filePath = path.join(analysisDir, agent.file);
    if (!fs.existsSync(filePath)) continue;

    try {
      let content = fs.readFileSync(filePath, "utf-8");
      // Summarize if too long (keep first 1500 chars per agent)
      if (content.length > 1500) {
        content = content.slice(0, 1500) + "\n... (resumen truncado)";
      }
      sections.push(`### ${agent.name}\n${content}\n`);
    } catch {
      // Skip
    }
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

/** Build complete context for an analysis agent */
export async function buildAgentContext(opts: {
  agentId: AnalysisAgentId;
  repoPath: string;
  cliPath: string;
  config: LocalEmbeddingConfig;
  analysisDir: string;
  structuralMap: string;
  keyFiles: string;
}): Promise<string> {
  // Priority order: most valuable context FIRST (survives trimming)
  // 1. Key files (README, package.json — essential orientation)
  // 2. RAG results (agent-specific code evidence)
  // 3. Cross-agent context (for late agents — consolidation data)
  // 4. Structural map (file tree — useful but expendable)
  const parts: string[] = [];

  // 1. Key files (shared, pre-computed)
  if (opts.keyFiles) parts.push(opts.keyFiles);

  // 2. Agent-specific RAG queries
  const queries = getAgentQueries(opts.agentId);
  if (queries.length > 0) {
    try {
      const ragContext = await searchRAG(
        opts.cliPath,
        opts.repoPath,
        queries,
        opts.config,
      );
      if (ragContext) parts.push(ragContext);
    } catch (err) {
      logError(`[SelfLearning] RAG context failed for ${opts.agentId}: ${err}`);
    }
  }

  // 3. Cross-agent context for late agents (cookbook, auditor)
  if (opts.agentId === "cookbook" || opts.agentId === "auditor") {
    const previousContext = readPreviousOutputs(opts.analysisDir, opts.agentId);
    if (previousContext) parts.push(previousContext);
  }

  // 4. Structural map (shared, pre-computed) — lowest priority, trimmed first
  parts.push(opts.structuralMap);

  // 5. Trim total context to avoid context window overflow
  let combined = parts.join("\n\n---\n\n");
  if (combined.length > MAX_TOTAL_CONTEXT) {
    combined =
      combined.slice(0, MAX_TOTAL_CONTEXT) +
      "\n\n... (contexto truncado por límite)";
  }

  return combined;
}
