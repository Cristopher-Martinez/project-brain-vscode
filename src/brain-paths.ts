/**
 * brain-paths Ã¢â‚¬â€ Centralized path constants for .project-brain/
 *
 * Single source of truth for ALL internal paths used by the extension.
 * Previously scattered across 29+ files as hardcoded strings.
 *
 * Structure:
 *   .project-brain/
 *   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ memory/          Ã¢â€ Â Knowledge base (committed: *.md + plans/)
 *   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ loops/           Ã¢â€ Â Loop data (gitignored)
 *   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ analysis/        Ã¢â€ Â Self-learning analysis (gitignored)
 *   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ repos/           Ã¢â€ Â Cloned repos for analysis (gitignored)
 *   Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ self-learning.sqlite
 */

import * as fs from "fs";
import * as path from "path";

// Ã¢â€â‚¬Ã¢â€â‚¬ Root Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/** Root folder for all Project Brain internal data */
export const PROJECT_BRAIN_DIR = ".project-brain";

// Ã¢â€â‚¬Ã¢â€â‚¬ Memory Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/** Subfolder for knowledge base (was docs/memory/) */
export const MEMORY_SUBDIR = "memory";

/** Legacy memory path (for fallback) */
export const LEGACY_MEMORY_DIR = "docs/memory";

// Ã¢â€â‚¬Ã¢â€â‚¬ Loops Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/** Subfolder for loop data (was .brain-loops/) */
export const LOOPS_SUBDIR = "loops";

/** Legacy loops path (for fallback) */
export const LEGACY_LOOPS_DIR = ".brain-loops";

/** Subfolder for hibernated loops */
export const HIBERNATED_SUBDIR = "hibernated";

/** Subfolder for finalized loops */
export const FINALIZED_SUBDIR = "finalized";

/** Subfolder for shadow worktrees */
export const SHADOW_SUBDIR = ".shadow";

// Ã¢â€â‚¬Ã¢â€â‚¬ Analysis Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/** Subfolder for self-learning analysis */
export const ANALYSIS_SUBDIR = "analysis";

/** Subfolder for cloned repos */
export const REPOS_SUBDIR = "repos";

// Ã¢â€â‚¬Ã¢â€â‚¬ Path Builders Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Get the root .project-brain/ path for a workspace.
 */
export function getProjectBrainDir(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_BRAIN_DIR);
}

/**
 * Get the memory directory path.
 * Default: .project-brain/memory/
 */
export function getMemoryDir(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_BRAIN_DIR, MEMORY_SUBDIR);
}

/**
 * Get the loops directory path.
 * Default: .project-brain/loops/
 */
export function getLoopsDir(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_BRAIN_DIR, LOOPS_SUBDIR);
}

/**
 * Get a specific loop's directory.
 */
export function getLoopDir(repoRoot: string, sessionId: string): string {
  return path.join(getLoopsDir(repoRoot), sessionId);
}

/**
 * Get the conversation log path for a bridge session.
 * Default: .project-brain/loops/{sessionId}/conversation.json
 */
export function getBridgeStatePath(repoRoot: string, sessionId: string): string {
  return path.join(getLoopDir(repoRoot, sessionId), "bridge-state.json");
}

export function getConversationPath(repoRoot: string, sessionId: string): string {
  return path.join(getLoopDir(repoRoot, sessionId), "conversation.json");
}

/**
 * Get the hibernated loops directory.
 */
export function getHibernatedDir(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), HIBERNATED_SUBDIR);
}

/**
 * Get the finalized loops directory.
 */
export function getFinalizedDir(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), FINALIZED_SUBDIR);
}

/**
 * Get the shadow worktree directory.
 */
export function getShadowDir(repoRoot: string): string {
  return path.join(getLoopsDir(repoRoot), SHADOW_SUBDIR);
}

/**
 * Get the analysis directory.
 */
export function getAnalysisDir(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_BRAIN_DIR, ANALYSIS_SUBDIR);
}

/**
 * Get the repos directory.
 */
export function getReposDir(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_BRAIN_DIR, REPOS_SUBDIR);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Fallback Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Get memory dir with legacy fallback.
 * If .project-brain/memory/ doesn't exist but docs/memory/ does,
 * use the legacy path for backward compatibility.
 */
export function getMemoryDirWithFallback(repoRoot: string): string {
  const newPath = getMemoryDir(repoRoot);
  if (fs.existsSync(newPath)) {
    return newPath;
  }
  const oldPath = path.join(repoRoot, LEGACY_MEMORY_DIR);
  if (fs.existsSync(oldPath)) {
    return oldPath;
  }
  return newPath; // Default to new path
}

/**
 * Get loops dir with legacy fallback.
 * If .project-brain/loops/ doesn't exist but .brain-loops/ does,
 * use the legacy path for backward compatibility.
 */
export function getLoopsDirWithFallback(repoRoot: string): string {
  const newPath = getLoopsDir(repoRoot);
  if (fs.existsSync(newPath)) {
    return newPath;
  }
  const oldPath = path.join(repoRoot, LEGACY_LOOPS_DIR);
  if (fs.existsSync(oldPath)) {
    return oldPath;
  }
  return newPath; // Default to new path
}

/**
 * Check if legacy paths exist (for migration detection).
 */
export function hasLegacyPaths(repoRoot: string): {
  legacyMemory: boolean;
  legacyLoops: boolean;
  legacyHooks: boolean;
} {
  return {
    legacyMemory: fs.existsSync(path.join(repoRoot, LEGACY_MEMORY_DIR)),
    legacyLoops: fs.existsSync(path.join(repoRoot, LEGACY_LOOPS_DIR)),
    legacyHooks: fs.existsSync(path.join(repoRoot, ".github", "hooks", "scripts")),
  };
}

/**
 * Ensure the .project-brain/ directory structure exists.
 * Creates: .project-brain/, .project-brain/loops/, .project-brain/memory/
 */
export function ensureProjectBrainDirs(repoRoot: string): void {
  const dirs = [
    getProjectBrainDir(repoRoot),
    getLoopsDir(repoRoot),
    getMemoryDir(repoRoot),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Migrate content from legacy paths (docs/memory, .brain-loops) to .project-brain/.
 * Only copies files that don't already exist in the new location.
 * Called once on activation Ã¢â‚¬â€ safe to call multiple times (idempotent).
 */
export function migrateFromLegacyPaths(repoRoot: string): {
  migratedMemory: boolean;
  migratedLoops: boolean;
  migratedHooks: boolean;
} {
  const result = { migratedMemory: false, migratedLoops: false, migratedHooks: false };
  const legacy = hasLegacyPaths(repoRoot);

  // Migrate docs/memory/ Ã¢â€ â€™ .project-brain/memory/
  if (legacy.legacyMemory) {
    const newDir = getMemoryDir(repoRoot);
    const oldDir = path.join(repoRoot, LEGACY_MEMORY_DIR);
    const marker = path.join(newDir, "BOOT.md");
    if (!fs.existsSync(marker)) {
      copyDirContents(oldDir, newDir);
      result.migratedMemory = true;
    }
  }

  // Migrate .brain-loops/ Ã¢â€ â€™ .project-brain/loops/
  if (legacy.legacyLoops) {
    const newDir = getLoopsDir(repoRoot);
    const oldDir = path.join(repoRoot, LEGACY_LOOPS_DIR);
    const contents = safeReaddir(newDir);
    if (contents.length === 0) {
      copyDirContents(oldDir, newDir);
      result.migratedLoops = true;
    }
  }
  // Migrate .github/hooks/scripts/ → .project-brain/hooks/scripts/
  if (legacy.legacyHooks) {
    const newHooksDir = path.join(getProjectBrainDir(repoRoot), "hooks", "scripts");
    const oldHooksDir = path.join(repoRoot, ".github", "hooks", "scripts");
    if (!fs.existsSync(newHooksDir) || safeReaddir(newHooksDir).length === 0) {
      fs.mkdirSync(newHooksDir, { recursive: true });
      copyDirContents(oldHooksDir, newHooksDir);
      result.migratedHooks = true;
    }
  }
  return result;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Internal Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function copyDirContents(src: string, dest: string): void {
  const entries = safeReaddir(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (!fs.existsSync(destPath)) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    }
  }
}
