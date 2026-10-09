import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, relative } from "path";
import { getLoopsDir } from "./brain-paths";
import { log, logError } from "./logger";
import { computeDiffFingerprint } from "./test-advice-diff";
import type { TestAdviceCache, TestAdviceEntry } from "./test-advice-types";

const CACHE_FILE_NAME = "test-advice.json";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

function getCachePath(wsRoot: string): string {
  return join(getLoopsDir(wsRoot), CACHE_FILE_NAME);
}

export function readAdviceCache(wsRoot: string): TestAdviceCache {
  try {
    const cachePath = getCachePath(wsRoot);
    if (!existsSync(cachePath)) {
      return {};
    }
    return JSON.parse(readFileSync(cachePath, "utf8")) as TestAdviceCache;
  } catch {
    return {};
  }
}

export function readFreshAdvice(
  wsRoot: string,
  files: string[],
): Map<string, TestAdviceEntry> {
  const cache = readAdviceCache(wsRoot);
  const fresh = new Map<string, TestAdviceEntry>();
  for (const file of files) {
    const entry = cache[buildAdviceKey(wsRoot, file)] ?? cache[basename(file)];
    if (!entry) {
      continue;
    }
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      continue;
    }
    if (
      entry.diffFingerprint &&
      entry.diffFingerprint !== computeDiffFingerprint(file, wsRoot)
    ) {
      continue;
    }
    fresh.set(basename(file), entry);
  }
  return fresh;
}

export function writeAdviceEntries(
  wsRoot: string,
  entries: TestAdviceEntry[],
): void {
  try {
    const loopsDir = getLoopsDir(wsRoot);
    if (!existsSync(loopsDir)) {
      mkdirSync(loopsDir, { recursive: true });
    }

    const cache = readAdviceCache(wsRoot);
    for (const entry of entries) {
      cache[buildAdviceKey(wsRoot, entry.file)] = entry;
    }

    const trimmed = Object.entries(cache)
      .sort(([, left], [, right]) => right.timestamp - left.timestamp)
      .slice(0, MAX_CACHE_ENTRIES);

    writeFileSync(
      getCachePath(wsRoot),
      JSON.stringify(Object.fromEntries(trimmed), null, 2),
      "utf8",
    );
    log("[TestAdvice] Advice cached");
  } catch (err) {
    logError(`[TestAdvice] Failed to write cache: ${err}`);
  }
}

function buildAdviceKey(wsRoot: string, file: string): string {
  return relative(wsRoot, file).replace(/\\/g, "/").toLowerCase();
}