/**
 * opencode-persistence — CRUD for OpenCode loop state on disk.
 *
 * Mirrors the pattern of the Copilot loop persistence but is a NEW, separate
 * store under `.project-brain/opencode-loops/`. No imports from loop-engine.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { log, logWarn } from "../logger";
import type { OcLoopState } from "./opencode-types";

const STORE_DIR = join(".project-brain", "opencode-loops");

/** Absolute path to the store directory for a workspace. */
function storeDir(workspaceRoot: string): string {
  return join(workspaceRoot, STORE_DIR);
}

/** Absolute path to a single loop's JSON file. */
function loopFile(workspaceRoot: string, sessionId: string): string {
  return join(storeDir(workspaceRoot), `${sanitize(sessionId)}.json`);
}

/** Strip path separators so a sessionId can never escape the store dir. */
function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Ensure the store directory exists. Safe to call repeatedly. */
export function initOcPersistence(workspaceRoot: string): void {
  const dir = storeDir(workspaceRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`[OpenCode] created loop store at ${dir}`);
  }
}

/** Write a loop's state to disk (overwrites). */
export function persistOcLoop(workspaceRoot: string, state: OcLoopState): void {
  initOcPersistence(workspaceRoot);
  const file = loopFile(workspaceRoot, state.sessionId);
  try {
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logWarn(`[OpenCode] failed to persist loop ${state.sessionId}: ${(err as Error).message}`);
  }
}

/** Read a single loop's state, or undefined if missing/corrupt. */
export function getOcLoop(workspaceRoot: string, sessionId: string): OcLoopState | undefined {
  const file = loopFile(workspaceRoot, sessionId);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OcLoopState;
  } catch (err) {
    logWarn(`[OpenCode] corrupt loop file ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Read all persisted loops (skips corrupt files). */
export function getAllOcLoops(workspaceRoot: string): OcLoopState[] {
  const dir = storeDir(workspaceRoot);
  if (!existsSync(dir)) {
    return [];
  }
  const out: OcLoopState[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as OcLoopState);
    } catch (err) {
      logWarn(`[OpenCode] skipping corrupt loop file ${name}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a loop's persisted state. Idempotent. */
export function clearOcLoop(workspaceRoot: string, sessionId: string): void {
  const file = loopFile(workspaceRoot, sessionId);
  try {
    rmSync(file, { force: true });
  } catch (err) {
    logWarn(`[OpenCode] failed to clear loop ${sessionId}: ${(err as Error).message}`);
  }
}
