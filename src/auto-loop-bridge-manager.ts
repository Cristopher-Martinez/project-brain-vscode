/**
 * auto-loop-bridge-manager — Top-level coordinator for Auto Loop Bridge sessions.
 *
 * Responsibilities:
 *  - Create/close/recover bridge sessions
 *  - Maintain active sessions map
 *  - Expose snapshots to webview
 *  - Route session-level operations
 *  - Register Gemini strategy at init
 *
 * One global instance, initialized at extension activation.
 */

import { log, logError, logWarn } from "./logger";
import { saveBridgeSnapshot, loadBridgeSnapshot, listPersistedBridgeSessions, deleteBridgeSnapshot } from "./bridge-session-state-store";
import type {
  AutoLoopBridgeSessionView,
  BridgeSynthesis,
  PMProviderConfig,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";
import {
  emitBridgeEvent,
  getActiveBridgeSessions,
  getAllBridgeStates,
  removeBridgeState,
  disposeBridgeEvents,
} from "./auto-loop-events";
import {
  AutoLoopBridgeSession,
  type BridgeSessionConfig,
} from "./auto-loop-bridge-session";
import {
  registerStrategy,
  getRegisteredCount,
  getDefaultModelForProvider,
} from "./pm-provider-registry";
import { geminiStrategy } from "./pm-gemini-strategy";
import { openrouterStrategy } from "./pm-openrouter-strategy";
import {
  loadHistoryAsBridgeSyntheses,
  queryLoopHistory,
  buildHistorySummaryChunks,
} from "./loop-history-rag";
import { resolveBridgeLinkedLoopIds } from "./bridge-loop-state-resolver";
import * as vscode from "vscode";

// ── Session Map ──────────────────────────────────────────────────

const sessions = new Map<string, AutoLoopBridgeSession>();

/** Pre-cached history summary chunks per bridge session. */
const historyCache = new Map<string, string[]>();

// ── Initialization ───────────────────────────────────────────────

let initialized = false;

/**
 * Initialize the bridge manager. Registers default PM providers.
 * Safe to call multiple times — idempotent.
 */
export function initBridgeManager(): void {
  if (initialized) { return; }

  if (getRegisteredCount() === 0) {
    registerStrategy(geminiStrategy);
    registerStrategy(openrouterStrategy);
  }

  initialized = true;
  log("[BridgeManager] Initialized with default providers");
}


export function recoverBridgeSessions(repoRoot: string): number {
  initBridgeManager();
  const ids = listPersistedBridgeSessions(repoRoot);
  let restored = 0;
  for (const id of ids) {
    if (sessions.has(id)) { continue; }
    const snap = loadBridgeSnapshot(repoRoot, id);
    if (!snap || snap.state.status === "closed") { deleteBridgeSnapshot(repoRoot, id); continue; }
    const config: BridgeSessionConfig = { sessionId: id, title: snap.state.title, workerLoopSessionId: snap.state.workerLoopSessionId, pmProviderId: snap.state.pmProviderId, pmModelId: snap.state.pmModelId, pmProviderConfig: snap.pmProviderConfig, repoRoot, objective: snap.taskMemory.objective, identityPrompt: snap.identityPrompt };
    const session = new AutoLoopBridgeSession(config);
    session.restoreFromSnapshot(snap);
    // Normalize model ID for provider (migration for pre-fix snapshots)
    const expectedDefault = getDefaultModelForProvider(snap.state.pmProviderId);
    if (snap.state.pmProviderId === "openrouter" && snap.state.pmModelId && !snap.state.pmModelId.includes("/")) {
      session.setModel(expectedDefault);
    }
    // Populate the model list from the provider strategy
    session.refreshAvailableModels().catch(() => {});
    sessions.set(id, session);
    restored++;
    log(`[BridgeManager] Recovered session: ${id}`);
  }
  return restored;
}

// ── Session CRUD ─────────────────────────────────────────────────

export interface CreateBridgeSessionOpts {
  title: string;
  workerLoopSessionId: string;
  pmProviderId?: string;
  pmModelId?: string;
  pmProviderConfig: PMProviderConfig;
  repoRoot: string;
  objective: string;
  identityPrompt?: string;
}

/**
 * Create a new bridge session (room).
 */
export function createBridgeSession(
  opts: CreateBridgeSessionOpts
): AutoLoopBridgeSession {
  initBridgeManager();

  const sessionId = generateSessionId();
  const config: BridgeSessionConfig = {
    sessionId,
    title: opts.title,
    workerLoopSessionId: opts.workerLoopSessionId,
    pmProviderId: opts.pmProviderId ?? "gemini",
    pmModelId: opts.pmModelId ?? "gemini-2.5-flash",
    pmProviderConfig: opts.pmProviderConfig,
    repoRoot: opts.repoRoot,
    objective: opts.objective,
    identityPrompt: opts.identityPrompt,
  };

  const session = new AutoLoopBridgeSession(config);
  sessions.set(sessionId, session);

  // Populate the model list from the provider strategy
  session.refreshAvailableModels().catch(() => {});

  // Pre-cache loop history summary for RAG grounding
  const summaryChunks = buildHistorySummaryChunks(
    opts.workerLoopSessionId,
    3,
    opts.repoRoot,
  );
  if (summaryChunks.length > 0) {
    historyCache.set(sessionId, summaryChunks);
    log(`[BridgeManager] Pre-cached ${summaryChunks.length} history chunks for bridge ${sessionId}`);
  }


  // Pre-load historical syntheses from loop history
  const historicalSyntheses = loadHistoryAsBridgeSyntheses(
    opts.workerLoopSessionId,
    opts.repoRoot,
  );
  if (historicalSyntheses.length > 0) {
    session.bulkLoadSyntheses(historicalSyntheses);
    log(`[BridgeManager] Pre-loaded ${historicalSyntheses.length} historical syntheses for bridge ${sessionId}`);
  }
  log(`[BridgeManager] Session created: ${sessionId} — "${opts.title}"`);
  return session;
}

/**
 * Get a session by ID.
 */
export function getBridgeSession(
  sessionId: string
): AutoLoopBridgeSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Close a bridge session.
 */
export function closeBridgeSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    logWarn(`[BridgeManager] Session not found: ${sessionId}`);
    return false;
  }

    try { saveBridgeSnapshot(session.rootPath, session.toSnapshot()); } catch (_) { /* best-effort */ }
  session.close();
  sessions.delete(sessionId);
  historyCache.delete(sessionId);
  removeBridgeState(sessionId);
  log(`[BridgeManager] Session closed and removed: ${sessionId}`);
  return true;
}

// ── Session Operations (delegated) ───────────────────────────────

/**
 * Add a worker synthesis to a bridge session.
 */
export function addSynthesisToBridge(
  sessionId: string,
  synthesis: BridgeSynthesis
): boolean {
  const session = sessions.get(sessionId);
  if (!session) { return false; }
  session.addSynthesis(synthesis);
  return true;
}

/**
 * Select active synthesis for PM discussion.
 */
export function selectBridgeSynthesis(
  sessionId: string,
  synthesisId: string
): boolean {
  const session = sessions.get(sessionId);
  if (!session) { return false; }
  session.setActiveSynthesis(synthesisId);
  return true;
}

/**
 * Change PM model for a running Bridge session.
 */
export function setBridgeSessionModel(
  sessionId: string,
  modelId: string,
  synthesisId?: string,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) { return false; }
  session.setModel(modelId, synthesisId);
  return true;
}

/**
 * Send a PM Chat message.
 */
export async function sendBridgePmChat(
  sessionId: string,
  synthesisId: string,
  text: string,
  retrievalChunks?: string[]
): Promise<PmSuggestionResult | null> {
  const session = sessions.get(sessionId);
  if (!session) {
    logWarn(`[BridgeManager] PM Chat: session not found ${sessionId}`);
    return null;
  }

  // Auto-enrich with loop history RAG
  const enriched = enrichWithHistoryRag(sessionId, session, text, retrievalChunks);
  return session.sendPmChat(synthesisId, text, enriched);
}

/**
 * Enrich retrieval chunks with loop history context.
 * Merges pre-cached summaries + query-specific chunks from history RAG.
 */
function enrichWithHistoryRag(
  sessionId: string,
  session: AutoLoopBridgeSession,
  userMessage: string,
  existingChunks?: string[],
): string[] {
  const base = existingChunks ? [...existingChunks] : [];
  const state = session.getState();

  // Add pre-cached summary chunks (baseline context)
  const cached = historyCache.get(sessionId);
  if (cached) {
    base.push(...cached);
  }

  // Query-specific retrieval from loop history
  const ragResult = queryLoopHistory(
    state.workerLoopSessionId,
    userMessage,
    3,
    session.rootPath,
  );
  for (const chunk of ragResult.chunks) {
    base.push(`[History R${chunk.round} ${chunk.type}]: ${chunk.content}`);
  }

  if (base.length > 0) {
    log(`[BridgeManager] RAG enriched: ${base.length} chunks (${cached?.length ?? 0} cached + ${ragResult.chunks.length} query-matched)`);
  }

  return base;
}

/**
 * Promote a PM suggestion to worker feedback draft.
 */
export function promoteBridgeSuggestion(
  sessionId: string,
  suggestionId: string
): boolean {
  const session = sessions.get(sessionId);
  if (!session) { return false; }
  return session.promoteSuggestionToFeedback(suggestionId);
}

/**
 * Update worker feedback draft text.
 */
export function updateBridgeFeedbackDraft(
  sessionId: string,
  text: string
): void {
  const session = sessions.get(sessionId);
  if (!session) { return; }
  session.setWorkerFeedbackDraft(text);
}

/**
 * Dispatch the current feedback draft to the worker loop.
 * Returns the dispatched text or null if blocked.
 */
export function dispatchBridgeFeedback(
  sessionId: string
): string | null {
  const session = sessions.get(sessionId);
  if (!session) { return null; }
  return session.dispatchWorkerFeedback();
}

// ── Synthesis Interception ────────────────────────────────────────

/**
 * Push a loop synthesis into any bridge session connected to that loop.
 * Called from lm-tools-loop when loopAwaitInput fires.
 * Returns the bridge session ID and synthesis ID if matched, null otherwise.
 */
export function pushSynthesisToConnectedBridges(
  loopSessionId: string,
  content: string,
  round: number,
): { bridgeId: string; synthesisId: string } | null {
  // Auto-recover persisted sessions if map is empty (race: synthesis arrives before HQ opens)
  if (sessions.size === 0) {
    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (repoRoot) {
      const recovered = recoverBridgeSessions(repoRoot);
      if (recovered > 0) {
        log(`[BridgeManager] Auto-recovered ${recovered} sessions for synthesis push`);
      }
    }
  }

  const linkedLoopIds = new Set(resolveBridgeLinkedLoopIds(loopSessionId));

  for (const [bridgeId, session] of sessions.entries()) {
    const st = session.getState();
    if (linkedLoopIds.has(st.workerLoopSessionId) && st.status !== "closed") {
      const synthesis: BridgeSynthesis = {
        synthesisId: `synth_${Date.now()}_${round}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: bridgeId,
        content,
        round,
        timestamp: Date.now(),
      };
      session.addSynthesis(synthesis);
      emitBridgeEvent("synthesis_pushed", bridgeId, { synthesisId: synthesis.synthesisId, round });
      log(`[BridgeManager] Pushed synthesis round ${round} to bridge ${bridgeId} (loop=${loopSessionId.slice(0, 8)})`);
      return { bridgeId, synthesisId: synthesis.synthesisId };
    }
  }
  return null;
}

// ── Snapshots for Webview ────────────────────────────────────────

/**
 * Get all sessions as serializable view models for the webview.
 */
export function getAllBridgeSessionViews(): AutoLoopBridgeSessionView[] {
  return Array.from(sessions.values()).map((s) => s.toView());
}

/**
 * Get a single session view by ID.
 */
export function getBridgeSessionView(
  sessionId: string
): AutoLoopBridgeSessionView | undefined {
  return sessions.get(sessionId)?.toView();
}

/**
 * Get count of active (non-closed) sessions.
 */
export function getActiveBridgeSessionCount(): number {
  return getActiveBridgeSessions().length;
}

export function updateBridgeWorkerLoopSessionId(
  bridgeSessionId: string,
  newLoopId: string,
): boolean {
  const session = sessions.get(bridgeSessionId);
  if (!session) return false;
  session.updateWorkerLoopSessionId(newLoopId);
  return true;
}

// ── Lifecycle ────────────────────────────────────────────────────

/**
 * Dispose all sessions and clean up. Called on extension deactivation.
 */
export function disposeBridgeManager(): void {
  for (const session of sessions.values()) {
    session.close();
  }
  sessions.clear();
  disposeBridgeEvents();
  initialized = false;
  log("[BridgeManager] Disposed");
}

// ── Helpers ──────────────────────────────────────────────────────

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `bridge_${ts}_${rand}`;
}
