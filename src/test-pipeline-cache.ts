/**
 * test-pipeline-cache.ts — Contract Cache + Public API
 *
 * Handles reading/writing the test contract cache in `.project-brain/loops/test-contract.json`.
 * Also provides the high-level getOrDetect and refresh functions.
 *
 * Extracted from test-pipeline-contracts.ts for the 400-line rule.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logWarn } from "./logger";
import { detectTestContract } from "./test-pipeline-contracts";
import { ContractCache, ProjectTestContract } from "./test-pipeline-types";

// ─── Constants ───────────────────────────────────────────────

const CACHE_FILE = "test-contract.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Helpers ─────────────────────────────────────────────────

/** Hash file content for cache invalidation (SHA-1). */
function hashFile(filePath: string): string {
  try {
    return createHash("sha1")
      .update(readFileSync(filePath, "utf8"))
      .digest("hex");
  } catch {
    return "";
  }
}

// ─── Cache Read/Write ────────────────────────────────────────

export function readContractCache(wsRoot: string): ProjectTestContract | null {
  const cachePath = join(getLoopsDir(wsRoot), CACHE_FILE);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const cache: ContractCache = JSON.parse(readFileSync(cachePath, "utf8"));
    // Hash-based invalidation: package.json changed → regenerate
    const pkgPath = join(wsRoot, "package.json");
    if (cache.packageHash && existsSync(pkgPath)) {
      const currentHash = hashFile(pkgPath);
      if (currentHash && cache.packageHash !== currentHash) {
        log("[TestContract] package.json changed — cache invalidated");
        return null;
      }
    }
    // TTL fallback
    if (Date.now() - cache.timestamp > CACHE_TTL_MS) {
      log("[TestContract] Cache expired");
      return null;
    }
    return cache.contract;
  } catch {
    logWarn("[TestContract] Corrupt cache — deleting");
    try {
      unlinkSync(cachePath);
    } catch {
      /* already gone */
    }
    return null;
  }
}

export function writeContractCache(
  wsRoot: string,
  contract: ProjectTestContract,
): void {
  const cacheDir = getLoopsDir(wsRoot);
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const pkgPath = join(wsRoot, "package.json");
    const cache: ContractCache = {
      contract,
      timestamp: Date.now(),
      wsRoot,
      packageHash: existsSync(pkgPath) ? hashFile(pkgPath) : undefined,
    };
    writeFileSync(
      join(cacheDir, CACHE_FILE),
      JSON.stringify(cache, null, 2),
      "utf8",
    );
    log("[TestContract] Cache written");
  } catch {
    logWarn("[TestContract] Failed to write cache");
  }
}

// ─── Public API ──────────────────────────────────────────────

/** Get or detect the project test contract. Returns cache if valid. */
export function getOrDetectContract(wsRoot: string): ProjectTestContract {
  const cached = readContractCache(wsRoot);
  if (cached) {
    return cached;
  }
  const contract = detectTestContract(wsRoot);
  writeContractCache(wsRoot, contract);
  return contract;
}

/** Force re-detection (bypass cache). */
export function refreshContract(wsRoot: string): ProjectTestContract {
  const contract = detectTestContract(wsRoot);
  writeContractCache(wsRoot, contract);
  return contract;
}

/** Merge user overrides into an existing contract. User takes priority. */
export function mergeContractOverrides(
  existing: ProjectTestContract,
  overrides: Partial<ProjectTestContract>,
): ProjectTestContract {
  const merged = { ...existing };
  if (overrides.test !== undefined) {
    merged.test = overrides.test;
  }
  if (overrides.coverage !== undefined) {
    merged.coverage = overrides.coverage;
  }
  if (overrides.lint !== undefined) {
    merged.lint = overrides.lint;
  }
  if (overrides.mutation !== undefined) {
    merged.mutation = overrides.mutation;
  }
  if (overrides.framework !== undefined) {
    merged.framework = overrides.framework;
  }
  if (overrides.invariantsPattern !== undefined) {
    merged.invariantsPattern = overrides.invariantsPattern;
  }

  if (overrides.coreModules) {
    const userPaths = new Set(overrides.coreModules.map((m) => m.path));
    const autoOnly = merged.coreModules.filter((m) => !userPaths.has(m.path));
    merged.coreModules = [...overrides.coreModules, ...autoOnly];
  }
  return merged;
}
