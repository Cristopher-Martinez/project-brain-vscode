// ─── SwarmWorker Utilities ─────────────────────────────────────────────
// Extracted from SwarmWorker class: sendAndCollect, deduplicateToolCalls,
// buildResult, injectMailboxContext, forceConclusion.

import * as vscode from "vscode";
import type { DynamicToolSet } from "./dynamic-tool-set";
import { isUserCancellation, sanitizeToolMessages } from "./swarm-tool-helpers";
import type {
  AgenticLoopState,
  SwarmResult,
  SwarmTask,
  SwarmWorkerOptions,
  ToolDispatchContext,
  ToolDispatchResult,
} from "./swarm-types";

// ─── sendAndCollect ────────────────────────────────────────────────────

export interface SendAndCollectParams {
  model: vscode.LanguageModelChat;
  messages: vscode.LanguageModelChatMessage[];
  requestOptions: vscode.LanguageModelChatRequestOptions;
  token: vscode.CancellationToken;
  task: SwarmTask;
  options: SwarmWorkerOptions | undefined;
  existingText: string;
  log: (msg: string) => void;
}

export interface SendAndCollectResult {
  textParts: vscode.LanguageModelTextPart[];
  toolCallParts: vscode.LanguageModelToolCallPart[];
  textCollected: string;
  outputCollected: number;
}

/** Send a request to the LLM and collect streamed parts. Retries on tool-ordering errors. */
export async function sendAndCollect(
  params: SendAndCollectParams,
): Promise<SendAndCollectResult> {
  const {
    model,
    messages,
    requestOptions,
    token,
    task,
    options,
    existingText,
    log,
  } = params;
  const textParts: vscode.LanguageModelTextPart[] = [];
  const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
  let textCollected = "";
  let outputCollected = 0;

  const collect = async () => {
    const resp = await model.sendRequest(messages, requestOptions, token);
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textCollected += part.value;
        outputCollected += part.value.length;
        textParts.push(part);
        options?.onStreamText?.(task.id, existingText + textCollected);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts.push(part);
      }
    }
  };

  try {
    await collect();
  } catch (sendErr) {
    if (String(sendErr).includes("role 'tool' must be a response")) {
      log(
        `[SwarmWorker ${task.id}] Tool-message ordering error — sanitizing...`,
      );
      sanitizeToolMessages(messages);
      textParts.length = 0;
      toolCallParts.length = 0;
      textCollected = "";
      outputCollected = 0;
      await collect();
    } else {
      throw sendErr;
    }
  }

  return { textParts, toolCallParts, textCollected, outputCollected };
}

// ─── deduplicateToolCalls ──────────────────────────────────────────────

/** Deduplicate tool calls by callId (streaming can emit duplicates). */
export function deduplicateToolCalls(
  toolCallParts: vscode.LanguageModelToolCallPart[],
  taskId: string,
  log: (msg: string) => void,
): vscode.LanguageModelToolCallPart[] {
  const seen = new Set<string>();
  const unique = toolCallParts.filter((tc) => {
    if (seen.has(tc.callId)) return false;
    seen.add(tc.callId);
    return true;
  });
  if (unique.length < toolCallParts.length) {
    log(
      `[SwarmWorker ${taskId}] Deduped: ${toolCallParts.length} → ${unique.length}`,
    );
  }
  return unique;
}

// ─── injectMailboxContext ──────────────────────────────────────────────

/** Inject mailbox context between rounds if new messages exist. */
export function injectMailboxContext(
  options: SwarmWorkerOptions | undefined,
  task: SwarmTask,
  messages: vscode.LanguageModelChatMessage[],
  loopState: AgenticLoopState,
  round: number,
  log: (msg: string) => void,
): void {
  if (!options?.mailbox || round === 0) return;
  const mailboxCtx = options.mailbox.formatContextForWorker(
    task.id,
    loopState.lastMailboxCheck || undefined,
  );
  loopState.lastMailboxCheck = Date.now();
  if (mailboxCtx) {
    messages.push(vscode.LanguageModelChatMessage.User(mailboxCtx));
    log(
      `[SwarmWorker ${task.id}] Injected mailbox context (${mailboxCtx.length} chars)`,
    );
  }
}

// ─── forceConclusion ───────────────────────────────────────────────────

/** Force text conclusion on the final round by removing tools. */
export function forceConclusion(
  task: SwarmTask,
  messages: vscode.LanguageModelChatMessage[],
  requestOptions: vscode.LanguageModelChatRequestOptions,
  log: (msg: string) => void,
): void {
  const forceMsg =
    "⚠️ FINAL ROUND — You have used all your tool rounds. " +
    "You MUST now produce a comprehensive text summary. Do NOT call any more tools.";
  messages.push(vscode.LanguageModelChatMessage.User(forceMsg));
  requestOptions.tools = undefined;
  log(`[SwarmWorker ${task.id}] Final round — tools removed`);
}

// ─── buildResult ───────────────────────────────────────────────────────

export interface BuildResultParams {
  taskId: string;
  text: string;
  toolCalls: SwarmResult["toolCalls"];
  modelId: string;
  tier: string;
  startTime: number;
  rounds: number;
  success: boolean;
  error: string | undefined;
  inputChars: number;
  outputChars: number;
  isPlanMode: boolean;
}

/** Build a SwarmResult object from execution data. */
export function buildResult(params: BuildResultParams): SwarmResult {
  return {
    taskId: params.taskId,
    text: params.text,
    toolCalls: params.toolCalls,
    model: params.modelId,
    tier: params.tier,
    durationMs: Date.now() - params.startTime,
    rounds: params.rounds,
    success: params.success,
    error: params.error,
    estimatedInputTokens: Math.ceil(params.inputChars / 4),
    estimatedOutputTokens: Math.ceil(params.outputChars / 4),
    isPlanOnly: params.isPlanMode || undefined,
  };
}

// ─── pushToolResult ────────────────────────────────────────────────────

/** Push a text tool result message to the messages array. */
export function pushToolResult(
  messages: vscode.LanguageModelChatMessage[],
  callId: string,
  text: string,
): void {
  messages.push(
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(callId, [
        new vscode.LanguageModelTextPart(text),
      ]),
    ]),
  );
}

// ─── handleToolError ───────────────────────────────────────────────────

export interface ErrorHandlerDeps {
  dynamicTools: DynamicToolSet;
  token: vscode.CancellationToken;
}

/** Handle tool invocation errors with auto-load retry and user-decline logic. */
export async function handleToolError(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: ErrorHandlerDeps,
  result: ToolDispatchResult,
  toolErr: unknown,
): Promise<ToolDispatchResult> {
  if (isUserCancellation(toolErr)) {
    ctx.declinedTools.add(toolCall.name);
    ctx.log(`[SwarmWorker ${ctx.task.id}] 🚫 User declined: ${toolCall.name}`);
    ctx.toolCallLog.push({
      name: toolCall.name,
      input: toolCall.input,
      error: "[user declined]",
    });
    pushToolResult(
      ctx.messages,
      toolCall.callId,
      `The user declined to execute "${toolCall.name}". Do NOT retry this tool. Use an alternative approach or skip.`,
    );
    return result;
  }

  if (deps.dynamicTools.isDynamic()) {
    const retryResult = await tryAutoLoadRetry(toolCall, ctx, deps, result);
    if (retryResult) return retryResult;
  }

  ctx.log(
    `[SwarmWorker ${ctx.task.id}] Tool error: ${toolCall.name}: ${toolErr}`,
  );
  ctx.toolCallLog.push({
    name: toolCall.name,
    input: toolCall.input,
    error: String(toolErr),
  });
  pushToolResult(
    ctx.messages,
    toolCall.callId,
    `Tool "${toolCall.name}" failed: ${toolErr}`,
  );
  return result;
}

async function tryAutoLoadRetry(
  toolCall: vscode.LanguageModelToolCallPart,
  ctx: ToolDispatchContext,
  deps: ErrorHandlerDeps,
  result: ToolDispatchResult,
): Promise<ToolDispatchResult | null> {
  const autoLoaded = deps.dynamicTools.tryAutoLoad(toolCall.name);
  if (!autoLoaded) return null;

  ctx.log(
    `[SwarmWorker ${ctx.task.id}] 🔄 Auto-loaded ${toolCall.name}, retrying...`,
  );
  result.toolsChanged = true;
  try {
    const retryResult = await vscode.lm.invokeTool(
      toolCall.name,
      {
        input: toolCall.input,
        toolInvocationToken: ctx.options?.toolInvocationToken,
      },
      deps.token,
    );
    const retryPreview = retryResult.content
      .map((c: unknown) => {
        const part = c as Record<string, unknown>;
        return "value" in part
          ? String(part.value).substring(0, 100)
          : "[non-text]";
      })
      .join(" ");
    result.inputCharsAdded += retryPreview.length;
    ctx.toolCallLog.push({
      name: toolCall.name,
      input: toolCall.input,
      result: `[auto-loaded] ${retryPreview}`,
    });
    ctx.messages.push(
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(
          toolCall.callId,
          retryResult.content,
        ),
      ]),
    );
    return result;
  } catch (retryErr) {
    ctx.log(`[SwarmWorker ${ctx.task.id}] 🔄 Retry also failed: ${retryErr}`);
    return null;
  }
}
