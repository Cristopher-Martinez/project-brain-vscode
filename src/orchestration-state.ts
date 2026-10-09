/**
 * Orchestration State  Reactive state bridge for orchestration sessions.
 *
 * Same pattern as swarm-state.ts: EventEmitter-based state that
 * Brain HQ can subscribe to for live UI updates.
 *
 * MULTI-SESSION: All state is keyed by sessionId via Maps.
 */

import * as vscode from "vscode";
import type { ModelTier } from "./model-router-types";
import type { PlanApprovalManager, PlanApprovalRequest } from "./plan-approval";
import type { MailboxMessage, MailboxStats } from "./swarm-mailbox";

//  Types 

export interface OrchAgentSlot {
  agentId: string;
  agentName: string;
  agentIcon: string;
  modelId: string;
  tier: ModelTier;
}

export interface OrchWorkerState {
  agentId: string;
  agentName: string;
  agentIcon: string;
  taskId: string;
  message?: string;
  success?: boolean;
  error?: string;
  model?: string;
  tier?: string;
  rounds?: number;
  toolCalls?: number;
  durationMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface OrchRoundState {
  roundNumber: number;
  launchedAt: number;
  completedAt?: number;
  workers: OrchWorkerState[];
  durationMs?: number;
}

export interface OrchUiState {
  sessionId: string | null;
  state: "idle" | "planning" | "active" | "paused" | "completed";
  goal?: string;
  mode?: "parallel" | "sequential";
  team: OrchAgentSlot[];
  currentRound?: OrchRoundState;
  completedRounds: OrchRoundState[];
  startedAt?: number;
  updatedAt: number;
  summary?: string;
  totalTokensIn: number;
  totalTokensOut: number;
  workerLogs: Record<string, string>;
  pendingSynthesis?: string;
  awaitingFeedback: boolean;
  mailboxMessages: MailboxMessage[];
  mailboxStats?: MailboxStats;
  pendingPlanApprovals: PlanApprovalRequest[];
  originalPrompt?: string;
  enhancedPrompt?: string;
}
//  State + Emitter 

const orchStates = new Map<string, OrchUiState>();

const orchEmitter = new vscode.EventEmitter<OrchUiState>();
export const onDidChangeOrchState = orchEmitter.event;

function defaultState(): OrchUiState {
  return {
    sessionId: null,
    state: "idle",
    team: [],
    completedRounds: [],
    updatedAt: Date.now(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    workerLogs: {},
    awaitingFeedback: false,
    mailboxMessages: [],
    pendingPlanApprovals: [],
  };
}

export function getOrchState(sessionId: string): OrchUiState {
  return orchStates.get(sessionId) || defaultState();
}

export function getAllOrchStates(): Map<string, OrchUiState> {
  return orchStates;
}

function setState(sessionId: string, next: OrchUiState): void {
  orchStates.set(sessionId, next);
  orchEmitter.fire(next);
}

//  State Mutators 

export function orchSessionCreate(sessionId: string, opts: {
  goal: string;
  team: OrchAgentSlot[];
  mode?: "parallel" | "sequential";
}): void {
  setState(sessionId, {
    sessionId,
    state: "planning",
    goal: opts.goal,
    mode: opts.mode || "parallel",
    team: opts.team,
    currentRound: undefined,
    completedRounds: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    summary: undefined,
    totalTokensIn: 0,
    totalTokensOut: 0,
    workerLogs: {},
    awaitingFeedback: false,
    mailboxMessages: [],
    pendingPlanApprovals: [],
  });
}

export function orchSetPromptEnhancement(
  sessionId: string,
  original: string,
  enhanced: string,
): void {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    originalPrompt: original,
    enhancedPrompt: enhanced,
    updatedAt: Date.now(),
  });
}
//  Throttled Worker Log Updates 
const workerLogBuffers = new Map<string, Record<string, string>>();
const workerLogFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const WORKER_LOG_THROTTLE_MS = 150;

function flushWorkerLogs(sessionId: string): void {
  workerLogFlushTimers.delete(sessionId);
  const buffer = workerLogBuffers.get(sessionId);
  if (!buffer || Object.keys(buffer).length === 0) return;
  const pending = { ...buffer };
  workerLogBuffers.set(sessionId, {});
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    workerLogs: { ...s.workerLogs, ...pending },
    updatedAt: Date.now(),
  });
}

export function orchSetWorkerLog(sessionId: string, taskId: string, text: string): void {
  let buffer = workerLogBuffers.get(sessionId);
  if (!buffer) { buffer = {}; workerLogBuffers.set(sessionId, buffer); }
  buffer[taskId] = text;
  if (!workerLogFlushTimers.has(sessionId)) {
    workerLogFlushTimers.set(sessionId, setTimeout(() => flushWorkerLogs(sessionId), WORKER_LOG_THROTTLE_MS));
  }
}

export function orchFlushWorkerLogs(sessionId: string): void {
  const timer = workerLogFlushTimers.get(sessionId);
  if (timer) { clearTimeout(timer); workerLogFlushTimers.delete(sessionId); }
  flushWorkerLogs(sessionId);
}

export function orchRoundStart(sessionId: string, opts: {
  roundNumber: number;
  workers: OrchWorkerState[];
}): void {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    state: "active",
    updatedAt: Date.now(),
    currentRound: {
      roundNumber: opts.roundNumber,
      launchedAt: Date.now(),
      workers: opts.workers,
    },
  });
}

export function orchWorkerProgress(sessionId: string, taskId: string, message: string): void {
  const s = getOrchState(sessionId);
  if (!s.currentRound) return;
  const workers = s.currentRound.workers.map((w) =>
    w.taskId === taskId ? { ...w, message } : w,
  );
  setState(sessionId, {
    ...s,
    updatedAt: Date.now(),
    currentRound: { ...s.currentRound, workers },
  });
}

export function orchWorkerComplete(sessionId: string, worker: OrchWorkerState): void {
  const s = getOrchState(sessionId);
  if (!s.currentRound) return;
  const workers = s.currentRound.workers.map((w) =>
    w.taskId === worker.taskId ? worker : w,
  );
  setState(sessionId, {
    ...s,
    updatedAt: Date.now(),
    totalTokensIn: s.totalTokensIn + (worker.estimatedInputTokens || 0),
    totalTokensOut: s.totalTokensOut + (worker.estimatedOutputTokens || 0),
    currentRound: { ...s.currentRound, workers },
  });
}

export function orchRoundComplete(sessionId: string): void {
  const s = getOrchState(sessionId);
  if (!s.currentRound) return;
  const completedRound: OrchRoundState = {
    ...s.currentRound,
    completedAt: Date.now(),
    durationMs: Date.now() - s.currentRound.launchedAt,
  };
  setState(sessionId, {
    ...s,
    state: "paused",
    updatedAt: Date.now(),
    currentRound: undefined,
    completedRounds: [...s.completedRounds, completedRound],
  });
}

export function orchSessionEnd(sessionId: string, summary: string): void {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    state: "completed",
    updatedAt: Date.now(),
    summary,
  });
}
export function orchReset(sessionId: string): void {
  // Unblock any waiting orchAwaitInput tool
  const entry = feedbackResolvers.get(sessionId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve("__SESSION_ENDED__");
    feedbackResolvers.delete(sessionId);
  }
  // Clear plan approval manager reference
  planManagers.delete(sessionId);
  // Clean worker log buffers
  const timer = workerLogFlushTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  workerLogFlushTimers.delete(sessionId);
  workerLogBuffers.delete(sessionId);
  // Remove state
  orchStates.delete(sessionId);
  orchEmitter.fire(defaultState());
}

//  Feedback Loop (orchAwaitInput  HQ) 

const FEEDBACK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface FeedbackEntry {
  resolve: (feedback: string) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const feedbackResolvers = new Map<string, FeedbackEntry>();

/** Post synthesis to HQ and wait for user feedback. Returns a Promise that resolves when user sends feedback or times out. */
export function orchWaitForFeedback(sessionId: string, synthesis: string): Promise<string> {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    pendingSynthesis: synthesis,
    awaitingFeedback: true,
    updatedAt: Date.now(),
  });
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      feedbackResolvers.delete(sessionId);
      const cur = getOrchState(sessionId);
      setState(sessionId, {
        ...cur,
        pendingSynthesis: undefined,
        awaitingFeedback: false,
        updatedAt: Date.now(),
      });
      resolve("__TIMEOUT__");
    }, FEEDBACK_TIMEOUT_MS);
    feedbackResolvers.set(sessionId, { resolve, timer });
  });
}

/** Called by HQ when user sends feedback  resolves the waiting orchAwaitInput tool. */
export function orchSendFeedback(sessionId: string, feedback: string): void {
  const entry = feedbackResolvers.get(sessionId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    feedbackResolvers.delete(sessionId);
    const s = getOrchState(sessionId);
    setState(sessionId, {
      ...s,
      pendingSynthesis: undefined,
      awaitingFeedback: false,
      updatedAt: Date.now(),
    });
    entry.resolve(feedback);
  }
}

/** Check if the system is waiting for user feedback. */
export function orchHasPendingFeedback(sessionId: string): boolean {
  return feedbackResolvers.has(sessionId);
}
//  Mailbox State Updates 

export function orchUpdateMailbox(
  sessionId: string,
  messages: MailboxMessage[],
  stats?: MailboxStats,
): void {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    mailboxMessages: messages,
    mailboxStats: stats,
    updatedAt: Date.now(),
  });
}

//  Plan Approval State Updates 

export function orchUpdatePlanApprovals(sessionId: string, plans: PlanApprovalRequest[]): void {
  const s = getOrchState(sessionId);
  setState(sessionId, {
    ...s,
    pendingPlanApprovals: plans,
    updatedAt: Date.now(),
  });
}

//  Active Plan Manager Reference 

const planManagers = new Map<string, PlanApprovalManager>();

export function setActivePlanManager(sessionId: string, manager: PlanApprovalManager | null): void {
  if (manager) {
    planManagers.set(sessionId, manager);
  } else {
    planManagers.delete(sessionId);
  }
}

export function getActivePlanManager(sessionId: string): PlanApprovalManager | null {
  return planManagers.get(sessionId) || null;
}

export function orchApprovePlan(sessionId: string, taskId: string): void {
  planManagers.get(sessionId)?.approvePlan(taskId, "user");
}

export function orchRejectPlan(sessionId: string, taskId: string, reason?: string): void {
  planManagers.get(sessionId)?.rejectPlan(taskId, reason, "user");
}

export function orchApproveAllPlans(sessionId: string): void {
  planManagers.get(sessionId)?.approveAll("user");
}

export function orchRejectAllPlans(sessionId: string, reason?: string): void {
  planManagers.get(sessionId)?.rejectAll(reason, "user");
}