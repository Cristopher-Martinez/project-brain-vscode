/**
 * Loop Persistence — Survives extension restarts via VS Code workspaceState.
 *
 * Only stores metadata (goal, iteration count, startedAt) — not runtime Promises.
 * Used by loop-engine.ts to hydrate loopStates on activation + offer reconnection.
 * NOTE: Uses workspaceState (not globalState) to isolate loops per workspace.
 */

import type * as vscode from "vscode";
import { log } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Serializable iteration snapshot — mirrors LoopIteration without runtime deps. */
export interface PersistedIteration {
  index: number;
  prompt: string;
  synthesis?: string;
  feedback?: string;
  startedAt: number;
  completedAt?: number;
}

export interface PersistedLoopSession {
  sessionId: string;
  goal: string;
  iterationCount: number;
  startedAt: number;
  persistedAt: number;
  /** Full iteration history for lossless reconnect (v2). Optional for backward compat. */
  iterations?: PersistedIteration[];
  /** State at time of persistence. */
  state?: "spawning" | "active" | "awaiting" | "completed" | "disconnected";
  /** Pending synthesis if agent was awaiting feedback. */
  pendingSynthesis?: string;
  /** Whether the loop was waiting for user feedback. */
  awaitingFeedback?: boolean;
  /** User-configured max iterations. */
  maxCycles?: number;
  /** Workspace root path — for defensive filtering when isolating loops per repo. */
  wsRoot?: string;
}

/**
 * Build a human-readable summary from persisted data for agent context injection.
 */
export function buildReconnectSummary(session: PersistedLoopSession): string {
  const parts: string[] = [];
  parts.push(`**Objetivo**: ${session.goal}`);
  parts.push(
    `**Iteraciones completadas**: ${session.iterations?.length ?? session.iterationCount}`,
  );
  parts.push(`**Estado al persistir**: ${session.state ?? "unknown"}`);

  // Point reconnecting agent to the full disk-based history
  parts.push(
    `**Historial completo de iteraciones**: \`.project-brain/loops/${session.sessionId}/history.json\` — Lee este archivo para obtener el contexto completo de todas las rondas (síntesis + feedback).`,
  );

  if (session.pendingSynthesis) {
    parts.push(
      `**Síntesis pendiente**: ${session.pendingSynthesis.substring(0, 300)}`,
    );
  }

  const iters = session.iterations ?? [];
  const lastIter = iters[iters.length - 1];
  if (lastIter) {
    if (lastIter.synthesis) {
      parts.push(
        `**Última síntesis (ronda ${lastIter.index})**: ${lastIter.synthesis.substring(0, 300)}`,
      );
    }
    if (lastIter.feedback) {
      parts.push(`**Último feedback**: ${lastIter.feedback.substring(0, 300)}`);
    }
  }

  return parts.join("\n");
}

// ─── State ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "projectBrain.loopSessions";
let memento: vscode.Memento | undefined;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initLoopPersistence(ctx: vscode.Memento): void {
  memento = ctx;
  log("[LoopPersistence] initialized");
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Persist a loop session to Memento. Returns a Promise so callers can
 * optionally await for guaranteed write (critical paths like loopStart).
 * Fire-and-forget usage is still safe for non-critical paths.
 */
export function persistLoopSession(
  session: PersistedLoopSession,
): Promise<void> {
  if (!memento) {
    log("[LoopPersistence] WARN: memento not initialized, persist skipped");
    return Promise.resolve();
  }
  const all = getAllPersistedSessions();
  all[session.sessionId] = session;
  return Promise.resolve(memento.update(STORAGE_KEY, all)).then(
    () => log(`[LoopPersistence] persisted sessionId=${session.sessionId}`),
    (err: unknown) => log(`[LoopPersistence] persist error: ${err}`),
  );
}

export function clearPersistedSession(sessionId: string): Promise<void> {
  if (!memento) return Promise.resolve();
  const all = getAllPersistedSessions();
  delete all[sessionId];
  return Promise.resolve(memento.update(STORAGE_KEY, all)).then(
    () => log(`[LoopPersistence] cleared sessionId=${sessionId}`),
    (err: unknown) => log(`[LoopPersistence] clear error: ${err}`),
  );
}

export function getPersistedSession(
  sessionId: string,
): PersistedLoopSession | undefined {
  return getAllPersistedSessions()[sessionId];
}

export function getAllPersistedSessions(): Record<
  string,
  PersistedLoopSession
> {
  if (!memento) return {};
  return memento.get<Record<string, PersistedLoopSession>>(STORAGE_KEY) ?? {};
}
