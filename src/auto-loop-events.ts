/**
 * auto-loop-events — Reactive state bridge for Auto Loop Bridge sessions.
 *
 * Same pattern as orchestration-state.ts / swarm-state.ts:
 * vscode.EventEmitter-based state that Brain HQ subscribes to for live UI.
 *
 * All state is keyed by sessionId via Map.
 */

import * as vscode from "vscode";
import { log } from "./logger";
import type {
  AutoLoopBridgeSessionState,
  BridgeEvent,
  BridgeEventType,
  BridgeSessionStatus,
  BridgeTokenBudget,
  PmChatMessage,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";

// ── State Store ──────────────────────────────────────────────────

const bridgeStates = new Map<string, AutoLoopBridgeSessionState>();

// ── Emitters ─────────────────────────────────────────────────────

const stateEmitter = new vscode.EventEmitter<AutoLoopBridgeSessionState>();
export const onDidChangeBridgeState = stateEmitter.event;

const eventEmitter = new vscode.EventEmitter<BridgeEvent>();
export const onDidEmitBridgeEvent = eventEmitter.event;

// ── Queries ──────────────────────────────────────────────────────

export function getBridgeState(
  sessionId: string
): AutoLoopBridgeSessionState | undefined {
  return bridgeStates.get(sessionId);
}

export function getAllBridgeStates(): Map<string, AutoLoopBridgeSessionState> {
  return bridgeStates;
}

export function getActiveBridgeSessions(): AutoLoopBridgeSessionState[] {
  return Array.from(bridgeStates.values()).filter(
    (s) => s.status !== "closed"
  );
}

// ── Mutations ────────────────────────────────────────────────────

export function setBridgeState(
  state: AutoLoopBridgeSessionState
): void {
  bridgeStates.set(state.sessionId, state);
  stateEmitter.fire(state);
}

export function updateBridgeStatus(
  sessionId: string,
  status: BridgeSessionStatus
): void {
  const state = bridgeStates.get(sessionId);
  if (!state) { return; }
  state.status = status;
  state.updatedAt = Date.now();
  stateEmitter.fire(state);
}

export function updateBridgeSynthesis(
  sessionId: string,
  synthesisId: string | null
): void {
  const state = bridgeStates.get(sessionId);
  if (!state) { return; }
  state.activeSynthesisId = synthesisId;
  state.updatedAt = Date.now();
  stateEmitter.fire(state);
}

export function updateBridgeFeedbackDraft(
  sessionId: string,
  text: string
): void {
  const state = bridgeStates.get(sessionId);
  if (!state) { return; }
  state.workerFeedbackDraft = text;
  state.updatedAt = Date.now();
  stateEmitter.fire(state);
}

export function updateBridgeBudget(
  sessionId: string,
  budget: Partial<BridgeTokenBudget>
): void {
  const state = bridgeStates.get(sessionId);
  if (!state) { return; }
  state.tokenBudget = { ...state.tokenBudget, ...budget };
  state.updatedAt = Date.now();
  stateEmitter.fire(state);
}

export function removeBridgeState(sessionId: string): void {
  bridgeStates.delete(sessionId);
}

// ── Event Publishing ─────────────────────────────────────────────

export function emitBridgeEvent(
  type: BridgeEventType,
  sessionId: string,
  payload: unknown
): void {
  const event: BridgeEvent = {
    type,
    sessionId,
    payload,
    timestamp: Date.now(),
  };
  log(`[BridgeEvents] ${type} for session ${sessionId}`);
  eventEmitter.fire(event);
}

// ── Dispose ──────────────────────────────────────────────────────

export function disposeBridgeEvents(): void {
  stateEmitter.dispose();
  eventEmitter.dispose();
  bridgeStates.clear();
}
