/**
 * Shared loop utilities for hooks.
 * Cross-platform, no external deps.
 * MULTI-LOOP: Supports per-session signal files (active-loop-{sessionId}.json)
 * with backward compat for legacy single file (active-loop.json).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { getMemoryDirWithFallback } from "./brain-paths.mjs";

/** Strip UTF-8 BOM — PowerShell writes BOM by default, crashes JSON.parse. */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Max age for signal files before considered stale (4 hours) */
const LOOP_SIGNAL_TTL_MS = 1 * 60 * 60 * 1000;

/** In-memory cache for readAllActiveLoops — avoids repeated filesystem reads within a single hook invocation. */
let _loopCache = { loops: [], dirMtime: 0, maxFileMtime: 0, ts: 0, cwd: "" };
const LOOP_CACHE_TTL_MS = 3000; // 3 seconds

/**
 * Validate and read a single loop signal file with TTL check.
 * Auto-cleans stale files (>24h).
 * @param {string} filePath
 * @returns {{ sessionId: string, goal: string, startedAt: string } | null}
 */
function readAndValidateLoop(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const stat = statSync(filePath);
    if (Date.now() - stat.mtimeMs > LOOP_SIGNAL_TTL_MS) {
      try {
        unlinkSync(filePath);
      } catch {}
      return null;
    }
    const data = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
    if (!data.sessionId) return null;
    // Heartbeat check: if heartbeat exists and is >10 min old, consider stale
    if (data.lastHeartbeat) {
      const hbAge = Date.now() - new Date(data.lastHeartbeat).getTime();
      if (hbAge > 10 * 60 * 1000) {
        try { unlinkSync(filePath); } catch {}
        return null;
      }
    } else {
      // No heartbeat field (legacy signal) — use shorter TTL (15 min) to prevent ghost loops
      if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) {
        try { unlinkSync(filePath); } catch {}
        return null;
      }
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Read ALL active loop signals (multi-loop safe).
 * Scans per-session files first, falls back to legacy single file.
 * @param {string} cwd - Workspace root
 * @returns {Array<{ sessionId: string, goal: string, startedAt: string }>}
 */
/** Uncached implementation — reads filesystem directly. */
function _readAllActiveLoopsImpl(cwd) {
  const sessionsDir = join(getMemoryDirWithFallback(cwd), "sessions");
  const results = [];
  const seenIds = new Set();

  // 1. Per-session signal files: active-loop-{sessionId}.json
  try {
    const files = readdirSync(sessionsDir).filter(
      (f) => f.startsWith("active-loop-") && f.endsWith(".json"),
    );
    for (const f of files) {
      const data = readAndValidateLoop(join(sessionsDir, f));
      if (data && !seenIds.has(data.sessionId)) {
        results.push(data);
        seenIds.add(data.sessionId);
      }
    }
  } catch {
    /* dir might not exist */
  }

  // 2. Legacy fallback: active-loop.json (no session suffix)
  if (results.length === 0) {
    const legacy = readAndValidateLoop(join(sessionsDir, "active-loop.json"));
    if (legacy && !seenIds.has(legacy.sessionId)) {
      results.push(legacy);
    }
  }

  // Sort by startedAt (ISO) — deterministic order, most recent last
  results.sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  return results;
}

/**
 * Read ALL active loop signals with in-memory cache (3s TTL).
 * Avoids repeated filesystem reads when multiple functions call this per tool-use event.
 * @param {string} cwd - Workspace root
 * @returns {Array<{ sessionId: string, goal: string, startedAt: string }>}
 */
export function readAllActiveLoops(cwd) {
  try {
    const sessionsDir = join(getMemoryDirWithFallback(cwd), "sessions");
    let dirMtime = 0;
    let maxFileMtime = 0;
    try {
      dirMtime = statSync(sessionsDir).mtimeMs;
      // Check max file mtime to detect heartbeat writes (which don't change dir mtime)
      const sigFiles = readdirSync(sessionsDir).filter(
        (f) => f.startsWith("active-loop-") && f.endsWith(".json"),
      );
      for (const sf of sigFiles) {
        try {
          const mt = statSync(join(sessionsDir, sf)).mtimeMs;
          if (mt > maxFileMtime) maxFileMtime = mt;
        } catch {}
      }
    } catch { /* dir may not exist */ }
    if (
      cwd === _loopCache.cwd &&
      dirMtime === _loopCache.dirMtime &&
      maxFileMtime === _loopCache.maxFileMtime &&
      Date.now() - _loopCache.ts < LOOP_CACHE_TTL_MS
    ) {
      return _loopCache.loops;
    }
    const loops = _readAllActiveLoopsImpl(cwd);
    _loopCache = { loops, dirMtime, maxFileMtime, ts: Date.now(), cwd };
    return loops;
  } catch {
    return _readAllActiveLoopsImpl(cwd);
  }
}


/**
 * Read a single active loop signal (backward-compat wrapper).
 * When multiple loops exist, returns the most recent one.
 * @param {string} cwd - Workspace root
 * @returns {{ sessionId: string, goal: string, startedAt: string } | null}
 */
export function readActiveLoop(cwd) {
  const all = readAllActiveLoops(cwd);
  return all.length > 0 ? all[all.length - 1] : null;
}
