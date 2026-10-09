/**
 * Loop Config — Per-loop configuration persisted to `.project-brain/loops/{sessionId}/loop.config.json`.
 *
 * This is the **single source of truth** for all loop behavior:
 * - maxCycles, commitBypass, auditBypass, autoMigrate, etc.
 * - Created mechanically with defaults when a loop starts.
 * - Any runtime change (UI button, user override) writes back here.
 * - All consumers read from this file, not from in-memory state or VS Code settings.
 *
 * @module loop-config
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLoopDir as _getLoopDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";

// ——— Constants —————————————————————————————————————————————
const CONFIG_FILENAME = "loop.config.json";

// ——— Types ———————————————————————————————————————————————
/** Current config schema version. Bump when adding/changing fields. */
const CURRENT_SCHEMA_VERSION = 1;

export interface LoopConfig {
  /** Schema version for future migrations. */
  schemaVersion: number;
  /** Session identifier — matches the folder name. */
  sessionId: string;
  /** The loop's goal / objective. */
  goal: string;
  /** Max iterations before migration triggers. */
  maxCycles: number;
  /** Whether commit-gate validation is bypassed. */
  commitBypass: boolean;
  /** Whether audit-gate validation is bypassed. */
  auditBypass: boolean;
  /** Whether auto-migration is enabled when maxCycles is reached. */
  autoMigrate: boolean;
  /** Current iteration count — incremented each iteration, reset on migration. Source of truth for migration trigger. */
  currentLoopIterations: number;
  /** Original session ID when this loop was created as a reconnect/derivative loop. */
  sourceSessionId?: string;
  /** ISO timestamp when the config was created. */
  createdAt: string;
  /** ISO timestamp of the last config update. */
  updatedAt: string;
}

/** Partial config for updates — sessionId + createdAt are immutable. */
export type LoopConfigUpdate = Partial<
  Omit<LoopConfig, "sessionId" | "createdAt" | "schemaVersion">
>;

// ——— Path helpers ————————————————————————————————————————
function getRepoRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Get the per-session directory path. */
export function getLoopSessionDir(
  sessionId: string,
  repoRoot?: string,
): string | null {
  const root = repoRoot ?? getRepoRoot();
  if (!root) return null;
  return _getLoopDir(root, sessionId);
}

/** Get the config file path for a session. */
function getConfigPath(sessionId: string, repoRoot?: string): string | null {
  const dir = getLoopSessionDir(sessionId, repoRoot);
  if (!dir) return null;
  return path.join(dir, CONFIG_FILENAME);
}

// ——— Default factory ————————————————————————————————————
function getDefaultMaxCycles(): number {
  return vscode.workspace
    .getConfiguration("projectBrain")
    .get<number>("loop.maxCycles", 15);
}

/** Build a default config for a new loop session. */
function buildDefaultConfig(
  sessionId: string,
  goal: string,
  overrides?: LoopConfigUpdate,
): LoopConfig {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sessionId,
    goal,
    maxCycles: overrides?.maxCycles ?? getDefaultMaxCycles(),
    commitBypass: overrides?.commitBypass ?? false,
    auditBypass: overrides?.auditBypass ?? false,
    autoMigrate: overrides?.autoMigrate ?? true,
    currentLoopIterations: overrides?.currentLoopIterations ?? 0,
    sourceSessionId: overrides?.sourceSessionId,
    createdAt: now,
    updatedAt: now,
  };
}

// ——— CRUD ————————————————————————————————————————————————
/**
 * Create a loop config file with defaults.
 * Idempotent: if config already exists, returns existing config.
 */
export function createLoopConfig(
  sessionId: string,
  goal: string,
  overrides?: LoopConfigUpdate,
  repoRoot?: string,
): LoopConfig | null {
  const configPath = getConfigPath(sessionId, repoRoot);
  if (!configPath) {
    logWarn("[LoopConfig] No workspace root — cannot create config");
    return null;
  }

  // Idempotent: return existing if present
  if (fs.existsSync(configPath)) {
    const existing = readLoopConfig(sessionId, repoRoot);
    if (existing) return existing;
  }

  const dir = path.dirname(configPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const config = buildDefaultConfig(sessionId, goal, overrides);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    log(`[LoopConfig] Created config for session ${sessionId.substring(0, 8)}`);
    return config;
  } catch (err) {
    logError(`[LoopConfig] Failed to create config: ${err}`);
    return null;
  }
}

/**
 * Read the config file for a session.
 * Returns null if no config exists or on read error.
 */
export function readLoopConfig(
  sessionId: string,
  repoRoot?: string,
): LoopConfig | null {
  const configPath = getConfigPath(sessionId, repoRoot);
  if (!configPath || !fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as LoopConfig;
  } catch (err) {
    logError(`[LoopConfig] Failed to read config: ${err}`);
    return null;
  }
}

/**
 * Update specific fields in the config file.
 * Merges with existing config, updates `updatedAt`.
 * Returns the updated config or null on failure.
 */
export function updateLoopConfig(
  sessionId: string,
  updates: LoopConfigUpdate,
  repoRoot?: string,
): LoopConfig | null {
  const existing = readLoopConfig(sessionId, repoRoot);
  if (!existing) {
    logWarn(
      `[LoopConfig] Cannot update — no config for session ${sessionId.substring(0, 8)}`,
    );
    return null;
  }

  const updated: LoopConfig = {
    ...existing,
    ...updates,
    // Immutable fields
    schemaVersion: existing.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    sessionId: existing.sessionId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const configPath = getConfigPath(sessionId, repoRoot);
  if (!configPath) return null;

  try {
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), "utf-8");
    log(
      `[LoopConfig] Updated config for session ${sessionId.substring(0, 8)}: ${Object.keys(updates).join(", ")}`,
    );
    return updated;
  } catch (err) {
    logError(`[LoopConfig] Failed to update config: ${err}`);
    return null;
  }
}

/**
 * Get the effective maxCycles for a session.
 * Priority: config file > VS Code settings > default (15).
 */
export function getEffectiveMaxCycles(sessionId: string): number {
  const config = readLoopConfig(sessionId);
  if (config) return config.maxCycles;
  return getDefaultMaxCycles();
}

/**
 * Increment currentLoopIterations in the config file.
 * Returns the new iteration count, or -1 on failure.
 */
export function incrementLoopIterations(sessionId: string): number {
  const config = readLoopConfig(sessionId);
  if (!config) {
    logWarn(
      `[LoopConfig] Cannot increment iterations — no config for ${sessionId.substring(0, 8)}`,
    );
    return -1;
  }
  const next = (config.currentLoopIterations ?? 0) + 1;
  const updated = updateLoopConfig(sessionId, { currentLoopIterations: next });
  return updated ? next : -1;
}

/**
 * Reset currentLoopIterations to 0 in the config file.
 * Used when a migration spawns a new session.
 */
export function resetLoopIterations(sessionId: string): void {
  updateLoopConfig(sessionId, { currentLoopIterations: 0 });
}
