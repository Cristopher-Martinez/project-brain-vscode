// ============================================================
// test-classifier-cache.ts — Cache management for test classifier
// Handles read/write of JSON classification cache + path matching.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logError } from "./logger";
import type { TestClassification } from "./test-classifier";

// ——— Constants ———————————————————————————————————————————————
const CACHE_FILE_NAME = "test-classification.json";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_CACHE_ENTRIES = 20;

interface TestClassificationCache {
  [key: string]: TestClassification;
}

// ——— Cache Paths ————————————————————————————————————————————

function getCacheDir(wsRoot: string): string {
  return getLoopsDir(wsRoot);
}

function getCachePath(wsRoot: string): string {
  return join(getCacheDir(wsRoot), CACHE_FILE_NAME);
}

function getCacheKey(files: string[]): string {
  return files
    .map((f) => basename(f))
    .sort()
    .join("|");
}

// ——— Read Cache —————————————————————————————————————————————

export function readCache(
  wsRoot: string,
  files: string[],
): TestClassification | null {
  try {
    const cachePath = getCachePath(wsRoot);
    if (!existsSync(cachePath)) return null;

    const raw = readFileSync(cachePath, "utf8");
    const cache: TestClassificationCache = JSON.parse(raw);
    const key = getCacheKey(files);
    const entry = cache[key];

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      log("[TestClassifier] Cache expired");
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

// ——— Write Cache ————————————————————————————————————————————

export function writeCache(
  wsRoot: string,
  files: string[],
  result: TestClassification,
): void {
  try {
    const dir = getCacheDir(wsRoot);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const cachePath = getCachePath(wsRoot);
    let cache: TestClassificationCache = {};

    // Read existing cache
    try {
      if (existsSync(cachePath)) {
        cache = JSON.parse(readFileSync(cachePath, "utf8"));
      }
    } catch {
      cache = {};
    }

    // Prune old entries
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE_ENTRIES) {
      const sorted = entries.sort(([, a], [, b]) => b.timestamp - a.timestamp);
      cache = Object.fromEntries(sorted.slice(0, MAX_CACHE_ENTRIES));
    }

    const key = getCacheKey(files);
    cache[key] = result;

    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    log("[TestClassifier] Classification cached");
  } catch (err) {
    logError(`[TestClassifier] Failed to write cache: ${err}`);
  }
}

// ——— Path Matching Utilities ————————————————————————————————

export function matchFilesToPaths(
  fileNames: string[],
  originalPaths: string[],
): string[] {
  return fileNames
    .map((name) => matchSingleFilePath(name, originalPaths))
    .filter((p): p is string => p !== undefined);
}

export function matchSingleFilePath(
  name: string,
  originalPaths: string[],
): string | undefined {
  return originalPaths.find((p) => basename(p) === name);
}

// ——— Result Builder —————————————————————————————————————————

export function buildResult(
  testableFiles: string[],
  excludedFiles: Array<{ file: string; reason: string }>,
): TestClassification {
  return {
    testable: testableFiles,
    excluded: excludedFiles,
    timestamp: Date.now(),
  };
}
