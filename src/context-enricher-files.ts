/**
 * Context Enricher — File Resolution
 *
 * Resolves relevant source files for the given intent by:
 * 1. Matching domain keywords against src/ filenames
 * 2. Extracting JSDoc summaries from file headers
 * 3. Counting lines
 * 4. Checking git hotspot status
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { FileReference, ParsedIntent } from "./context-enricher-types";
import type { ContextGraph } from "./context-enricher-types";

// ─── File Discovery ────────────────────────────────────────────────────────

/**
 * Find relevant source files matching the intent domain and entities.
 */
export function resolveRelevantFiles(
  intent: ParsedIntent,
  graph: ContextGraph,
  workspaceRoot: string,
): FileReference[] {
  const srcDir = path.join(workspaceRoot, "src");
  if (!fs.existsSync(srcDir)) return [];

  // Get all .ts files in src/
  const allFiles = listTsFiles(srcDir);
  const scored: Array<{ file: string; score: number }> = [];

  for (const file of allFiles) {
    const basename = path.basename(file, ".ts").toLowerCase();
    let score = 0;

    // Match against domain keywords
    for (const domain of intent.domain) {
      if (basename.includes(domain)) {
        score += 0.4;
      }
    }

    // Match against entities
    for (const entity of intent.entities) {
      const entityLower = entity.toLowerCase().replace(/[^a-z]/g, "");
      if (basename.replace(/-/g, "").includes(entityLower)) {
        score += 0.5;
      }
    }

    // Match against graph nodes (file nodes)
    for (const node of graph.nodes) {
      const nodeClean = node.id.toLowerCase().replace(/[^a-z]/g, "");
      if (basename.replace(/-/g, "").includes(nodeClean) || nodeClean.includes(basename.replace(/-/g, ""))) {
        score += node.relevance * 0.3;
      }
    }

    if (score > 0.1) {
      scored.push({ file, score });
    }
  }

  // Sort by score, take top 10
  scored.sort((a, b) => b.score - a.score);
  const topFiles = scored.slice(0, 10);

  // Build FileReference for each
  return topFiles.map(({ file, score }) => {
    const relPath = path.relative(workspaceRoot, file).replace(/\\/g, "/");
    const lines = countLines(file);
    const summary = extractSummary(file);
    const hotspot = isHotspot(file, workspaceRoot);

    return {
      path: relPath,
      lines,
      summary,
      relevance: Math.min(score, 1.0),
      hotspot,
      relatedLearnings: [],
    };
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * List all .ts files in a directory (non-recursive for test files, recursive for src).
 */
function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "test" && entry.name !== "node_modules") {
        results.push(...listTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

/**
 * Count lines in a file efficiently.
 */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Extract the first JSDoc comment or the file header comment as summary.
 * Falls back to the file's first meaningful line.
 */
export function extractSummary(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").slice(0, 15);

    // Look for JSDoc: /** ... */
    const jsdocMatch = lines.join("\n").match(/\/\*\*\s*\n?\s*\*\s*(.+?)(?:\n|\*\/)/);
    if (jsdocMatch) {
      return jsdocMatch[1].trim().slice(0, 100);
    }

    // Look for single-line comment at top
    for (const line of lines) {
      const singleComment = line.match(/^\/\/\s*(.+)/);
      if (singleComment && singleComment[1].length > 10) {
        return singleComment[1].trim().slice(0, 100);
      }
    }

    // Fallback: first export or class name
    const exportMatch = content.match(/export (?:class|function|interface) (\w+)/);
    if (exportMatch) {
      return `Exports: ${exportMatch[1]}`;
    }

    return "No description available";
  } catch {
    return "Unable to read file";
  }
}

/**
 * Check if file is a git hotspot (many recent commits).
 * Uses git log to count commits in last 30 days.
 */
function isHotspot(filePath: string, workspaceRoot: string): boolean {
  try {
    const relPath = path.relative(workspaceRoot, filePath);
    const result = execFileSync(
      "git",
      ["log", "--oneline", "--since=30.days", "--", relPath],
      { cwd: workspaceRoot, encoding: "utf-8", timeout: 5000 },
    );
    const commitCount = result.trim().split("\n").filter(l => l.trim()).length;
    return commitCount >= 3;
  } catch {
    return false;
  }
}

/**
 * Enrich file references with related learnings from context blocks.
 */
export function linkLearningsToFiles(
  files: FileReference[],
  learningTitles: string[],
): void {
  for (const file of files) {
    const basename = path.basename(file.path, ".ts").toLowerCase();
    for (const title of learningTitles) {
      if (title.toLowerCase().includes(basename) || basename.includes(title.toLowerCase().split(" ")[0])) {
        file.relatedLearnings.push(title);
      }
    }
    // Cap at 3 related learnings per file
    file.relatedLearnings = file.relatedLearnings.slice(0, 3);
  }
}
