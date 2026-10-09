/**
 * Orchestration Config  Shared state between Brain HQ and Toolbox.
 *
 * HQ writes the configuration (agents, models, goal).
 * The `orchestrate` toolbox sub-tool reads and executes it from Copilot Chat.
 *
 * This is intentionally in-memory only  configs are ephemeral per VS Code session.
 */

import type { AgentDefinition } from "./agent-registry";
import type { ModelTier } from "./model-router-types";

//  Types 
export interface OrchAgentConfig {
  agent: AgentDefinition;
  modelId: string;
  tier: ModelTier;
}

export type OrchMode = "parallel" | "sequential";

export interface OrchConfig {
  /** The orchestration goal / objective */
  goal: string;
  /** Configured agent team with model assignments */
  team: OrchAgentConfig[];
  /** Execution mode: parallel (all at once) or sequential (pipeline) */
  mode: OrchMode;
  /** Model ID for the orchestrator (main agent)  informational hint */
  orchestratorModelId?: string;
  /** Enable inter-agent mailbox messaging */
  useMailbox?: boolean;
  /** Require plan approval before execution (two-phase mode) */
  requiresPlanApproval?: boolean;
  /** Auto-approve plans with low risk level */
  autoApproveLowRisk?: boolean;
  /** Enhance user prompt using LLM before dispatching to workers */
  enhancePrompt?: boolean;
  /** Enable branch isolation (fork-based cloning for parallel, branch switching for loops) */
  useBranchIsolation?: boolean;
  /** When this config was prepared */
  preparedAt: number;
}

//  State 
const pendingConfigs = new Map<string, OrchConfig>();

/**
 * In-memory task queue prepared from Brain HQ.
 *
 * HQ can enqueue prompts during an orchestration session.
 * The chat tool `orchestrate` can consume them (when invoked without an explicit prompt).
 */
const taskQueues = new Map<string, string[]>();

/**
 * Mechanical session gate.
 *
 * When true, the orchestration session is OPEN  the agent CANNOT end it.
 * Only the user clicking "End Session" in Brain HQ sets this to false,
 * which unlocks the `orchEndSession` tool (like `isFinalizeReady()` for strategies).
 */
const sessionOpens = new Map<string, boolean>();

/** Save a prepared orchestration config (called from Brain HQ). */
export function setOrchConfig(sessionId: string, config: OrchConfig): void {
  pendingConfigs.set(sessionId, config);
  // New session config implies a fresh task queue.
  taskQueues.set(sessionId, []);
}

/** Read the pending orchestration config (called from toolbox `orchestrate`). */
export function getOrchConfig(sessionId: string): OrchConfig | null {
  return pendingConfigs.get(sessionId) || null;
}

/** Clear the config after execution or cancellation. */
export function clearOrchConfig(sessionId: string): void {
  pendingConfigs.delete(sessionId);
}

//  Task Queue 
export function queueOrchTask(sessionId: string, prompt: string): number {
  const queue = taskQueues.get(sessionId) || [];
  queue.push(prompt);
  taskQueues.set(sessionId, queue);
  return queue.length;
}

export function dequeueOrchTask(sessionId: string): string | null {
  const queue = taskQueues.get(sessionId) || [];
  const task = queue.shift() ?? null;
  taskQueues.set(sessionId, queue);
  return task;
}

export function peekOrchTaskQueue(sessionId: string): readonly string[] {
  return taskQueues.get(sessionId) || [];
}

export function clearOrchTaskQueue(sessionId: string): void {
  taskQueues.set(sessionId, []);
}

/** Check if there's a pending config ready to execute. */
export function hasOrchConfig(sessionId: string): boolean {
  return pendingConfigs.has(sessionId);
}

//  Session Gate (Mechanical Delimiter) 
/** Lock the session open  agent cannot end it until user unlocks from HQ. */
export function setSessionOpen(sessionId: string, open: boolean): void {
  sessionOpens.set(sessionId, open);
}

/**
 * Check if the orchestration session is still locked open.
 * When true  agent MUST NOT end the session.
 * When false  agent is allowed to call `orchEndSession`.
 */
export function isOrchSessionOpen(sessionId: string): boolean {
  return sessionOpens.get(sessionId) || false;
}

/** Reset everything  config + gate. Used on full teardown. */
export function resetOrchState(sessionId: string): void {
  pendingConfigs.delete(sessionId);
  sessionOpens.delete(sessionId);
  taskQueues.delete(sessionId);
}
