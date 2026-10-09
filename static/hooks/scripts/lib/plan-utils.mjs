/**
 * Shared plan cache reader for Claude Code hooks.
 * Reads .plan-cache.json written by the VS Code extension.
 * Returns "free" if cache missing, corrupt, or unreadable.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export function readPlanCache(memDir) {
  try {
    const cachePath = join(memDir, "sessions", ".plan-cache.json");
    if (existsSync(cachePath)) {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      return (data.plan || "free").toLowerCase();
    }
  } catch { /* fallback */ }
  return "free";
}
