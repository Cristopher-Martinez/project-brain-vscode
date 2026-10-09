/**
 * Path Rewriter — STRAT-3
 *
 * Transparently maps workspace paths ↔ fork paths so agents
 * operating in an isolated fork don't accidentally edit files
 * in the main workspace. Also detects "path leakage" in agent output.
 *
 * Design: pure functions, no side effects, fully testeable.
 */

import * as path from "path";
import { log, logWarn } from "./logger";

// ─── Platform normalization ─────────────────────────────────────────────────

const IS_WIN = process.platform === "win32";

/** Normalize a path for comparison (lowercase on Windows, forward slashes). */
function normalizePath(p: string): string {
  const n = path.normalize(p).replace(/\\/g, "/");
  return IS_WIN ? n.toLowerCase() : n;
}

// ─── Core Rewriting ─────────────────────────────────────────────────────────

/**
 * Rewrite a workspace path to its fork equivalent.
 * If the path is already inside the fork, returns it unchanged.
 * If the path is not inside repoRoot, returns it unchanged.
 *
 * @example
 *   rewriteToFork("C:/repo/src/foo.ts", "C:/repo", "C:/repo/.brain-forks/abc")
 *   // → "C:/repo/.brain-forks/abc/src/foo.ts"
 */
export function rewriteToFork(
  filePath: string,
  repoRoot: string,
  forkPath: string,
): string {
  const normFile = normalizePath(filePath);
  const normRepo = normalizePath(repoRoot);
  const normFork = normalizePath(forkPath);

  // Already in fork → no rewrite needed
  if (normFile.startsWith(normFork + "/") || normFile === normFork) {
    return filePath;
  }

  // Not in repo → can't rewrite
  if (!normFile.startsWith(normRepo + "/")) {
    return filePath;
  }

  // Strip repo root prefix, append to fork path
  const relative = filePath.substring(repoRoot.length);
  const rewritten = path.join(forkPath, relative);
  log(`[PathRewriter] rewrite: ${filePath} → ${rewritten}`);
  return rewritten;
}

/**
 * Rewrite a fork path back to its workspace equivalent.
 * If the path is not inside the fork, returns it unchanged.
 *
 * @example
 *   rewriteToWorkspace("C:/repo/.brain-forks/abc/src/foo.ts", "C:/repo", "C:/repo/.brain-forks/abc")
 *   // → "C:/repo/src/foo.ts"
 */
export function rewriteToWorkspace(
  filePath: string,
  repoRoot: string,
  forkPath: string,
): string {
  const normFile = normalizePath(filePath);
  const normFork = normalizePath(forkPath);

  if (!normFile.startsWith(normFork + "/")) {
    return filePath;
  }

  const relative = filePath.substring(forkPath.length);
  const rewritten = path.join(repoRoot, relative);
  log(`[PathRewriter] reverse: ${filePath} → ${rewritten}`);
  return rewritten;
}

/**
 * Check if a path is inside the fork.
 */
export function isForkPath(
  filePath: string,
  forkPath: string,
): boolean {
  const normFile = normalizePath(filePath);
  const normFork = normalizePath(forkPath);
  return normFile.startsWith(normFork + "/") || normFile === normFork;
}

/**
 * Check if a path is inside the main workspace root (but NOT the fork).
 */
export function isWorkspacePath(
  filePath: string,
  repoRoot: string,
  forkPath: string,
): boolean {
  const normFile = normalizePath(filePath);
  const normRepo = normalizePath(repoRoot);
  const normFork = normalizePath(forkPath);
  return (
    normFile.startsWith(normRepo + "/") &&
    !normFile.startsWith(normFork + "/")
  );
}

// ─── Leakage Detection ─────────────────────────────────────────────────────

/** A detected path leak — workspace path that should be a fork path. */
export interface PathLeak {
  /** The original workspace path found in the text. */
  original: string;
  /** What it should have been (fork-relative). */
  corrected: string;
  /** Character position in the source text. */
  position: number;
}

/**
 * Scan text for workspace paths that should be fork paths.
 * Useful for detecting when an agent accidentally edits the wrong location.
 *
 * @param text — Text to scan (tool output, agent response, etc.)
 * @param repoRoot — Main workspace root
 * @param forkPath — Active fork path
 * @returns Array of detected leaks (empty if clean)
 */
export function detectPathLeakage(
  text: string,
  repoRoot: string,
  forkPath: string,
): PathLeak[] {
  const leaks: PathLeak[] = [];

  // Escape special regex chars in the repo root
  const escapedRoot = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match both forward and backslash separators
  const pattern = new RegExp(
    escapedRoot.replace(/\\\\/g, "[/\\\\]") + "[/\\\\]",
    "gi",
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    // Find the end of the path (next whitespace, quote, or end)
    const rest = text.substring(match.index);
    const pathEnd = rest.search(/[\s"'`\n\r,;)}\]>]/);
    const fullPath = pathEnd >= 0 ? rest.substring(0, pathEnd) : rest;

    // Skip if it's already a fork path
    if (isForkPath(fullPath, forkPath)) continue;

    // Skip if it's a .brain-forks path (expected)
    if (fullPath.includes(".brain-forks")) continue;

    const corrected = rewriteToFork(fullPath, repoRoot, forkPath);
    if (corrected !== fullPath) {
      leaks.push({
        original: fullPath,
        corrected,
        position: match.index,
      });
    }
  }

  if (leaks.length > 0) {
    logWarn(
      `[PathRewriter] ${leaks.length} path leak(s) detected — workspace paths used instead of fork`,
    );
  }

  return leaks;
}

/**
 * Format detected leaks into a warning string for injection into agent feedback.
 * Returns empty string if no leaks.
 */
export function formatLeakWarning(leaks: PathLeak[]): string {
  if (leaks.length === 0) return "";
  const lines = leaks
    .slice(0, 5)
    .map((l) => `  • ${l.original} → DEBERÍA SER ${l.corrected}`);
  if (leaks.length > 5) {
    lines.push(`  • ... y ${leaks.length - 5} más`);
  }
  return [
    "",
    "🚨 **PATH LEAKAGE DETECTADO** — Estás usando rutas del workspace principal en vez del fork:",
    ...lines,
    "Usa las rutas del fork para todas las operaciones de archivo.",
    "",
  ].join("\n");
}
