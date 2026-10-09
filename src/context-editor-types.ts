// ============================================================
// SOURCE MAP — context-editor-types.ts
// Type definitions for the Context Editing Strategies system
// ============================================================
// L1-10:       Source map
// L12-20:      ContextStrategyId type
// L22-40:      StrategyConfig interface
// L42-60:      ContextEditorConfig interface
// L62-75:      ContextStrategyOutput interface
// L77-100:     StrategyResult interface
// L102-130:    ContextEditResult interface
// L132-155:    ContextStrategy interface
// ============================================================

import type * as vscode from "vscode";

/**
 * Union type for the 4 context editing strategies.
 * Each strategy transforms messages in a specific way without mutating storage.
 */
export type ContextStrategyId =
  | "remove_tool_result"
  | "remove_tool_call_params"
  | "token_limit"
  | "middle_out";

/**
 * Configuration for a single context editing strategy.
 * Defines how a strategy is enabled, prioritized, and configured.
 */
export interface StrategyConfig {
  /** Unique identifier for the strategy */
  readonly id: ContextStrategyId;

  /** Whether this strategy is active in the pipeline */
  enabled: boolean;

  /** Execution order — lower priority runs earlier in the pipeline */
  priority: number;

  /** Strategy-specific options (varies per strategy) */
  options?: Record<string, unknown>;
}

/**
 * Complete configuration for the Context Editor pipeline.
 * Defines all strategies, global constraints, and preservation rules.
 */
export interface ContextEditorConfig {
  /** Array of strategies to apply (sorted by priority at runtime) */
  strategies: StrategyConfig[];

  /** Global token budget for the entire edited context. Undefined = no limit. */
  globalTokenBudget?: number;

  /** If true, system messages are never modified by any strategy */
  preserveSystemMessages?: boolean;

  /** Number of recent user messages to always preserve (for conversational continuity) */
  preserveLastN?: number;
}

/**
 * Output of applying a single strategy to a message array.
 * Contains the transformed messages and token savings metrics.
 */
export interface ContextStrategyOutput {
  /** Transformed messages after strategy application */
  messages: vscode.LanguageModelChatMessage[];

  /** Estimated tokens removed by this strategy */
  tokensRemoved: number;
}

/**
 * Result of executing one strategy in the pipeline.
 * Records before/after state and performance metrics for auditing.
 */
export interface StrategyResult {
  /** Which strategy was applied */
  strategyId: ContextStrategyId;

  /** Message count before this strategy ran */
  messagesIn: number;

  /** Message count after this strategy ran */
  messagesOut: number;

  /** Estimated tokens removed by this strategy */
  tokensRemoved: number;

  /** Execution time in milliseconds */
  durationMs: number;
}

/**
 * Final result of the complete Context Editor pipeline.
 * Aggregates metrics from all strategies applied.
 */
export interface ContextEditResult {
  /** Edited messages ready for LLM context */
  messages: vscode.LanguageModelChatMessage[];

  /** Total messages in the original input */
  originalMessageCount: number;

  /** Total messages in the edited output */
  editedMessageCount: number;

  /** Total estimated tokens removed across all strategies */
  totalTokensRemoved: number;

  /** Individual results from each strategy that ran */
  strategiesApplied: StrategyResult[];

  /** Total pipeline execution time in milliseconds */
  durationMs: number;
}

/**
 * Interface that all context editing strategies must implement.
 * Each strategy transforms messages without mutating the originals.
 */
export interface ContextStrategy {
  /** Unique identifier matching one of ContextStrategyId values */
  readonly id: ContextStrategyId;

  /**
   * Apply this strategy to a message array.
   * Must NOT mutate the input array — return new messages.
   *
   * @param messages - Input messages to transform
   * @param options - Strategy-specific options from StrategyConfig
   * @returns Transformed messages and token savings metrics
   */
  apply(
    messages: vscode.LanguageModelChatMessage[],
    options?: Record<string, unknown>,
  ): ContextStrategyOutput;
}
