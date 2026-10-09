// ─── Swarm Tool Dispatch ───────────────────────────────────────────────
// Handles dispatching individual tool calls within the swarm agentic loop.
// Each tool call is routed to the correct handler (virtual, meta, or real).

import * as vscode from "vscode";
import { evaluateToolCall, type GatekeeperDeps } from "./command-gatekeeper";
import { DynamicToolSet, LOAD_TOOLS_NAME } from "./dynamic-tool-set";
import {
  executeGrep,
  executeListDir,
  executeReadFile,
} from "./swarm-file-tools";
import type { MailboxMessageType } from "./swarm-mailbox";
import { executeSubAgent } from "./swarm-sub-agent";
import {
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  MAILBOX_TOOL_NAME,
  MAX_FILE_CHARS,
  READ_FILE_TOOL_NAME,
  SUB_AGENT_TOOL_NAME,
} from "./swarm-tool-defs";
import { mayRequireConfirmation } from "./swarm-tool-helpers";
import type { ToolDispatchContext, ToolDispatchResult } from "./swarm-types";
import { handleToolError, pushToolResult } from "./swarm-worker-utils";

/** Dependencies injected from the SwarmWorker for dispatching. */
export interface DispatchDeps {
  dynamicTools: DynamicToolSet;
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  availableTools: vscode.LanguageModelChatTool[];
  virtualTools: vscode.LanguageModelChatTool[];
  progress: (taskId: string, message: string) => void;
  /** Gatekeeper deps — if present, enables LLM-based command evaluation. */
  gatekeeperDeps?: GatekeeperDeps | null;
}

/**
 * Dispatch a single tool call to the appropriate handler.
 * Returns metrics about chars added and whether tools changed.
 */
export async function dispatchToolCall(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: DispatchDeps,
): Promise<ToolDispatchResult> {
  const result: ToolDispatchResult = {
    inputCharsAdded: 0,
    outputCharsAdded: 0,
    toolsChanged: false,
  };

  ctx.log(
    `[SwarmWorker ${ctx.task.id}] Tool: ${toolCall.name}(${JSON.stringify(toolCall.input).substring(0, 80)})`,
  );
  deps.progress(ctx.task.id, `🔧 ${toolCall.name}...`);

  try {
    // ─── Meta-tool (DynamicToolSet) ─────────────────────────
    if (
      deps.dynamicTools.isDynamic() &&
      deps.dynamicTools.isMetaTool(toolCall.name)
    ) {
      return handleMetaTool(toolCall, ctx, deps, result);
    }

    // ─── Virtual mailbox tool ───────────────────────────────
    if (toolCall.name === MAILBOX_TOOL_NAME && ctx.options?.mailbox) {
      return handleMailboxTool(toolCall, ctx, result);
    }

    // ─── Virtual sub-agent tool ─────────────────────────────
    if (toolCall.name === SUB_AGENT_TOOL_NAME) {
      return await handleSubAgentTool(toolCall, ctx, deps, result);
    }

    // ─── Virtual file tools ─────────────────────────────────
    if (toolCall.name === READ_FILE_TOOL_NAME) {
      return handleReadFileTool(toolCall, ctx, result);
    }
    if (toolCall.name === LIST_DIR_TOOL_NAME) {
      return handleListDirTool(toolCall, ctx, result);
    }
    if (toolCall.name === GREP_TOOL_NAME) {
      return await handleGrepTool(toolCall, ctx, result);
    }

    // ─── Previously declined tool ───────────────────────────
    if (ctx.declinedTools.has(toolCall.name)) {
      return handleDeclinedTool(toolCall, ctx, result);
    }

    // ─── Git branch switch gatekeeper ───────────────────────
    const gatekeeperVerdict = await evaluateToolCall(
      toolCall.name,
      toolCall.input,
      `Worker ${ctx.task.id} during swarm execution`,
      deps.gatekeeperDeps ?? null,
    );
    if (gatekeeperVerdict && !gatekeeperVerdict.allowed) {
      return handleGatekeeperBlock(toolCall, ctx, result, gatekeeperVerdict.reason);
    }
    if (gatekeeperVerdict && gatekeeperVerdict.allowed) {
      ctx.log(`[SwarmWorker ${ctx.task.id}] ✅ Gatekeeper ALLOWED: ${toolCall.name} — ${gatekeeperVerdict.reason}`);
    }

    // ─── Confirmation signal ────────────────────────────────
    if (mayRequireConfirmation(toolCall.name)) {
      deps.progress(
        ctx.task.id,
        `🔐 Awaiting approval for ${toolCall.name}...`,
      );
    }

    // ─── Normal tool invocation ─────────────────────────────
    return await handleNormalTool(toolCall, ctx, deps, result);
  } catch (toolErr) {
    return await handleToolError(toolCall, ctx, deps, result, toolErr);
  }
}

// ─── Individual Handlers ───────────────────────────────────────────────

function handleMetaTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: DispatchDeps,
  result: ToolDispatchResult,
): ToolDispatchResult {
  const metaResult = deps.dynamicTools.handleToolCall(
    toolCall.name,
    toolCall.input,
  );
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 🔧 Meta-tool ${toolCall.name}: ${(metaResult ?? "").substring(0, 80)}`,
  );

  if (toolCall.name === LOAD_TOOLS_NAME) {
    result.toolsChanged = true;
  }

  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: metaResult ?? "unknown meta-tool",
  });
  ctx.messages.push(
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(toolCall.callId, [
        new vscode.LanguageModelTextPart(metaResult ?? ""),
      ]),
    ]),
  );
  result.inputCharsAdded += (metaResult ?? "").length;
  return result;
}

function handleMailboxTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
): ToolDispatchResult {
  const input = toolCall.input as {
    type?: string;
    content?: string;
    to?: string;
  };
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 📬 Mailbox: type=${input.type}, to=${input.to ?? "ALL"}, content="${(input.content ?? "").substring(0, 60)}"`,
  );

  const msgType = (input.type as MailboxMessageType) ?? "update";
  const msgId = ctx.options!.mailbox!.post({
    from: ctx.task.id,
    to: input.to ?? null,
    type: msgType,
    content: input.content ?? "",
  });

  ctx.loopState.hasPostedToMailbox = true;
  const resultText = msgId
    ? `Message posted (id: ${msgId}). Other workers will see it in their next round.`
    : `Message dropped — rate limit reached.`;
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 📬 ${msgId ? `posted id=${msgId}` : "DROPPED"}`,
  );

  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: resultText,
  });
  ctx.messages.push(
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(toolCall.callId, [
        new vscode.LanguageModelTextPart(resultText),
      ]),
    ]),
  );
  return result;
}

async function handleSubAgentTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: DispatchDeps,
  result: ToolDispatchResult,
): Promise<ToolDispatchResult> {
  const subInput = toolCall.input as { task: string; context?: string };
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 🤖 Sub-agent: "${(subInput.task ?? "").substring(0, 80)}"`,
  );
  deps.progress(
    ctx.task.id,
    `🤖 Sub-agent: ${(subInput.task ?? "").substring(0, 40)}...`,
  );

  try {
    const subResult = await executeSubAgent(
      deps.model,
      subInput.task,
      subInput.context,
      ctx.options?.toolInvocationToken,
      deps.token,
      ctx.log,
    );
    result.outputCharsAdded += subResult.length;
    ctx.toolCallLog.push({
      name: toolCall.name,
      input: toolCall.input,
      result: subResult.substring(0, 200),
    });
    ctx.messages.push(
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(toolCall.callId, [
          new vscode.LanguageModelTextPart(subResult),
        ]),
      ]),
    );
  } catch (subErr: unknown) {
    const errMsg = `Sub-agent failed: ${subErr instanceof Error ? subErr.message : String(subErr)}`;
    ctx.log(`[SwarmWorker ${ctx.task.id}] ❌ ${errMsg}`);
    ctx.toolCallLog.push({
      name: toolCall.name,
      input: toolCall.input,
      result: errMsg,
    });
    ctx.messages.push(
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(toolCall.callId, [
          new vscode.LanguageModelTextPart(errMsg),
        ]),
      ]),
    );
  }
  return result;
}

function handleReadFileTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
): ToolDispatchResult {
  const fileInput = toolCall.input as {
    filePath?: string;
    startLine?: number;
    endLine?: number;
  };
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 📄 read_file: "${fileInput.filePath}" (${fileInput.startLine ?? 1}-${fileInput.endLine ?? "EOF"})`,
  );

  const fileResult = executeReadFile(fileInput);
  const truncated =
    fileResult.length > MAX_FILE_CHARS
      ? fileResult.substring(0, MAX_FILE_CHARS) + "\n[truncated]"
      : fileResult;

  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: truncated.substring(0, 200),
  });
  result.inputCharsAdded += truncated.length;
  pushToolResult(ctx.messages, toolCall.callId, truncated);
  return result;
}

function handleListDirTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
): ToolDispatchResult {
  const dirInput = toolCall.input as { dirPath?: string };
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 📂 list_dir: "${dirInput.dirPath ?? "."}"`,
  );

  const dirResult = executeListDir(dirInput);
  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: dirResult.substring(0, 200),
  });
  result.inputCharsAdded += dirResult.length;
  pushToolResult(ctx.messages, toolCall.callId, dirResult);
  return result;
}

async function handleGrepTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
): Promise<ToolDispatchResult> {
  const grepInput = toolCall.input as { pattern?: string; include?: string };
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 🔍 grep: "${grepInput.pattern}" in "${grepInput.include ?? "**/*.{ts,js,json,md}"}"`,
  );

  const grepResult = await executeGrep(grepInput);
  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: grepResult.substring(0, 200),
  });
  result.inputCharsAdded += grepResult.length;
  pushToolResult(ctx.messages, toolCall.callId, grepResult);
  return result;
}

function handleDeclinedTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
): ToolDispatchResult {
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] ⛔ Skipping ${toolCall.name} (user declined)`,
  );

  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: "[skipped — user declined]",
  });
  pushToolResult(
    ctx.messages,
    toolCall.callId,
    `Tool "${toolCall.name}" was previously declined by the user. ` +
      `Do NOT retry this tool. Use an alternative approach or skip this step entirely.`,
  );
  return result;
}

/** Block a tool call that was rejected by the command gatekeeper. */
function handleGatekeeperBlock(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  result: ToolDispatchResult,
  reason: string,
): ToolDispatchResult {
  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 🛡️ GATEKEEPER BLOCKED: ${toolCall.name} — ${reason}`,
  );

  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: `[BLOCKED by gatekeeper — ${reason}]`,
  });
  pushToolResult(
    ctx.messages,
    toolCall.callId,
    `⛔ BLOCKED: "${toolCall.name}" was blocked by the security gatekeeper. ` +
      `Reason: ${reason}. ` +
      `Branch switching is NOT allowed during auto-pilot. ` +
      `Do NOT retry this tool. Continue with your task without changing branches.`,
  );
  return result;
}

async function handleNormalTool(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: DispatchDeps,
  result: ToolDispatchResult,
): Promise<ToolDispatchResult> {
  const toolResult = await vscode.lm.invokeTool(
    toolCall.name,
    {
      input: toolCall.input,
      toolInvocationToken: ctx.options?.toolInvocationToken,
    },
    deps.token,
  );

  const resultPreview = toolResult.content
    .map((c: unknown) => {
      const part = c as Record<string, unknown>;
      return "value" in part
        ? String(part.value).substring(0, 100)
        : "[non-text]";
    })
    .join(" ");

  result.inputCharsAdded += resultPreview.length;
  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    result: resultPreview,
  });
  ctx.messages.push(
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(
        toolCall.callId,
        toolResult.content,
      ),
    ]),
  );
  return result;
}
