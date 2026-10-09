// ============================================================
// SOURCE MAP — context-editor-strategies.ts
// Implementations of the 4 context editing strategies
// ============================================================
// L1-15:    Imports + source map
// L17-50:   Helper functions (extractText, estimateTokens, etc.)
// L52-130:  RemoveToolResultStrategy
// L132-205: RemoveToolCallParamsStrategy
// L207-265: TokenLimitStrategy
// L267-320: MiddleOutStrategy
// ============================================================

import * as vscode from "vscode";
import type {
  ContextStrategy,
  ContextStrategyId,
  ContextStrategyOutput,
} from "./context-editor-types";

// ─── Helpers ────────────────────────────────────────────────

/** Extract all text content from a LanguageModelChatMessage. */
function extractText(message: vscode.LanguageModelChatMessage): string {
  let text = "";
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

/** Estimate token count using chars/4 heuristic. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Check if a message has assistant role. */
function isAssistantMessage(msg: vscode.LanguageModelChatMessage): boolean {
  return msg.role === vscode.LanguageModelChatMessageRole.Assistant;
}

/** Extract text from a ToolResultPart's content array. */
function extractResultText(part: vscode.LanguageModelToolResultPart): string {
  let text = "";
  if (Array.isArray(part.content)) {
    for (const p of part.content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        text += p.value;
      }
    }
  }
  return text;
}

// ─── RemoveToolResultStrategy ────────────────────────────────

interface RemoveToolResultOptions {
  keepToolNames?: string[];
}

/**
 * Replaces LanguageModelToolResultPart content with a placeholder.
 * Reduces token usage by stripping large tool outputs from context.
 */
export class RemoveToolResultStrategy implements ContextStrategy {
  readonly id: ContextStrategyId = "remove_tool_result";

  apply(
    messages: vscode.LanguageModelChatMessage[],
    options?: Record<string, unknown>,
  ): ContextStrategyOutput {
    const opts = (options ?? {}) as RemoveToolResultOptions;
    const keepToolNames = opts.keepToolNames ?? [];
    let tokensRemoved = 0;

    const edited = messages.map((msg) => {
      if (isAssistantMessage(msg)) {
        return msg;
      }
      return this.processMessage(msg, keepToolNames, (n) => {
        tokensRemoved += n;
      });
    });

    return { messages: edited, tokensRemoved };
  }

  private processMessage(
    msg: vscode.LanguageModelChatMessage,
    keepToolNames: string[],
    onTokensRemoved: (n: number) => void,
  ): vscode.LanguageModelChatMessage {
    let modified = false;
    const newParts: (
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolResultPart
    )[] = [];

    for (const part of msg.content) {
      if (!(part instanceof vscode.LanguageModelToolResultPart)) {
        newParts.push(part as vscode.LanguageModelTextPart);
        continue;
      }

      const toolName = part.callId.split("_")[0] ?? part.callId;
      if (keepToolNames.includes(toolName)) {
        newParts.push(part);
        continue;
      }

      onTokensRemoved(estimateTokens(extractResultText(part)));
      newParts.push(
        new vscode.LanguageModelToolResultPart(part.callId, [
          new vscode.LanguageModelTextPart(
            `[Tool result removed — ${toolName}]`,
          ),
        ]),
      );
      modified = true;
    }

    if (!modified) {
      return msg;
    }
    return vscode.LanguageModelChatMessage.User(newParts, msg.name);
  }
}

// ─── RemoveToolCallParamsStrategy ────────────────────────────

interface RemoveToolCallParamsOptions {
  keepParamNames?: boolean;
}

/**
 * Strips input parameters from LanguageModelToolCallPart in assistant messages.
 * Preserves tool call structure while reducing token cost of stored params.
 */
export class RemoveToolCallParamsStrategy implements ContextStrategy {
  readonly id: ContextStrategyId = "remove_tool_call_params";

  apply(
    messages: vscode.LanguageModelChatMessage[],
    options?: Record<string, unknown>,
  ): ContextStrategyOutput {
    const opts = (options ?? {}) as RemoveToolCallParamsOptions;
    const keepParamNames = opts.keepParamNames === true;
    let tokensRemoved = 0;

    const edited = messages.map((msg) => {
      if (!isAssistantMessage(msg)) {
        return msg;
      }
      return this.processMessage(msg, keepParamNames, (n) => {
        tokensRemoved += n;
      });
    });

    return { messages: edited, tokensRemoved };
  }

  private processMessage(
    msg: vscode.LanguageModelChatMessage,
    keepParamNames: boolean,
    onTokensRemoved: (n: number) => void,
  ): vscode.LanguageModelChatMessage {
    let modified = false;
    const newParts: (
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolCallPart
    )[] = [];

    for (const part of msg.content) {
      if (!(part instanceof vscode.LanguageModelToolCallPart)) {
        newParts.push(part as vscode.LanguageModelTextPart);
        continue;
      }

      onTokensRemoved(estimateTokens(JSON.stringify(part.input)));
      newParts.push(this.buildStrippedCall(part, keepParamNames));
      modified = true;
    }

    if (!modified) {
      return msg;
    }
    return vscode.LanguageModelChatMessage.Assistant(newParts, msg.name);
  }

  private buildStrippedCall(
    part: vscode.LanguageModelToolCallPart,
    keepParamNames: boolean,
  ): vscode.LanguageModelToolCallPart {
    if (keepParamNames) {
      const nulledInput = Object.fromEntries(
        Object.keys(part.input as Record<string, unknown>).map((k) => [
          k,
          null,
        ]),
      );
      return new vscode.LanguageModelToolCallPart(
        part.callId,
        part.name,
        nulledInput,
      );
    }
    return new vscode.LanguageModelToolCallPart(part.callId, part.name, {
      _removed: `[Tool call: ${part.name} — params removed]`,
    });
  }
}

// ─── TokenLimitStrategy ──────────────────────────────────────

interface TokenLimitOptions {
  maxTokensPerMessage?: number;
  truncationMarker?: string;
}

const DEFAULT_MAX_TOKENS_PER_MSG = 2000;
const DEFAULT_TRUNCATION_MARKER = "[...truncated]";

/**
 * Truncates messages whose text content exceeds maxTokensPerMessage.
 * Replaces the full text content with a truncated version + marker.
 */
export class TokenLimitStrategy implements ContextStrategy {
  readonly id: ContextStrategyId = "token_limit";

  apply(
    messages: vscode.LanguageModelChatMessage[],
    options?: Record<string, unknown>,
  ): ContextStrategyOutput {
    const opts = (options ?? {}) as TokenLimitOptions;
    const maxTokens = opts.maxTokensPerMessage ?? DEFAULT_MAX_TOKENS_PER_MSG;
    const marker = opts.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
    let tokensRemoved = 0;

    const edited = messages.map((msg) => {
      const text = extractText(msg);
      const tokens = estimateTokens(text);
      if (tokens <= maxTokens) {
        return msg;
      }

      const result = this.truncate(msg, text, maxTokens, marker);
      tokensRemoved += result.tokensRemoved;
      return result.message;
    });

    return { messages: edited, tokensRemoved };
  }

  private truncate(
    msg: vscode.LanguageModelChatMessage,
    originalText: string,
    maxTokens: number,
    marker: string,
  ): { message: vscode.LanguageModelChatMessage; tokensRemoved: number } {
    const maxChars = maxTokens * 4;
    const allowedChars = Math.max(0, maxChars - marker.length);
    const truncatedText = originalText.slice(0, allowedChars) + marker;

    const tokensRemoved =
      estimateTokens(originalText) - estimateTokens(truncatedText);
    const part = new vscode.LanguageModelTextPart(truncatedText);
    const message = isAssistantMessage(msg)
      ? vscode.LanguageModelChatMessage.Assistant([part], msg.name)
      : vscode.LanguageModelChatMessage.User([part], msg.name);

    return { message, tokensRemoved };
  }
}

// ─── MiddleOutStrategy ───────────────────────────────────────

interface MiddleOutOptions {
  keepFirst?: number;
  keepLast?: number;
}

const DEFAULT_KEEP_FIRST = 3;
const DEFAULT_KEEP_LAST = 5;

/**
 * Compresses middle section of conversation into a summary message.
 * Preserves the first N and last M messages for context continuity.
 */
export class MiddleOutStrategy implements ContextStrategy {
  readonly id: ContextStrategyId = "middle_out";

  apply(
    messages: vscode.LanguageModelChatMessage[],
    options?: Record<string, unknown>,
  ): ContextStrategyOutput {
    const opts = (options ?? {}) as MiddleOutOptions;
    const keepFirst = opts.keepFirst ?? DEFAULT_KEEP_FIRST;
    const keepLast = opts.keepLast ?? DEFAULT_KEEP_LAST;

    // Short-circuit: no middle to compress
    if (messages.length <= keepFirst + keepLast) {
      return { messages, tokensRemoved: 0 };
    }

    const head = messages.slice(0, keepFirst);
    const tail = messages.slice(messages.length - keepLast);
    const middle = messages.slice(keepFirst, messages.length - keepLast);

    const tokensRemoved = middle.reduce(
      (sum, m) => sum + estimateTokens(extractText(m)),
      0,
    );

    const summary = vscode.LanguageModelChatMessage.User(
      `[${middle.length} messages compressed — ${tokensRemoved} tokens saved]`,
    );

    return {
      messages: [...head, summary, ...tail],
      tokensRemoved,
    };
  }
}
