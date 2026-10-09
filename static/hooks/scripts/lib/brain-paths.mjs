/**
 * brain-paths.mjs — Centralized path constants for hook scripts.
 * ESM mirror of src/brain-paths.ts. Single source of truth for
 * .project-brain/ paths in hook code.
 */
import { existsSync } from "fs";
import { join } from "path";

export const PROJECT_BRAIN_DIR = ".project-brain";
export const LOOPS_SUBDIR = "loops";
export const MEMORY_SUBDIR = "memory";
export const LEGACY_LOOPS_DIR = ".brain-loops";
export const LEGACY_MEMORY_DIR = "docs/memory";

/** Get the root .project-brain/ directory */
export function getProjectBrainDir(wsRoot) {
  return join(wsRoot, PROJECT_BRAIN_DIR);
}

/** Get .project-brain/loops/ directory */
export function getLoopsDir(wsRoot) {
  return join(wsRoot, PROJECT_BRAIN_DIR, LOOPS_SUBDIR);
}

/** Get .project-brain/loops/{sessionId}/ directory */
export function getLoopDir(wsRoot, sessionId) {
  return join(wsRoot, PROJECT_BRAIN_DIR, LOOPS_SUBDIR, sessionId);
}

/** Get .project-brain/memory/ directory */
export function getMemoryDir(wsRoot) {
  return join(wsRoot, PROJECT_BRAIN_DIR, MEMORY_SUBDIR);
}

/**
 * Fallback: if .project-brain/loops/ doesn't exist but .brain-loops/ does,
 * use .brain-loops/ for backward compatibility.
 */
export function getLoopsDirWithFallback(wsRoot) {
  const newDir = getLoopsDir(wsRoot);
  if (existsSync(newDir)) return newDir;
  const legacyDir = join(wsRoot, LEGACY_LOOPS_DIR);
  if (existsSync(legacyDir)) return legacyDir;
  return newDir;
}

/**
 * Fallback: if .project-brain/memory/ doesn't exist but docs/memory/ does,
 * use docs/memory/ for backward compatibility.
 */
export function getMemoryDirWithFallback(wsRoot) {
  const newDir = getMemoryDir(wsRoot);
  if (existsSync(newDir)) return newDir;
  const legacyDir = join(wsRoot, LEGACY_MEMORY_DIR);
  if (existsSync(legacyDir)) return legacyDir;
  return newDir;
}
