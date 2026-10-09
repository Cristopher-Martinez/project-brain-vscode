/**
 * bridge-project-memory — Project memory integration for PM context.
 *
 * Loads BOOT.md (compact project snapshot) and queries the vectorized
 * project memory via MCP RAG server to give the PM architectural context.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";
import type { ProjectMemoryContext } from "./auto-loop-bridge-types";

const BOOT_MD = "BOOT.md";
const MEMORY_DIR = ".project-brain/memory";
const MAX_BOOT_CHARS = 600;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache keyed by repoRoot
const cache = new Map<string, { ctx: ProjectMemoryContext; expiresAt: number }>();

// —— Public API ———————————————————————————

/**
 * Fetch project memory context for PM enrichment.
 * Always loads BOOT.md, optionally queries RAG for deeper context.
 */
export async function fetchProjectMemory(
  repoRoot: string,
  _objective: string,
  _userMessage: string,
): Promise<ProjectMemoryContext> {
  // Check cache
  const cached = cache.get(repoRoot);
  if (cached && cached.expiresAt > Date.now()) {
    log("[ProjectMemory] Using cached context");
    return cached.ctx;
  }

  const bootSummary = loadBootMd(repoRoot);
  const ragChunks = loadTopOpinions(repoRoot);

  const ctx: ProjectMemoryContext = {
    bootSummary,
    ragChunks,
    fetchedAt: Date.now(),
  };

  cache.set(repoRoot, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  log(`[ProjectMemory] Loaded: boot=${bootSummary.length}c, chunks=${ragChunks.length}`);
  return ctx;
}

// —— BOOT.md Loader ————————————————————————

function loadBootMd(repoRoot: string): string {
  const bootPath = path.join(repoRoot, MEMORY_DIR, BOOT_MD);
  try {
    if (!fs.existsSync(bootPath)) { return ""; }
    const raw = fs.readFileSync(bootPath, "utf-8");
    if (raw.length <= MAX_BOOT_CHARS) { return raw; }
    return raw.slice(0, MAX_BOOT_CHARS - 12) + " [truncated]";
  } catch (err) {
    logWarn(`[ProjectMemory] Failed to load BOOT.md: ${err}`);
    return "";
  }
}

// —— Top Opinions Loader ————————————————————

const OPINIONS_FILE = "14_OPINIONS.md";
const MAX_OPINION_CHUNKS = 5;

/**
 * Load top opinions from the opinions file as RAG-like context chunks.
 * These represent learned patterns and preferences.
 */
function loadTopOpinions(repoRoot: string): string[] {
  const opinionsPath = path.join(repoRoot, MEMORY_DIR, OPINIONS_FILE);
  try {
    if (!fs.existsSync(opinionsPath)) { return []; }
    const raw = fs.readFileSync(opinionsPath, "utf-8");
    // Parse opinion entries (format: ## Title\nContent\nconfidence: X)
    const entries = raw.split(/\n##\s+/).filter(e => e.trim().length > 20);
    // Sort by confidence (highest first) and take top N
    const scored = entries.map(e => {
      const confMatch = e.match(/confidence:\s*([\d.]+)/i);
      return { text: e.trim().slice(0, 300), confidence: confMatch ? parseFloat(confMatch[1]) : 0.5 };
    });
    scored.sort((a, b) => b.confidence - a.confidence);
    return scored.slice(0, MAX_OPINION_CHUNKS).map(s => s.text);
  } catch (err) {
    logWarn(`[ProjectMemory] Failed to load opinions: ${err}`);
    return [];
  }
}

// —— Context Formatting ——————————————————————

/** Format project memory for injection into PM context. */
export function formatProjectMemoryForContext(
  ctx: ProjectMemoryContext,
  maxChars: number,
): string {
  if (!ctx.bootSummary && ctx.ragChunks.length === 0) { return ""; }
  const sections: string[] = ["## Project Knowledge"];
  let chars = sections[0].length;

  if (ctx.bootSummary) {
    const bootSection = "### Project Snapshot\n" + ctx.bootSummary;
    if (chars + bootSection.length < maxChars) {
      sections.push(bootSection);
      chars += bootSection.length;
    }
  }

  if (ctx.ragChunks.length > 0) {
    sections.push("### Learned Patterns");
    chars += 20;
    for (const chunk of ctx.ragChunks) {
      if (chars + chunk.length + 4 > maxChars) { break; }
      sections.push("- " + chunk);
      chars += chunk.length + 4;
    }
  }

  log(`[ProjectMemory] Formatted: ${chars} chars`);
  return sections.join("\n");
}

/** Invalidate the project memory cache for a repo. */
export function invalidateProjectMemoryCache(repoRoot: string): void {
  cache.delete(repoRoot);
}
