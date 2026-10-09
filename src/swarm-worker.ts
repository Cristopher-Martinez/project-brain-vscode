// ─── SwarmWorker ───────────────────────────────────────────────────────
// Autonomous agentic worker — thin orchestrator.
// All heavy logic extracted to swarm-* modules.

import * as vscode from "vscode";
import { DynamicToolSet } from "./dynamic-tool-set";
import type { ModelRouter } from "./model-router";
import { buildPlanningPrompt, planOnlyToolFilter } from "./plan-approval";
import {
  buildWorkerSystemPrompt,
  buildWorkspaceBlock,
  selectModel,
} from "./swarm-model-selection";
import {
  GREP_TOOL_DEFINITION,
  LIST_DIR_TOOL_DEFINITION,
  MAILBOX_TOOL_DEFINITION,
  READ_FILE_TOOL_DEFINITION,
  SUB_AGENT_TOOL_DEFINITION,
} from "./swarm-tool-defs";
import { dispatchToolCall, type DispatchDeps } from "./swarm-tool-dispatch";
import {
  checkMailboxHooks,
  defaultToolFilter,
  toolInfoToChat,
} from "./swarm-tool-helpers";
import type {
  AgenticLoopState,
  SwarmResult,
  SwarmTask,
  SwarmWorkerOptions,
  ToolDispatchContext,
} from "./swarm-types";
import {
  buildResult,
  deduplicateToolCalls,
  forceConclusion,
  injectMailboxContext,
  sendAndCollect,
} from "./swarm-worker-utils";

// Re-export types so consumers don't need to change imports
export type { SwarmResult, SwarmTask, SwarmWorkerOptions } from "./swarm-types";

/**
 * Autonomous agentic worker that runs independently with its own model,
 * tools, and agentic loop. Uses real VS Code tool API for reliability.
 *
 * Usage:
 * ```typescript
 * const worker = new SwarmWorker(modelRouter, log);
 * const result = await worker.execute(task, token, fallbackModel);
 * ```
 */
export class SwarmWorker {
  constructor(
    private modelRouter: ModelRouter,
    private log: (msg: string) => void,
  ) {}

  async execute(
    task: SwarmTask,
    token: vscode.CancellationToken,
    fallbackModel: vscode.LanguageModelChat,
    options?: SwarmWorkerOptions,
  ): Promise<SwarmResult> {
    const startTime = Date.now();
    const toolCallLog: SwarmResult["toolCalls"] = [];
    const maxRounds = task.maxToolRounds ?? 8;
    const progress = options?.onProgress ?? (() => {});
    let inputChars = 0;
    const outputChars = 0;
    const isPlanMode = options?.planOnly === true;

    progress(task.id, "Selecting model...");
    this.log(
      `[SwarmWorker ${task.id}] Starting: prompt="${task.prompt.substring(0, 80)}...", ` +
        `maxRounds=${maxRounds}, taskKind=${task.taskKind ?? "raw"}, planOnly=${isPlanMode}`,
    );

    // ─── Step 1: Select model ─────────────────────────────────
    const { model, tierLabel } = await selectModel(
      task,
      fallbackModel,
      this.modelRouter,
      this.log,
    );
    this.log(`[SwarmWorker ${task.id}] Model: ${model.id} (${tierLabel})`);
    progress(task.id, `Model: ${model.id} (${tierLabel})`);

    // ─── Step 2: Gather tools ─────────────────────────────────
    const {
      tools: initialTools,
      dynamicTools,
      virtualTools,
      availableTools,
    } = this.gatherTools(task, options, isPlanMode);
    const tools = initialTools;

    // ─── Step 3: Build messages ───────────────────────────────
    const { messages, systemPromptLength } = this.buildInitialMessages(
      task,
      options,
      isPlanMode,
      dynamicTools,
    );
    inputChars += systemPromptLength + task.prompt.length;

    const requestOptions: vscode.LanguageModelChatRequestOptions = {
      tools: tools.length > 0 ? tools : undefined,
    };

    // ─── Step 4: Agentic loop ─────────────────────────────────
    return this.runAgenticLoop({
      task,
      token,
      model,
      options,
      isPlanMode,
      maxRounds,
      messages,
      requestOptions,
      tools,
      dynamicTools,
      virtualTools,
      availableTools,
      toolCallLog,
      progress,
      startTime,
      tierLabel,
      inputChars,
      outputChars,
    });
  }

  /** Gather and filter tools for the worker, including virtual tools. */
  private gatherTools(
    task: SwarmTask,
    options: SwarmWorkerOptions | undefined,
    isPlanMode: boolean,
  ): {
    tools: vscode.LanguageModelChatTool[];
    dynamicTools: DynamicToolSet;
    virtualTools: vscode.LanguageModelChatTool[];
    availableTools: vscode.LanguageModelChatTool[];
  } {
    const filter = isPlanMode
      ? planOnlyToolFilter
      : (task.toolFilter ?? defaultToolFilter);
    const allLmTools = vscode.lm.tools;
    const availableTools = allLmTools.filter(filter).map(toolInfoToChat);
    const HARD_LIMIT = 128;
    const hasMailbox = !!options?.mailbox && !isPlanMode;

    // Build virtual tools list
    const virtualTools: vscode.LanguageModelChatTool[] = [];
    if (hasMailbox) virtualTools.push(MAILBOX_TOOL_DEFINITION);
    if (!isPlanMode) virtualTools.push(SUB_AGENT_TOOL_DEFINITION);
    virtualTools.push(READ_FILE_TOOL_DEFINITION);
    virtualTools.push(LIST_DIR_TOOL_DEFINITION);
    virtualTools.push(GREP_TOOL_DEFINITION);

    // Initialize DynamicToolSet
    const dynamicTools = new DynamicToolSet({
      corePrefixes: [
        "projectBrain_",
        "mcp_rag-docs_",
        "copilot_",
        "mcp_console-ninja_",
        "terminal_",
      ],
      coreNames: [
        "kill_terminal",
        "await_terminal",
        "get_terminal_output",
        "mcp_gitkraken_repository_get_file_content",
      ],
      maxPerRequest: HARD_LIMIT,
      autoThreshold: 40,
      log: this.log,
    });
    const isDynamic = dynamicTools.initialize(
      availableTools,
      virtualTools.length,
    );

    if (isDynamic) {
      const preloaded = dynamicTools.preloadForTask(
        task.prompt + " " + (task.systemPrompt ?? ""),
      );
      if (preloaded.length > 0) {
        this.log(
          `[SwarmWorker ${task.id}] 🧠 Pre-loaded: ${preloaded.join(", ")}`,
        );
      }
    }

    const tools = dynamicTools.getActiveTools(availableTools, virtualTools);
    this.log(`[SwarmWorker ${task.id}] Tools: ${tools.length} available`);

    return { tools, dynamicTools, virtualTools, availableTools };
  }

  /** Build the initial message array with system prompt + user prompt. */
  private buildInitialMessages(
    task: SwarmTask,
    options: SwarmWorkerOptions | undefined,
    isPlanMode: boolean,
    dynamicTools: DynamicToolSet,
  ): {
    messages: vscode.LanguageModelChatMessage[];
    systemPromptLength: number;
  } {
    const hasMailbox = !!options?.mailbox && !isPlanMode;
    const systemPrompt = isPlanMode
      ? buildPlanningPrompt(task.id)
      : (task.systemPrompt ??
        buildWorkerSystemPrompt(task.taskKind ?? "raw", task.id, hasMailbox));

    const dynamicHint = dynamicTools.getSystemPromptHint();
    const workspaceBlock = buildWorkspaceBlock();

    const fullSystemPrompt = [systemPrompt, dynamicHint, workspaceBlock]
      .filter(Boolean)
      .join("\n");

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(fullSystemPrompt),
      vscode.LanguageModelChatMessage.User(task.prompt),
    ];

    return { messages, systemPromptLength: fullSystemPrompt.length };
  }

  /** Run the main agentic loop. Extracted to keep execute() under 60 lines. */
  private async runAgenticLoop(ctx: {
    task: SwarmTask;
    token: vscode.CancellationToken;
    model: vscode.LanguageModelChat;
    options?: SwarmWorkerOptions;
    isPlanMode: boolean;
    maxRounds: number;
    messages: vscode.LanguageModelChatMessage[];
    requestOptions: vscode.LanguageModelChatRequestOptions;
    tools: vscode.LanguageModelChatTool[];
    dynamicTools: DynamicToolSet;
    virtualTools: vscode.LanguageModelChatTool[];
    availableTools: vscode.LanguageModelChatTool[];
    toolCallLog: SwarmResult["toolCalls"];
    progress: (taskId: string, message: string) => void;
    startTime: number;
    tierLabel: string;
    inputChars: number;
    outputChars: number;
  }): Promise<SwarmResult> {
    let fullText = "";
    let rounds = 0;
    const loopState: AgenticLoopState = {
      lastMailboxCheck: 0,
      hasPostedToMailbox: false,
      mailboxNudged: false,
      mailboxReadBeforeExit: false,
    };
    const declinedTools = new Set<string>();
    let { maxRounds, inputChars, outputChars, tools } = ctx;

    try {
      for (let round = 0; round < maxRounds; round++) {
        rounds = round + 1;
        ctx.progress(ctx.task.id, `Round ${rounds}/${maxRounds}...`);

        // ─── Mailbox check between rounds ───────────────────
        injectMailboxContext(
          ctx.options,
          ctx.task,
          ctx.messages,
          loopState,
          round,
          this.log,
        );

        // ─── Force conclusion on final round ────────────────
        if (round === maxRounds - 1) {
          forceConclusion(ctx.task, ctx.messages, ctx.requestOptions, this.log);
        }

        // ─── Send request + collect stream ──────────────────
        const { textParts, toolCallParts, textCollected, outputCollected } =
          await sendAndCollect({
            model: ctx.model,
            messages: ctx.messages,
            requestOptions: ctx.requestOptions,
            token: ctx.token,
            task: ctx.task,
            options: ctx.options,
            existingText: fullText,
            log: this.log,
          });
        fullText += textCollected;
        outputChars += outputCollected;

        // ─── No tool calls → check mailbox hooks or done ────
        if (toolCallParts.length === 0) {
          if (textParts.length > 0) {
            const assistantText = textParts.map((p) => p.value).join("");
            if (assistantText.trim()) {
              ctx.messages.push(
                vscode.LanguageModelChatMessage.Assistant(assistantText),
              );
            }
          }

          const hookResult = checkMailboxHooks({
            options: ctx.options,
            task: ctx.task,
            messages: ctx.messages,
            loopState,
            isPlanMode: ctx.isPlanMode,
            requestOptions: ctx.requestOptions,
            tools,
            round,
            maxRounds,
            log: this.log,
          });
          if (hookResult.shouldContinue) {
            maxRounds = hookResult.newMaxRounds;
            inputChars += hookResult.inputCharsAdded;
            continue;
          }
          this.log(
            `[SwarmWorker ${ctx.task.id}] Round ${rounds}: text only — done`,
          );
          break;
        }

        // ─── Deduplicate + dispatch tool calls ──────────────
        const uniqueToolCalls = deduplicateToolCalls(
          toolCallParts,
          ctx.task.id,
          this.log,
        );
        ctx.messages.push(
          vscode.LanguageModelChatMessage.Assistant(uniqueToolCalls),
        );

        const dispatchCtx: ToolDispatchContext = {
          task: ctx.task,
          options: ctx.options,
          messages: ctx.messages,
          toolCallLog: ctx.toolCallLog,
          declinedTools,
          loopState,
          log: this.log,
        };
        const deps: DispatchDeps = {
          dynamicTools: ctx.dynamicTools,
          model: ctx.model,
          token: ctx.token,
          availableTools: ctx.availableTools,
          virtualTools: ctx.virtualTools,
          progress: ctx.progress,
        };

        let toolsChanged = false;
        for (const toolCall of uniqueToolCalls) {
          const result = await dispatchToolCall(toolCall, dispatchCtx, deps);
          inputChars += result.inputCharsAdded;
          outputChars += result.outputCharsAdded;
          if (result.toolsChanged) toolsChanged = true;
        }

        // ─── Update tools if DynamicToolSet changed ─────────
        if (toolsChanged && ctx.dynamicTools.isDynamic()) {
          const newTools = ctx.dynamicTools.getActiveTools(
            ctx.availableTools,
            ctx.virtualTools,
          );
          ctx.requestOptions.tools = newTools.length > 0 ? newTools : undefined;
          tools = newTools;
        }
      }

      ctx.progress(ctx.task.id, "✅ Complete");
      return buildResult({
        taskId: ctx.task.id,
        text: fullText,
        toolCalls: ctx.toolCallLog,
        modelId: ctx.model.id,
        tier: ctx.tierLabel,
        startTime: ctx.startTime,
        rounds,
        success: true,
        error: undefined,
        inputChars,
        outputChars,
        isPlanMode: ctx.isPlanMode,
      });
    } catch (err) {
      const errorMsg = String(err);
      this.log(`[SwarmWorker ${ctx.task.id}] FAILED: ${errorMsg}`);
      return buildResult({
        taskId: ctx.task.id,
        text: fullText,
        toolCalls: ctx.toolCallLog,
        modelId: ctx.model.id,
        tier: ctx.tierLabel,
        startTime: ctx.startTime,
        rounds,
        success: false,
        error: errorMsg,
        inputChars,
        outputChars,
        isPlanMode: ctx.isPlanMode,
      });
    }
  }
}
