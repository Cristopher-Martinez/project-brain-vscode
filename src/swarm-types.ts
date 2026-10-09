// ─── Swarm Types ───────────────────────────────────────────────────────
// Shared interfaces for the swarm orchestration worker system.

import type * as vscode from "vscode";
import type { DelegateTaskKind, ModelTier } from "./model-router-types";
import type { SwarmMailbox } from "./swarm-mailbox";

/**
 * A task to be executed by a SwarmWorker.
 * Each task runs as an independent agentic loop with its own model + tools.
 */
export interface SwarmTask {
  /** Unique identifier for tracking */
  id: string;
  /** User prompt — the actual instruction */
  prompt: string;
  /** System prompt override (if omitted, uses specialist persona) */
  systemPrompt?: string;
  /** Task kind — determines persona and tool selection */
  taskKind?: DelegateTaskKind;
  /** Tool filter — controls which tools the worker can access */
  toolFilter?: (tool: vscode.LanguageModelToolInformation) => boolean;
  /** Max agentic loop rounds (default: 8) */
  maxToolRounds?: number;
  /** Max model tier ceiling (default: "free") */
  maxTier?: ModelTier;
  /** Specific model ID to use (bypasses ModelRouter auto-selection) */
  modelId?: string;
  /** Optional context files to read before executing */
  contextFiles?: string[];
  /** Task IDs that must complete before this task can start */
  dependsOn?: string[];
  /** Priority for scheduling (higher = runs first when multiple tasks are ready) */
  priority?: number;
  /** Require plan approval before execution (two-phase mode) */
  requiresPlanApproval?: boolean;
}

/**
 * Result from a SwarmWorker execution.
 */
export interface SwarmResult {
  taskId: string;
  text: string;
  toolCalls: {
    name: string;
    input: unknown;
    result?: string;
    error?: string;
  }[];
  model: string;
  tier: string;
  durationMs: number;
  rounds: number;
  success: boolean;
  error?: string;
  /** Estimated input tokens (prompt + tool results, chars/4) */
  estimatedInputTokens: number;
  /** Estimated output tokens (LLM response text, chars/4) */
  estimatedOutputTokens: number;
  /** True when this result is from a plan-only execution (not yet approved) */
  isPlanOnly?: boolean;
}

export interface SwarmWorkerOptions {
  /** Token from chat participant (if available — enables copilot tools) */
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  /** Progress callback — called with status updates */
  onProgress?: (taskId: string, message: string) => void;
  /** Stream callback — called with accumulated text as it streams in real-time */
  onStreamText?: (taskId: string, fullText: string) => void;
  /** Shared mailbox for inter-worker communication */
  mailbox?: SwarmMailbox;
  /** Run in plan-only mode (read-only tools, planning prompt) */
  planOnly?: boolean;
}

/** Mutable context passed through the agentic loop for state tracking. */
export interface AgenticLoopState {
  lastMailboxCheck: number;
  hasPostedToMailbox: boolean;
  mailboxNudged: boolean;
  mailboxReadBeforeExit: boolean;
}

/** Context object for tool dispatch operations. */
export interface ToolDispatchContext {
  task: SwarmTask;
  options?: SwarmWorkerOptions;
  messages: vscode.LanguageModelChatMessage[];
  toolCallLog: SwarmResult["toolCalls"];
  declinedTools: Set<string>;
  loopState: AgenticLoopState;
  log: (msg: string) => void;
}

/** Result of a single tool dispatch. */
export interface ToolDispatchResult {
  inputCharsAdded: number;
  outputCharsAdded: number;
  toolsChanged: boolean;
}
