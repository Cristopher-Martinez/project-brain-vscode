// ─── Swarm Tool Helpers ────────────────────────────────────────────────
// Tool selection, confirmation, message sanitization, and mailbox hooks.

import * as vscode from "vscode";
import type {
  SwarmTask,
  SwarmWorkerOptions,
  AgenticLoopState,
} from "./swarm-types";
import { isCheckoutTool } from "./command-gatekeeper";

// ─── Tool Confirmation Helpers ────────────────────────────────────────

/**
 * Detect if a tool error is a user cancellation/rejection.
 * VS Code throws specific errors when the user clicks "Cancel"
 * on a tool confirmation dialog.
 */
export function isUserCancellation(err: unknown): boolean {
  if (err instanceof vscode.CancellationError) return true;
  const msg = String(err).toLowerCase();
  return (
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("user declined") ||
    msg.includes("not accepted") ||
    msg.includes("confirmation was not accepted") ||
    msg.includes("was not confirmed")
  );
}

/**
 * Check if a tool is likely to require user confirmation.
 * MCP tools and certain Copilot tools may trigger VS Code's
 * confirmation dialog. Our own projectBrain_ tools are always safe.
 */
export function mayRequireConfirmation(toolName: string): boolean {
  if (toolName.startsWith("projectBrain_")) return false;
  if (toolName.startsWith("mcp_rag-docs_")) return false;
  if (toolName.startsWith("mcp_")) return true;
  if (toolName.startsWith("copilot_")) return true;
  return false;
}

// ─── Tool Selection ────────────────────────────────────────────────────

/**
 * VS Code read-only tools that exist in vscode.lm.tools.
 * NOTE: read_file, grep_search, file_search, list_dir, semantic_search
 * are chat-participant-only — they do NOT exist here.
 */
export const READ_ONLY_TOOLS = new Set(["get_terminal_output"]);

/**
 * Default tool filter — allows Project Brain tools + ALL MCP tools
 * + VS Code built-in read tools for codebase access.
 * Blocks known checkout tools (branch switch prevention).
 */
export function defaultToolFilter(
  tool: vscode.LanguageModelToolInformation,
): boolean {
  const name = tool.name;
  // Block checkout/switch tools outright (Layer 1: pattern-based deny)
  if (isCheckoutTool(name)) return false;
  if (name.startsWith("projectBrain_")) return true;
  if (name.startsWith("mcp_")) return true;
  if (READ_ONLY_TOOLS.has(name)) return true;
  return false;
}

/**
 * Convert LanguageModelToolInformation to LanguageModelChatTool format.
 * Normalizes schemas for providers that require strict object schemas.
 */
export function toolInfoToChat(
  tool: vscode.LanguageModelToolInformation,
): vscode.LanguageModelChatTool {
  let schema: Record<string, unknown> | undefined;
  if (tool.inputSchema && typeof tool.inputSchema === "object") {
    const asRecord = tool.inputSchema as Record<string, unknown>;
    if (asRecord.type === "object" || asRecord.type === undefined) {
      if (!asRecord.properties || typeof asRecord.properties !== "object") {
        schema = { ...asRecord, type: "object", properties: {} };
      } else {
        schema = asRecord;
      }
    } else {
      schema = asRecord;
    }
  } else {
    schema = { type: "object", properties: {} };
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

// ─── Message Sanitization ──────────────────────────────────────────────

/**
 * Sanitize messages to fix OpenAI tool-message ordering issues.
 * OpenAI requires: every message with role 'tool' must immediately follow
 * an assistant message that contains tool_calls.
 * Mutates the array in place by removing problematic messages.
 */
export function sanitizeToolMessages(
  messages: vscode.LanguageModelChatMessage[],
): void {
  // Pass 1: Find and remove orphaned tool result messages
  let i = messages.length - 1;
  while (i >= 0) {
    const msg = messages[i];
    const parts = (msg as unknown as { content2?: unknown[] }).content2;

    const isToolResult =
      parts &&
      parts.length > 0 &&
      parts.some(
        (p: unknown) => p instanceof vscode.LanguageModelToolResultPart,
      );

    if (!isToolResult) {
      const isAssistantWithTools =
        parts &&
        parts.length > 0 &&
        parts.some(
          (p: unknown) => p instanceof vscode.LanguageModelToolCallPart,
        );

      if (isAssistantWithTools) {
        i--;
        continue;
      }
      break;
    }

    // Walk backwards past consecutive tool results to find the assistant
    let chainStart = i;
    while (chainStart > 0) {
      const prevParts = (
        messages[chainStart - 1] as unknown as { content2?: unknown[] }
      ).content2;
      const prevIsToolResult =
        prevParts &&
        prevParts.length > 0 &&
        prevParts.some(
          (p: unknown) => p instanceof vscode.LanguageModelToolResultPart,
        );
      if (prevIsToolResult) {
        chainStart--;
      } else {
        break;
      }
    }

    // Check if the message before the chain is an assistant with tool calls
    if (chainStart > 0) {
      const prevParts = (
        messages[chainStart - 1] as unknown as { content2?: unknown[] }
      ).content2;
      const prevIsAssistantWithTools =
        prevParts &&
        prevParts.length > 0 &&
        prevParts.some(
          (p: unknown) => p instanceof vscode.LanguageModelToolCallPart,
        );

      if (prevIsAssistantWithTools) {
        i = chainStart - 2;
        continue;
      }
    }

    // Orphaned tool result chain — remove it
    messages.splice(chainStart, i - chainStart + 1);
    i = chainStart - 1;
  }

  // Pass 2: Aggressive fallback — truncate after last clean text message
  for (let j = messages.length - 1; j >= 0; j--) {
    const msg = messages[j];
    const parts = (msg as unknown as { content2?: unknown[] }).content2;
    const hasToolContent =
      parts &&
      parts.length > 0 &&
      parts.some(
        (p: unknown) =>
          p instanceof vscode.LanguageModelToolResultPart ||
          p instanceof vscode.LanguageModelToolCallPart,
      );
    if (!hasToolContent) {
      if (j < messages.length - 1) {
        const afterHasTools = messages.slice(j + 1).some((m) => {
          const mp = (m as unknown as { content2?: unknown[] }).content2;
          return (
            mp &&
            mp.some(
              (p: unknown) => p instanceof vscode.LanguageModelToolResultPart,
            )
          );
        });
        if (afterHasTools) {
          messages.splice(j + 1);
        }
      }
      break;
    }
  }
}

// ─── Mailbox Hooks ─────────────────────────────────────────────────────

/** Parameters for pre-completion mailbox hook check. */
export interface MailboxHookParams {
  options?: SwarmWorkerOptions;
  task: SwarmTask;
  messages: vscode.LanguageModelChatMessage[];
  loopState: AgenticLoopState;
  isPlanMode: boolean;
  requestOptions: vscode.LanguageModelChatRequestOptions;
  tools: vscode.LanguageModelChatTool[];
  round: number;
  maxRounds: number;
  log: (msg: string) => void;
}

/** Result of mailbox hook check. */
export interface MailboxHookResult {
  shouldContinue: boolean;
  newMaxRounds: number;
  inputCharsAdded: number;
}

/**
 * Check pre-completion mailbox hooks.
 * Hook 1: Inject unread messages from other workers before exit.
 * Hook 2: Nudge worker that never posted to mailbox.
 */
export function checkMailboxHooks(p: MailboxHookParams): MailboxHookResult {
  const noHook: MailboxHookResult = {
    shouldContinue: false,
    newMaxRounds: p.maxRounds,
    inputCharsAdded: 0,
  };

  // Hook 1: Unread messages before exit
  if (
    p.options?.mailbox &&
    !p.isPlanMode &&
    !p.loopState.mailboxReadBeforeExit
  ) {
    const finalMailbox = p.options.mailbox.formatContextForWorker(
      p.task.id,
      p.loopState.lastMailboxCheck || undefined,
    );
    if (finalMailbox) {
      p.loopState.mailboxReadBeforeExit = true;
      p.loopState.lastMailboxCheck = Date.now();
      p.log(
        `[SwarmWorker ${p.task.id}] 📬 Mailbox hook: unread messages before exit`,
      );
      p.messages.push(
        vscode.LanguageModelChatMessage.User(
          finalMailbox +
            "\n\n⚠️ IMPORTANT: You just received messages from other workers. " +
            "Read and respond via `swarm_mailbox_post`, then produce your final summary.",
        ),
      );
      if (!p.requestOptions.tools) {
        p.requestOptions.tools = p.tools.length > 0 ? p.tools : undefined;
      }
      return {
        shouldContinue: true,
        newMaxRounds: Math.max(p.maxRounds, p.round + 3),
        inputCharsAdded: finalMailbox.length + 300,
      };
    }
  }

  // Hook 2: Never posted — nudge once
  if (
    p.options?.mailbox &&
    !p.isPlanMode &&
    !p.loopState.hasPostedToMailbox &&
    !p.loopState.mailboxNudged
  ) {
    p.loopState.mailboxNudged = true;
    p.log(`[SwarmWorker ${p.task.id}] 📬 Mailbox hook: never posted — nudge`);
    p.messages.push(
      vscode.LanguageModelChatMessage.User(
        "⚠️ COLLABORATION REQUIRED: You have not posted to the shared mailbox. " +
          'Call `swarm_mailbox_post` with type="finding" to share your key findings.',
      ),
    );
    if (!p.requestOptions.tools) {
      p.requestOptions.tools = p.tools.length > 0 ? p.tools : undefined;
    }
    return {
      shouldContinue: true,
      newMaxRounds: Math.max(p.maxRounds, p.round + 3),
      inputCharsAdded: 200,
    };
  }

  return noHook;
}
