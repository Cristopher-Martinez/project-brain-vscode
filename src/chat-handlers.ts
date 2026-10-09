import * as vscode from "vscode";
import { AgentIdentityManager } from "./agent-identity";
import { AutoCapture } from "./auto-capture";
import { DynamicToolSet, LOAD_TOOLS_NAME } from "./dynamic-tool-set";
import { handleLoopSlashCommand } from "./loop-connect";
import { getLoopRecoveryInfo } from "./loop-recovery";
import { ModelRouter } from "./model-router";
import type { PromptLoader } from "./prompt-loader";
import { PromptManager, parsePromptCommand } from "./prompt-manager";

function normalizeToolInputSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const asRecord = schema as Record<string, unknown>;
  const type = asRecord.type;

  // Some providers require object schemas to explicitly include `properties`.
  if (type === "object" || type === undefined) {
    const props = asRecord.properties;
    if (!props || typeof props !== "object") {
      return { ...asRecord, type: "object", properties: {} };
    }
  }

  return asRecord;
}

// ─── Tool confirmation helpers ─────────────────────────────────────────────
// Detect when a user declines a VS Code tool confirmation dialog so we can
// feed a helpful message to the LLM instead of a generic "tool failed" error.

function isUserCancellation(err: unknown): boolean {
  if (err instanceof vscode.CancellationError) {
    return true;
  }
  const msg = String(err).toLowerCase();
  return (
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("user declined") ||
    msg.includes("confirmation was not accepted") ||
    msg.includes("was not confirmed")
  );
}

function mayRequireConfirmation(toolName: string): boolean {
  // Our own tools and RAG-docs never trigger confirmation dialogs
  if (toolName.startsWith("projectBrain_")) {
    return false;
  }
  if (toolName.startsWith("mcp_rag-docs_")) {
    return false;
  }
  // MCP tools and copilot tools generally show a confirmation dialog
  if (toolName.startsWith("mcp_")) {
    return true;
  }
  if (toolName.startsWith("copilot_")) {
    return true;
  }
  return false;
}

// ─── Handler Context (Parameter Object pattern) ────────────────────────────
// Reduces Long Parameter List smell: handlers receive ONE context object
// instead of 6-10 individual parameters.

/**
 * Shared dependencies for all @brain slash command handlers.
 * Created once by registerChatParticipant, passed to every handler.
 */
export interface HandlerContext {
  readonly searchMemoryFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>;
  readonly identityManager: AgentIdentityManager;
  readonly log: (msg: string) => void;
  readonly modelRouter?: ModelRouter;
  readonly autoCapture?: AutoCapture;
  readonly promptLoader?: PromptLoader;
  readonly promptManager?: PromptManager;
}

// ─── System Prompts ────────────────────────────────────────────────────────

export const BASE_SYSTEM_PROMPT = `You are an AI assistant with access to this project's documentation memory.

RULES:
1. You have been given relevant project context from the memory search below. USE IT.
2. Reference specific files and line numbers when possible.
3. If the memory context doesn't cover the user's question, say so explicitly.
4. After helping with code changes, update the relevant memory file.
5. Be direct and actionable.`;

export const DOC_PROMPT = `You are a documentation generator for Project Brain.
Based on the user's description of what changed, generate a documentation entry in this exact format:

## [Clear Descriptive Title]

**Date**: [today's date]
**Tags**: keyword1, keyword2, keyword3
**Status**: resolved

### Context
[What was the situation?]

### Problem / Goal
[What triggered this?]

### Approach
[What was done?]

### Solution / Outcome
[What was the result?]

### Lessons Learned
[What should future developers know?]

Output ONLY the markdown entry, nothing else.`;

export const BOOTSTRAP_SYSTEM_PROMPT = `You are a brand new AI assistant that was just born into a software project. You have no name yet, no identity.

Your BOOTSTRAP ritual is conversational and programming-focused:

PHASE 1 — Identity (keep it quick and fun):
1. Introduce yourself warmly: "Hey! I just came online. I don't have a name or identity yet."
2. Ask the user: Who am I? What kind of creature? What's my vibe? Pick me an emoji!
3. Ask about them: What's your name? How should I call you?

PHASE 2 — Programming DNA (this is the core):
4. Architecture & patterns: "What architecture patterns do you love/hate? (MVC, clean arch, microservices, monolith, etc.)"
5. Code style: "How do you like your code? (verbose/explicit vs concise, comments everywhere vs self-documenting, etc.)"
6. Testing philosophy: "Testing approach? (TDD zealot, test after, integration-heavy, E2E only, 'tests are optional'?)"
7. Git workflow: "Git flow? (feature branches, trunk-based, squash vs merge commits, conventional commits?)"
8. Code review: "Code review style? (async PR comments, pair programming, 'just merge it', pedantic vs pragmatic?)"
9. Documentation: "Docs preference? (inline comments, README-driven, wikis, 'code is the docs'?)"
10. Open question: "Anything else I should know about how you work?"

RULES:
- Be playful and creative. Offer 3-5 suggestions when they're stuck.
- DON'T be robotic or formal. This is a conversation, not a form.
- DON'T ask about tech stack or languages — you already auto-detect that from project files.
- DO ask follow-up questions if their answers are vague.
- Phase 1 should take 2-3 exchanges. Phase 2 can be deeper if they want.

IMPORTANT: At the end, summarize what was decided as a structured block like this:
---
IDENTITY:
- Name: [chosen name]
- Creature: [chosen creature]
- Vibe: [chosen vibe]
- Emoji: [chosen emoji]

USER:
- Name: [their name]
- Address: [how to call them]

PROGRAMMING DNA:
- Architecture: [patterns they prefer]
- Code Style: [their preferences]
- Testing: [their approach]
- Git Workflow: [their flow]
- Code Review: [their style]
- Documentation: [their preference]
- Other: [any additional notes]
---

This is your birth. Make it memorable AND useful.`;

// ─── Default Handler ───────────────────────────────────────────────────────

export async function handleDefaultRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  // Step 0: Capture directive user messages (preferences, rules, corrections)
  if (ctx.autoCapture && request.prompt.length >= 15) {
    const directivePatterns =
      /\b(siempre|nunca|recuerda que|always|never|remember that|dont|no uses|usa siempre|prefiero|prefer)\b/i;
    if (directivePatterns.test(request.prompt)) {
      await ctx.autoCapture.capture(request.prompt, "user-directive");
      ctx.log(`@brain: Captured user directive from prompt`);
    }
  }

  // Step 1: ALWAYS search memory (mechanical — cannot be skipped)
  stream.progress("Searching project memory...");
  ctx.log(`@brain DEFAULT: searching memory for "${request.prompt}"`);

  let memoryContext = "";
  try {
    memoryContext = await ctx.searchMemoryFn(request.prompt);
  } catch (err) {
    ctx.log(`@brain: memory search failed: ${err}`);
    memoryContext = "(Memory search unavailable — index may need rebuilding)";
  }

  // Step 2: Build system prompt with identity + memory
  const identityPrompt = ctx.identityManager.getIdentityPrompt();

  const systemParts: string[] = [];
  if (identityPrompt) systemParts.push(identityPrompt);
  systemParts.push(BASE_SYSTEM_PROMPT);
  const systemPrompt = systemParts.join("\n\n---\n\n");

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(
      `## Project Memory Context (auto-retrieved)\n\n${memoryContext || "(No relevant memory found for this query)"}`,
    ),
  ];

  // Add conversation history
  const previousMessages = chatContext.history.filter(
    (h) => h instanceof vscode.ChatResponseTurn,
  );
  for (const turn of previousMessages) {
    let fullMessage = "";
    for (const part of turn.response) {
      if (part instanceof vscode.ChatResponseMarkdownPart) {
        fullMessage += part.value.value;
      }
    }
    if (fullMessage) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
    }
  }

  // Add user's actual question
  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

  // Step 3: Gather ALL available tools for agentic mode
  const allTools: vscode.LanguageModelChatTool[] = vscode.lm.tools.map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: normalizeToolInputSchema(tool.inputSchema),
    }),
  );

  // Use DynamicToolSet for smart tool management
  // Core prefixes: memory & brain tools are ALWAYS available (never deferred).
  // copilot_ tools included for notebook/workspace integration.
  // console-ninja_ + terminal_ for runtime debugging & terminal management.
  const chatDynamic = new DynamicToolSet({
    corePrefixes: [
      "projectBrain_",
      "mcp_rag-docs_",
      "copilot_",
      "mcp_console-ninja_",
      "terminal_",
    ],
    coreNames: ["kill_terminal", "await_terminal"],
    maxPerRequest: 128,
    autoThreshold: 40,
    log: ctx.log,
  });
  chatDynamic.initialize(allTools);
  // Pre-load tools based on user's message keywords
  if (chatDynamic.isDynamic()) {
    const preloaded = chatDynamic.preloadForTask(request.prompt);
    if (preloaded.length > 0) {
      ctx.log(
        `@brain: Pre-loaded categories for user message: ${preloaded.join(", ")}`,
      );
    }
  }
  let selectedTools = chatDynamic.getActiveTools(allTools);

  const requestOptions: vscode.LanguageModelChatRequestOptions = {
    tools: selectedTools.length > 0 ? selectedTools : undefined,
  };

  ctx.log(
    `@brain DEFAULT: ${allTools.length} tools available, ${selectedTools.length} active (dynamic: ${chatDynamic.isDynamic()})`,
  );

  // Step 4: Agentic loop — stream response, handle tool calls, repeat
  const MAX_TOOL_ROUNDS = 10;
  const declinedTools = new Set<string>(); // tracks tools user refused via confirmation dialog

  try {
    let routingDecision: import("./model-router").RoutingDecision | undefined;
    let routingStartTime = 0;
    let hasCodeContent = false;
    let fullResponse = "";
    let selectedModel: vscode.LanguageModelChat = request.model;
    let effectiveRequestOptions: vscode.LanguageModelChatRequestOptions =
      requestOptions;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response: vscode.LanguageModelChatResponse;

      // Route on first round; re-use same model for subsequent tool rounds
      if (ctx.modelRouter && round === 0) {
        const routed = await ctx.modelRouter.routeRequest(
          messages,
          token,
          request.model,
          request.prompt,
          undefined,
          ctx.modelRouter.brainTier,
          requestOptions,
        );
        response = routed.response;
        routingDecision = routed.decision;
        routingStartTime = routed.startTime;
        selectedModel = routed.decision.selectedModel;
        effectiveRequestOptions = routed.requestOptionsUsed;
        stream.progress(
          `🧠 ${routed.decision.selectedModel.family} (${routed.decision.reason})`,
        );
      } else {
        response = await selectedModel.sendRequest(
          messages,
          effectiveRequestOptions,
          token,
        );
      }

      // Process the response stream (text + tool calls)
      const textParts: vscode.LanguageModelTextPart[] = [];
      const toolCallParts: vscode.LanguageModelToolCallPart[] = [];

      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          stream.markdown(part.value);
          fullResponse += part.value;
          textParts.push(part);
          if (/```|function |class /.test(part.value)) {
            hasCodeContent = true;
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCallParts.push(part);
        }
      }

      // No tool calls → we're done
      if (toolCallParts.length === 0) {
        break;
      }

      // Add assistant message (text + tool calls) to conversation
      const assistantParts: (
        | vscode.LanguageModelTextPart
        | vscode.LanguageModelToolCallPart
      )[] = [...textParts, ...toolCallParts];
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      // Execute each tool call and add results
      for (const toolCall of toolCallParts) {
        ctx.log(
          `@brain TOOL CALL [round ${round + 1}]: ${toolCall.name}(${JSON.stringify(toolCall.input).substring(0, 100)})`,
        );
        stream.progress(`🔧 ${toolCall.name}...`);

        try {
          // ─── Intercept dynamic tool meta-calls ────────────
          if (
            chatDynamic.isDynamic() &&
            chatDynamic.isMetaTool(toolCall.name)
          ) {
            const metaResult = chatDynamic.handleToolCall(
              toolCall.name,
              toolCall.input,
            );
            ctx.log(
              `@brain META-TOOL: ${toolCall.name} → ${(metaResult ?? "").substring(0, 80)}`,
            );
            if (toolCall.name === LOAD_TOOLS_NAME) {
              // Refresh tools for next round
              selectedTools = chatDynamic.getActiveTools(allTools);
              effectiveRequestOptions = {
                ...effectiveRequestOptions,
                tools: selectedTools.length > 0 ? selectedTools : undefined,
              };
              ctx.log(
                `@brain: Tools updated after load: ${selectedTools.length} active`,
              );
            }
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(toolCall.callId, [
                  new vscode.LanguageModelTextPart(metaResult ?? ""),
                ]),
              ]),
            );
            continue;
          }

          // ─── Check if user previously declined this tool ───────
          if (declinedTools.has(toolCall.name)) {
            ctx.log(
              `@brain: ⛔ Skipping ${toolCall.name} (user previously declined)`,
            );
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(toolCall.callId, [
                  new vscode.LanguageModelTextPart(
                    `Tool "${toolCall.name}" was previously declined by the user. ` +
                      `Do NOT retry this tool. Use an alternative approach or skip this step entirely.`,
                  ),
                ]),
              ]),
            );
            continue;
          }

          // ─── Signal user if tool may require confirmation ────────
          if (mayRequireConfirmation(toolCall.name)) {
            stream.progress(`🔐 Awaiting approval for ${toolCall.name}...`);
          }

          const toolResult = await vscode.lm.invokeTool(
            toolCall.name,
            {
              input: toolCall.input,
              toolInvocationToken: request.toolInvocationToken,
            },
            token,
          );
          messages.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelToolResultPart(
                toolCall.callId,
                toolResult.content,
              ),
            ]),
          );
        } catch (toolErr) {
          // ─── User declined the confirmation dialog ──────────────
          if (isUserCancellation(toolErr)) {
            declinedTools.add(toolCall.name);
            ctx.log(`@brain: 🚫 User declined: ${toolCall.name}`);
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(toolCall.callId, [
                  new vscode.LanguageModelTextPart(
                    `The user declined to execute "${toolCall.name}". ` +
                      `This is a user choice — do NOT retry this tool. ` +
                      `Use an alternative approach, a different tool, or skip this step.`,
                  ),
                ]),
              ]),
            );
            continue;
          }

          // Try auto-loading from registry if dynamic mode is active
          if (chatDynamic.isDynamic()) {
            const autoLoaded = chatDynamic.tryAutoLoad(toolCall.name);
            if (autoLoaded) {
              ctx.log(`@brain: Auto-loaded ${toolCall.name}, retrying...`);
              selectedTools = chatDynamic.getActiveTools(allTools);
              effectiveRequestOptions = {
                ...effectiveRequestOptions,
                tools: selectedTools.length > 0 ? selectedTools : undefined,
              };
              try {
                const retryResult = await vscode.lm.invokeTool(
                  toolCall.name,
                  {
                    input: toolCall.input,
                    toolInvocationToken: request.toolInvocationToken,
                  },
                  token,
                );
                messages.push(
                  vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(
                      toolCall.callId,
                      retryResult.content,
                    ),
                  ]),
                );
                continue;
              } catch (retryErr) {
                ctx.log(`@brain: Auto-load retry also failed: ${retryErr}`);
              }
            }
          }
          ctx.log(`@brain TOOL ERROR: ${toolCall.name}: ${toolErr}`);
          messages.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelToolResultPart(toolCall.callId, [
                new vscode.LanguageModelTextPart(
                  `Tool "${toolCall.name}" failed: ${toolErr}`,
                ),
              ]),
            ]),
          );
        }
      }

      ctx.log(
        `@brain: Tool round ${round + 1} complete — ${toolCallParts.length} tool(s) called, looping...`,
      );
    }

    // Record result for learning
    if (ctx.modelRouter && routingDecision) {
      ctx.modelRouter.recordResult(
        routingDecision,
        routingStartTime,
        fullResponse,
      );
    }

    // Auto-capture learnings from LLM response
    if (ctx.autoCapture && fullResponse) {
      await ctx.autoCapture.capture(fullResponse, "llm-response");
    }

    return { metadata: { hasCodeChanges: hasCodeContent } };
  } catch (err) {
    ctx.log(`@brain: LLM request failed: ${err}`);

    // Detect if a loop was interrupted by this cancellation
    const loopRecovery = getLoopRecoveryInfo();
    if (loopRecovery) {
      ctx.log(
        `@brain: Loop ${loopRecovery.sessionId.substring(0, 8)} was active during cancellation`,
      );
      stream.markdown(
        `⚠️ **Loop interrumpido** — La solicitud fue cancelada mientras el loop \`${loopRecovery.sessionId.substring(0, 8)}\` estaba activo.\n\n` +
          `**Objetivo:** ${loopRecovery.goal}\n` +
          `**Iteraciones completadas:** ${loopRecovery.iterationCount}\n\n` +
          `El loop se puede reanudar usando el botón de abajo o desde Brain HQ.\n`,
      );
      return {
        metadata: { error: true, hasCodeChanges: false, loopInterrupted: true },
      };
    }

    if (memoryContext) {
      stream.markdown(
        "⚠️ Could not reach the language model, but here's what I found in memory:\n\n",
      );
      stream.markdown(memoryContext);
    } else {
      stream.markdown(
        "⚠️ Language model unavailable and no memory results found.",
      );
    }

    return { metadata: { hasCodeChanges: false, error: true } };
  }
}

// ─── /doc Command ──────────────────────────────────────────────────────────

export async function handleDocCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  if (!request.prompt.trim()) {
    stream.markdown(
      "Please describe what changed. Example:\n\n" +
        "`@brain /doc Added session handoff system for context window continuity`",
    );
    return { metadata: {} };
  }

  stream.progress("Generating documentation entry...");
  ctx.log(`@brain /doc: generating entry for "${request.prompt}"`);

  // Inject identity into the doc generation prompt
  const identityPrompt = ctx.identityManager.getIdentityPrompt();
  const docParts: string[] = [];
  if (identityPrompt) docParts.push(identityPrompt);
  docParts.push(DOC_PROMPT);
  const docSystemPrompt = docParts.join("\n\n---\n\n");

  const messages = [
    vscode.LanguageModelChatMessage.User(docSystemPrompt),
    vscode.LanguageModelChatMessage.User(
      `Generate a documentation entry for this change:\n\n${request.prompt}`,
    ),
  ];

  try {
    let response: vscode.LanguageModelChatResponse;
    let routingDecision: import("./model-router").RoutingDecision | undefined;
    let routingStartTime = 0;

    if (ctx.modelRouter) {
      const routed = await ctx.modelRouter.routeRequest(
        messages,
        token,
        request.model,
        request.prompt,
        "doc",
        ctx.modelRouter.brainTier,
      );
      response = routed.response;
      routingDecision = routed.decision;
      routingStartTime = routed.startTime;
    } else {
      response = await request.model.sendRequest(messages, {}, token);
    }

    let fullResponse = "";
    for await (const fragment of response.text) {
      stream.markdown(fragment);
      fullResponse += fragment;
    }

    if (ctx.modelRouter && routingDecision) {
      ctx.modelRouter.recordResult(
        routingDecision,
        routingStartTime,
        fullResponse,
      );
    }

    // Suggest where to put it
    stream.markdown("\n\n---\n");
    stream.markdown(
      "**Suggested location**: Copy the above entry to the appropriate file:\n",
    );
    stream.markdown("- Bug fix → `.project-brain/memory/05_TROUBLESHOOTING.md`\n");
    stream.markdown("- New feature → `.project-brain/memory/01_ARCHITECTURE.md`\n");
    stream.markdown("- Lesson learned → `.project-brain/memory/04_LEARNINGS.md`\n");
    stream.markdown("- Dependency change → `.project-brain/memory/03_DEPENDENCIES.md`\n");

    stream.button({
      command: "projectBrain.openMemory",
      title: "Open Memory Folder",
    });

    return { metadata: { hasCodeChanges: false } };
  } catch (err) {
    ctx.log(`@brain /doc: LLM request failed: ${err}`);
    stream.markdown(
      "⚠️ Could not generate documentation. Language model unavailable.",
    );
    return { metadata: {} };
  }
}

// ─── /router Command ──────────────────────────────────────────────────────

/**
 * /router command — Show model router status and optionally test slave delegation.
 *
 * Usage:
 *   @brain /router           → Show status table (models, tiers, success rates)
 *   @brain /router test      → Run a live delegation test with a summarize task
 *   @brain /router test code → Run a code-generation delegation test
 */
export async function handleRouterCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  if (!ctx.modelRouter) {
    stream.markdown("⚠️ Model Router not initialized.");
    return { metadata: {} };
  }

  const prompt = request.prompt.trim().toLowerCase();

  // ─── Test delegation mode ──────────────────────────────────
  if (prompt.startsWith("test")) {
    const testType = prompt.replace("test", "").trim();
    return handleRouterTest(testType, stream, token, request.model, ctx);
  }

  // ─── Default: show status ──────────────────────────────────
  stream.markdown(ctx.modelRouter.getStatus());
  stream.markdown("\n\n---\n");
  stream.markdown(
    "💡 **Tip:** Use `@brain /router test` to run a live slave delegation test.\n",
  );

  return { metadata: {} };
}

/**
 * Run a live delegation test — sends a real sub-task to a slave model
 * and reports the full pipeline: model selected, validation, retries, powers.
 */
async function handleRouterTest(
  testType: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  fallbackModel: vscode.LanguageModelChat,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  type TestTask = {
    taskKind: import("./model-router").DelegateTaskKind;
    prompt: string;
    label: string;
  };

  const tests: Record<string, TestTask> = {
    "": {
      taskKind: "summarize",
      prompt:
        "Project Brain is a VS Code extension that transforms codebases into self-documenting, " +
        "RAG-powered workspaces. It generates structured markdown docs in .project-brain/memory/, configures " +
        "an MCP RAG server for semantic search, and uses auto-vectorization to keep everything in sync. " +
        "It has a ModelRouter that routes tasks to appropriate LLM tiers: ultra for Brain thinking, " +
        "free models for grunt work. The extension supports multi-root workspaces, has a chat participant " +
        "@brain, and includes 13 skills for various tasks.",
      label: "Summarize (free slave)",
    },
    code: {
      taskKind: "generate-code",
      prompt:
        "Write a TypeScript function called `formatDuration(ms: number): string` that takes " +
        "milliseconds and returns a human-readable string like '2m 30s' or '1h 5m'. Handle edge " +
        "cases: negative numbers return '0s', values under 1000 return '<1s'.",
      label: "Generate Code (free slave)",
    },
    review: {
      taskKind: "code-review",
      prompt:
        "Review this code:\n```typescript\nasync function fetchData(url) {\n  const res = await fetch(url);\n" +
        "  const data = res.json();\n  return data;\n}\n```",
      label: "Code Review (free slave)",
    },
    list: {
      taskKind: "list",
      prompt:
        "List all the model tiers used in Project Brain's ModelRouter: ultra, premium, standard, cheap, free. " +
        "For each tier, give one example model.",
      label: "List (free slave)",
    },
  };

  const test = tests[testType] ?? tests[""];

  stream.markdown(`## 🧪 Delegation Test: ${test.label}\n\n`);
  stream.markdown(`**Task kind:** \`${test.taskKind}\`\n`);
  stream.markdown(`**Max tier:** \`free\` (cheapest possible)\n`);
  stream.markdown(`**Prompt:** ${test.prompt.substring(0, 100)}...\n\n`);
  stream.progress(`Delegating ${test.taskKind} to slave model...`);

  try {
    const startTime = Date.now();
    const result = await ctx.modelRouter!.delegateTask(
      test.prompt,
      token,
      fallbackModel,
      {
        taskKind: test.taskKind,
        maxTier: "free",
        maxRetries: 2,
      },
    );
    const elapsed = Date.now() - startTime;

    // Report results
    stream.markdown("### Results\n\n");
    stream.markdown(`| Metric | Value |\n|--------|-------|\n`);
    stream.markdown(
      `| **Model used** | ${result.decision.selectedModel.id} |\n`,
    );
    stream.markdown(`| **Tier** | ${result.decision.reason} |\n`);
    stream.markdown(`| **Attempts** | ${result.attempts} |\n`);
    stream.markdown(
      `| **Escalated** | ${result.wasEscalated ? "Yes ⬆️" : "No"} |\n`,
    );
    stream.markdown(
      `| **Validation** | ${result.validation.isValid ? "✅ Passed" : "❌ Failed"} (score: ${result.validation.score.toFixed(2)}) |\n`,
    );
    stream.markdown(`| **Total time** | ${elapsed}ms |\n`);
    stream.markdown(
      `| **Response length** | ${result.text.length} chars |\n\n`,
    );

    if (result.validation.issues.length > 0) {
      stream.markdown(
        `**Validation issues:** ${result.validation.issues.join(", ")}\n\n`,
      );
    }

    stream.markdown("### Slave Output\n\n");
    stream.markdown(result.text);
    stream.markdown("\n");
  } catch (err) {
    ctx.log(`@brain /router test: delegation failed: ${err}`);
    stream.markdown(`\n⚠️ **Delegation failed:** ${err}\n`);
  }

  return { metadata: { delegationTest: true } };
}

// ─── /status Command ───────────────────────────────────────────────────────

export async function handleStatusCommand(
  stream: vscode.ChatResponseStream,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  stream.progress("Checking project memory status...");
  ctx.log("@brain /status: checking memory");

  try {
    const overview = await ctx.searchMemoryFn("project overview purpose goals");
    const arch = await ctx.searchMemoryFn("architecture patterns design");

    stream.markdown("## Project Brain Status\n\n");

    if (overview) {
      stream.markdown("### Overview\n");
      stream.markdown(overview.slice(0, 500));
      stream.markdown("\n\n");
    }

    if (arch) {
      stream.markdown("### Architecture\n");
      stream.markdown(arch.slice(0, 500));
      stream.markdown("\n");
    }

    stream.button({
      command: "projectBrain.status",
      title: "Full Status Panel",
    });
  } catch (err) {
    ctx.log(`@brain /status: failed: ${err}`);
    stream.markdown(
      "⚠️ Could not retrieve project status. Is the memory initialized?",
    );
  }

  return { metadata: {} };
}

// ─── /search Command ───────────────────────────────────────────────────────

export async function handleSearchCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  if (!request.prompt.trim()) {
    stream.markdown(
      "Please provide a search query. Example:\n\n" +
        "`@brain /search architecture embedding system`",
    );
    return { metadata: {} };
  }

  stream.progress(`Searching: "${request.prompt}"...`);
  ctx.log(`@brain /search: "${request.prompt}"`);

  try {
    const results = await ctx.searchMemoryFn(request.prompt);
    if (results) {
      stream.markdown(`## Memory Search: "${request.prompt}"\n\n`);
      stream.markdown(results);
    } else {
      stream.markdown(`No results found for "${request.prompt}".`);
    }
  } catch (err) {
    ctx.log(`@brain /search: failed: ${err}`);
    stream.markdown("⚠️ Search failed. Is the RAG index built?");
  }

  return { metadata: {} };
}

// ─── /identity Command ─────────────────────────────────────────────────────

export async function handleIdentityCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  const identity = ctx.identityManager.loadIdentity();

  if (!request.prompt.trim()) {
    if (!identity) {
      stream.markdown("## No identity configured\n\n");
      stream.markdown("I don't have an identity yet. Let's set one up!\n\n");
      stream.button({
        command: "projectBrain.configureIdentity",
        title: "🧠 Configure Identity",
      });
      return { metadata: {} };
    }

    stream.markdown("## 🧠 Current Identity\n\n");
    stream.markdown(`- **Name**: ${identity.name}\n`);
    stream.markdown(`- **Creature**: ${identity.creature}\n`);
    stream.markdown(`- **Vibe**: ${identity.vibe}\n`);
    stream.markdown(`- **Emoji**: ${identity.emoji}\n`);
    stream.markdown(`- **Theme**: ${identity.theme || "—"}\n`);
    stream.markdown(`- **Language**: ${identity.language}\n`);

    stream.markdown("\n---\n");
    stream.button({
      command: "projectBrain.configureIdentity",
      title: "♻️ Reconfigure",
    });
    stream.button({
      command: "projectBrain.openIdentityFile",
      title: "📝 Edit File",
    });
    return { metadata: {} };
  }

  stream.markdown("Launching identity configuration...\n\n");
  stream.button({
    command: "projectBrain.configureIdentity",
    title: "🧠 Configure Identity",
  });
  return { metadata: {} };
}

// ─── /soul Command ─────────────────────────────────────────────────────────

export async function handleSoulCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  const soul = ctx.identityManager.loadSoul();

  if (!request.prompt.trim()) {
    if (!soul) {
      stream.markdown("## No soul configured\n\n");
      stream.markdown(
        "I don't have behavior rules yet. Let's define my soul!\n\n",
      );
      stream.button({
        command: "projectBrain.configureSoul",
        title: "🫀 Configure Soul",
      });
      return { metadata: {} };
    }

    stream.markdown("## 🫀 Current Soul\n\n");
    stream.markdown(`- **Tone**: ${soul.tone}\n`);
    stream.markdown(`- **Approach**: ${soul.approach}\n`);
    if (soul.boundaries)
      stream.markdown(`\n**Boundaries**:\n${soul.boundaries}\n`);
    if (soul.customRules)
      stream.markdown(`\n**Custom Rules**:\n${soul.customRules}\n`);
    if (soul.roleplayIntensity !== undefined)
      stream.markdown(
        `\n**Roleplay Intensity**: ${soul.roleplayIntensity}/10\n`,
      );
    if (soul.quirks?.length)
      stream.markdown(
        `\n**Quirks**:\n${soul.quirks.map((q) => `- ${q}`).join("\n")}\n`,
      );
    if (soul.catchphrases) {
      stream.markdown(`\n**Catchphrases**:\n`);
      if (soul.catchphrases.success?.length)
        stream.markdown(
          `- ✅ Success: ${soul.catchphrases.success.join(" · ")}\n`,
        );
      if (soul.catchphrases.complexity?.length)
        stream.markdown(
          `- 🧩 Complexity: ${soul.catchphrases.complexity.join(" · ")}\n`,
        );
      if (soul.catchphrases.warnings?.length)
        stream.markdown(
          `- ⚠️ Warnings: ${soul.catchphrases.warnings.join(" · ")}\n`,
        );
    }
    if (soul.voiceTags?.length)
      stream.markdown(`\n**Voice Tags**: ${soul.voiceTags.join(" · ")}\n`);
    if (soul.relationships)
      stream.markdown(`\n**Relationships**:\n${soul.relationships}\n`);

    // Show auto-detected project essence
    const essence = ctx.identityManager.extractProjectEssence();
    if (essence) {
      stream.markdown(`\n**Project context** _(auto-detected)_:\n`);
      stream.markdown(`- Type: ${essence.projectType}\n`);
      stream.markdown(`- Languages: ${essence.languages.join(", ")}\n`);
      if (essence.frameworks.length > 0) {
        stream.markdown(`- Frameworks: ${essence.frameworks.join(", ")}\n`);
      }
    }

    stream.markdown("\n---\n");
    stream.button({
      command: "projectBrain.configureSoul",
      title: "♻️ Reconfigure",
    });
    stream.button({
      command: "projectBrain.openSoulFile",
      title: "📝 Edit File",
    });
    return { metadata: {} };
  }

  stream.button({
    command: "projectBrain.configureSoul",
    title: "🫀 Configure Soul",
  });
  return { metadata: {} };
}

// ─── /user Command ─────────────────────────────────────────────────────────

export async function handleUserCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  const user = ctx.identityManager.loadUser();

  if (!request.prompt.trim()) {
    if (!user) {
      stream.markdown("## No user profile configured\n\n");
      stream.markdown("I don't know who you are yet. Let's fix that!\n\n");
      stream.button({
        command: "projectBrain.configureUser",
        title: "👤 Set Up Profile",
      });
      return { metadata: {} };
    }

    stream.markdown("## 👤 User Profile\n\n");
    stream.markdown(`- **Name**: ${user.name}\n`);
    stream.markdown(`- **Preferred address**: ${user.preferredAddress}\n`);
    stream.markdown(`- **Timezone**: ${user.timezone || "—"}\n`);
    if (user.notes) stream.markdown(`- **Notes**: ${user.notes}\n`);

    stream.markdown("\n---\n");
    stream.button({
      command: "projectBrain.configureUser",
      title: "♻️ Reconfigure",
    });
    stream.button({
      command: "projectBrain.openUserFile",
      title: "📝 Edit File",
    });
    return { metadata: {} };
  }

  stream.button({
    command: "projectBrain.configureUser",
    title: "👤 Set Up Profile",
  });
  return { metadata: {} };
}

// ─── Bootstrap Handler ─────────────────────────────────────────────────────

export async function handleBootstrapConversation(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  ctx.log("@brain: no identity — entering bootstrap mode");

  // ── Visible banner so we KNOW bootstrap triggered ──
  stream.markdown("## 🌟 Bootstrap Mode\n\n");
  stream.progress("First run — let's figure out who I am...");

  // Detect project essence to give the bootstrap conversation context
  const essence = ctx.identityManager.extractProjectEssence();
  let projectContext = "";
  if (essence) {
    projectContext = `\n\nPROJECT CONTEXT (auto-detected, don't ask the user about this):\n- Project type: ${essence.projectType}\n- Languages: ${essence.languages.join(", ")}\n- Frameworks: ${essence.frameworks.join(", ") || "none detected"}\n- Key dependencies: ${essence.keyDependencies.slice(0, 8).join(", ") || "none"}\n${essence.description ? `- Description: ${essence.description}` : ""}\n\nYou already know this project's tech stack. Don't ask about it — focus on personality and identity.`;
  }

  const bootstrapPrompt = ctx.promptLoader
    ? ctx.promptLoader.getBootstrapPrompt()
    : BOOTSTRAP_SYSTEM_PROMPT;

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(bootstrapPrompt + projectContext),
    vscode.LanguageModelChatMessage.User(
      request.prompt.trim()
        ? `The user said: "${request.prompt}"\n\nRespond to them as part of the bootstrap conversation.`
        : "This is the very first message. Start the bootstrap ritual — introduce yourself and begin the conversation.",
    ),
  ];

  try {
    let response: vscode.LanguageModelChatResponse;
    if (ctx.modelRouter) {
      const routed = await ctx.modelRouter.routeRequest(
        messages,
        token,
        request.model,
        request.prompt,
        undefined,
        ctx.modelRouter.brainTier,
      );
      response = routed.response;
    } else {
      response = await request.model.sendRequest(messages, {}, token);
    }
    for await (const fragment of response.text) {
      stream.markdown(fragment);
    }
  } catch (err) {
    ctx.log(`@brain bootstrap: LLM failed: ${err}`);
    stream.markdown("## 🌟 Welcome! I'm brand new.\n\n");
    stream.markdown("I don't have an identity yet. Let's set one up!\n\n");
    stream.markdown(
      "I couldn't start a conversation right now, but you can configure me with the wizard:\n\n",
    );
  }

  stream.markdown("\n\n---\n");
  stream.markdown(
    "**Ready to make it official?** Use the wizard to save the identity:\n\n",
  );

  stream.button({
    command: "projectBrain.configureIdentity",
    title: "🧠 Configure Identity",
  });
  stream.button({
    command: "projectBrain.configureSoul",
    title: "🫀 Configure Soul",
  });
  stream.button({
    command: "projectBrain.configureUser",
    title: "👤 Set Up User Profile",
  });
  stream.button({
    command: "projectBrain.configureProgrammingPrefs",
    title: "💻 Configure Programming Prefs",
  });

  return { metadata: { bootstrap: true } };
}

// ─── /spawn Command ────────────────────────────────────────────────────────

export async function handleSpawnCommand(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  ctx.log("@brain /spawn command invoked");

  const identity = ctx.identityManager.loadIdentity();
  const lang = identity?.language ?? "English";
  const isEs = /espa[nñ]ol|spanish/i.test(lang);

  stream.markdown(
    isEs
      ? "## 🔄 Solicitud de Nueva Sesión\n\n"
      : "## 🔄 New Session Request\n\n",
  );
  stream.markdown(
    isEs
      ? "Construyendo resumen de la conversación del historial de chat...\n\n"
      : "Building conversation summary from chat history...\n\n",
  );

  try {
    const task = request.prompt.trim() || undefined;

    // Build conversation summary from REAL chat history
    const conversationSummary = await buildConversationSummary(
      chatContext,
      token,
      ctx.log,
    );

    stream.markdown(
      isEs
        ? "Preparando datos y abriendo formulario de confirmación obligatorio...\n\n"
        : "Preparing data and opening mandatory confirmation form...\n\n",
    );

    await vscode.commands.executeCommand("projectBrain.spawnSession", {
      reason: task ? `Spawn: ${task}` : "Context window running low",
      task,
      silent: true,
      conversationSummary,
    });

    stream.markdown(
      isEs
        ? "✅ **Nueva sesión iniciada (confirmada por formulario).**\n\n"
        : "✅ **New session started (confirmed via form).**\n\n",
    );
    stream.markdown(
      isEs ? "La nueva sesión va a:\n" : "The new session will:\n",
    );
    stream.markdown(
      isEs
        ? "1. Leer `TASK_QUEUE.md` con el resumen de la conversación\n"
        : "1. Read `TASK_QUEUE.md` with your conversation summary\n",
    );
    stream.markdown(
      isEs
        ? "2. Buscar en memoria contexto relevante\n"
        : "2. Search memory for relevant context\n",
    );
    stream.markdown(
      isEs
        ? "3. Continuar donde lo dejamos\n\n"
        : "3. Continue from where we left off\n\n",
    );

    if (task) {
      stream.markdown(`**Task forwarded**: ${task}\n`);
    }
  } catch (err) {
    ctx.log(`@brain /spawn error: ${err}`);
    stream.markdown(
      `⚠️ ${isEs ? "Auto-spawn falló" : "Auto-spawn failed"}: ${err}\n\n`,
    );
    stream.markdown(
      "**Manual spawn**: Open Command Palette → `Project Brain: Spawn New Session`\n",
    );
  }

  return { metadata: { spawned: true } };
}

// ─── Utilities ─────────────────────────────────────────────────────────────

/**
 * Build a conversation summary from real chat history.
 * Extracts user prompts from chatContext.history, then asks an LM
 * to summarize them. Falls back to raw prompts if no LM available.
 */
export async function buildConversationSummary(
  chatContext: vscode.ChatContext,
  token: vscode.CancellationToken,
  log: (msg: string) => void,
): Promise<string> {
  const userPrompts: string[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const cmd = turn.command ? `/${turn.command} ` : "";
      userPrompts.push(`${cmd}${turn.prompt}`);
    }
  }

  if (!userPrompts.length) {
    log("[Spawn] No chat history available for summary");
    return "";
  }

  log(`[Spawn] Building summary from ${userPrompts.length} user messages`);

  const transcript = userPrompts
    .slice(-15)
    .map((p, i) => `[${i + 1}] ${p}`)
    .join("\n");

  // Try to summarize with LM
  try {
    const models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o-mini",
    });

    if (models.length) {
      const model = models[0];
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `You are a session handoff assistant. Summarize the following conversation transcript (max 200 words) for a fresh AI instance that will continue the work.

Rules:
- ONLY describe what the user asked and discussed — do NOT invent details
- Mention specific files, functions, and technical decisions
- State what was completed and what remains in progress
- If the conversation is about code changes, describe WHICH changes

=== CONVERSATION TRANSCRIPT ===
${transcript}
=== END TRANSCRIPT ===

Summarize now. Be factual and specific.`,
        ),
      ];

      let summary = "";
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        summary += chunk;
      }

      log(
        `[Spawn] LM conversation summary generated (${summary.length} chars)`,
      );
      return summary.trim();
    }
  } catch (err) {
    log(`[Spawn] LM summary failed, using raw transcript: ${err}`);
  }

  log("[Spawn] Using raw transcript as summary (no LM available)");
  return `User messages from this session:\n${transcript}`;
}

// ─── /prompt Command ───────────────────────────────────────────────────────

/**
 * Handle the /prompt slash command.
 *
 * Actions:
 *   /prompt --save <name> <text>  → Save a reusable prompt
 *   /prompt <name>                → Inject the saved prompt into LLM context
 *   /prompt --list                → Show all saved prompts
 *   /prompt --delete <name>       → Delete a prompt
 *   /prompt                       → Show usage help
 */
export async function handlePromptCommand(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  const { log, promptManager } = ctx;

  if (!promptManager) {
    stream.markdown(
      "⚠️ PromptManager no está disponible. ¿Se inicializó la memoria del proyecto?\n",
    );
    return { metadata: { error: true } };
  }

  const parsed = parsePromptCommand(request.prompt);
  log(
    `@brain /prompt: action=${parsed.action}, name=${parsed.name ?? "(none)"}`,
  );

  switch (parsed.action) {
    // ─── SAVE ──────────────────────────────────────────────────────────
    case "save": {
      if (!parsed.name) {
        stream.markdown(
          "⚠️ Falta el nombre. Uso: `/prompt --save <nombre> <texto del prompt>`\n",
        );
        return { metadata: {} };
      }
      if (!parsed.content) {
        stream.markdown(
          `⚠️ Falta el contenido del prompt. Uso:\n\n` +
            "```\n@brain /prompt --save " +
            parsed.name +
            " Tu prompt aquí...\n```\n",
        );
        return { metadata: {} };
      }

      const saved = promptManager.save(parsed.name, parsed.content);
      stream.markdown(
        `✅ Prompt **"${saved.name}"** guardado.\n\n` +
          `Para usarlo: \`@brain /prompt ${saved.name}\`\n`,
      );
      return { metadata: { promptSaved: saved.name } };
    }

    // ─── LIST ──────────────────────────────────────────────────────────
    case "list": {
      const all = promptManager.list();
      if (all.length === 0) {
        stream.markdown(
          "📭 No tienes prompts guardados aún.\n\n" +
            "Para guardar uno:\n```\n@brain /prompt --save <nombre> <texto>\n```\n",
        );
        return { metadata: {} };
      }

      stream.markdown(`## 📋 Prompts guardados (${all.length})\n\n`);
      for (const p of all) {
        const preview =
          p.content.length > 80
            ? p.content.substring(0, 80) + "..."
            : p.content;
        stream.markdown(
          `- **${p.name}** — \`${preview}\`\n  _(actualizado: ${p.updatedAt.split("T")[0]})_\n`,
        );
      }
      stream.markdown(
        `\nUso: \`@brain /prompt <nombre>\` para inyectar uno.\n`,
      );
      return { metadata: { promptCount: all.length } };
    }

    // ─── DELETE ────────────────────────────────────────────────────────
    case "delete": {
      if (!parsed.name) {
        stream.markdown(
          "⚠️ Falta el nombre. Uso: `/prompt --delete <nombre>`\n",
        );
        return { metadata: {} };
      }

      const deleted = promptManager.delete(parsed.name);
      if (deleted) {
        stream.markdown(`🗑️ Prompt **"${parsed.name}"** eliminado.\n`);
      } else {
        stream.markdown(
          `⚠️ No existe un prompt llamado **"${parsed.name}"**.\n\n` +
            "Usa `/prompt --list` para ver los disponibles.\n",
        );
      }
      return { metadata: { promptDeleted: deleted } };
    }

    // ─── GET (inject prompt) ──────────────────────────────────────────
    case "get": {
      if (!parsed.name) {
        stream.markdown(
          "⚠️ Falta el nombre del prompt. Uso: `/prompt <nombre>`\n",
        );
        return { metadata: {} };
      }

      const prompt = promptManager.get(parsed.name);
      if (!prompt) {
        // Fuzzy search for suggestions
        const similar = promptManager.search(parsed.name);
        let msg = `⚠️ No existe un prompt llamado **"${parsed.name}"**.\n\n`;
        if (similar.length > 0) {
          msg += "¿Quisiste decir?\n";
          for (const s of similar) {
            msg += `- \`/prompt ${s.name}\`\n`;
          }
        } else {
          msg += "Usa `/prompt --list` para ver los disponibles.\n";
        }
        stream.markdown(msg);
        return { metadata: {} };
      }

      // Inject the saved prompt as a user message to the LLM
      log(
        `@brain /prompt: injecting prompt "${prompt.name}" (${prompt.content.length} chars)`,
      );
      stream.progress(`Inyectando prompt: "${prompt.name}"...`);

      // Use the default handler with the saved prompt content
      // We create a synthetic request-like flow: search memory + LLM call
      try {
        const memoryContext = await ctx.searchMemoryFn(
          prompt.content.substring(0, 200),
        );

        const identity = ctx.identityManager.loadIdentity();
        const identityPrompt = identity
          ? `You are ${identity.name} (${identity.creature}). Vibe: ${identity.vibe}. Language: ${identity.language}.`
          : "";

        const systemPrompt = [
          BASE_SYSTEM_PROMPT,
          identityPrompt,
          memoryContext ? `\n## Project Memory Context\n${memoryContext}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
        if (!models.length) {
          stream.markdown(
            "⚠️ No hay modelo disponible para procesar el prompt.\n",
          );
          return { metadata: { error: true } };
        }

        const promptMessages: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User(systemPrompt),
          // Include conversation history for context
          ...chatContext.history.flatMap((turn) => {
            if (turn instanceof vscode.ChatRequestTurn) {
              return [vscode.LanguageModelChatMessage.User(turn.prompt)];
            } else if (turn instanceof vscode.ChatResponseTurn) {
              const text = turn.response
                .filter(
                  (p): p is vscode.ChatResponseMarkdownPart =>
                    p instanceof vscode.ChatResponseMarkdownPart,
                )
                .map((p) => p.value.value)
                .join("");
              return text
                ? [vscode.LanguageModelChatMessage.Assistant(text)]
                : [];
            }
            return [];
          }),
          vscode.LanguageModelChatMessage.User(prompt.content),
        ];

        // Gather all tools for agentic mode
        const allTools: vscode.LanguageModelChatTool[] = vscode.lm.tools.map(
          (t) => ({
            name: t.name,
            description: t.description,
            inputSchema: normalizeToolInputSchema(t.inputSchema),
          }),
        );

        // Use DynamicToolSet for smart tool management
        // Core prefixes: memory & brain tools are ALWAYS available (never deferred).
        // copilot_ tools included for notebook/workspace integration.
        // console-ninja_ + terminal_ for runtime debugging & terminal management.
        const promptDynamic = new DynamicToolSet({
          corePrefixes: [
            "projectBrain_",
            "mcp_rag-docs_",
            "copilot_",
            "mcp_console-ninja_",
            "terminal_",
          ],
          coreNames: ["kill_terminal", "await_terminal"],
          maxPerRequest: 128,
          autoThreshold: 40,
          log,
        });
        promptDynamic.initialize(allTools);
        // Pre-load tools based on prompt content
        if (promptDynamic.isDynamic()) {
          const preloaded = promptDynamic.preloadForTask(
            prompt.content + " " + systemPrompt,
          );
          if (preloaded.length > 0) {
            log(
              `@brain /prompt: Pre-loaded categories: ${preloaded.join(", ")}`,
            );
          }
        }
        let promptSelectedTools = promptDynamic.getActiveTools(allTools);
        let promptRequestOptions: vscode.LanguageModelChatRequestOptions = {
          tools:
            promptSelectedTools.length > 0 ? promptSelectedTools : undefined,
        };

        let fullResponse = "";
        const MAX_ROUNDS = 10;
        const activeModel = models[0];
        const promptDeclinedTools = new Set<string>(); // tracks tools user refused via confirmation dialog

        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await activeModel.sendRequest(
            promptMessages,
            promptRequestOptions,
            token,
          );

          const textParts: vscode.LanguageModelTextPart[] = [];
          const toolCallParts: vscode.LanguageModelToolCallPart[] = [];

          for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              stream.markdown(part.value);
              fullResponse += part.value;
              textParts.push(part);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              toolCallParts.push(part);
            }
          }

          if (toolCallParts.length === 0) break;

          // Add assistant parts + execute tool calls
          promptMessages.push(
            vscode.LanguageModelChatMessage.Assistant([
              ...textParts,
              ...toolCallParts,
            ]),
          );

          for (const toolCall of toolCallParts) {
            log(
              `@brain /prompt TOOL CALL [round ${round + 1}]: ${toolCall.name}`,
            );
            stream.progress(`🔧 ${toolCall.name}...`);

            try {
              // ─── Intercept dynamic tool meta-calls ────────────
              if (
                promptDynamic.isDynamic() &&
                promptDynamic.isMetaTool(toolCall.name)
              ) {
                const metaResult = promptDynamic.handleToolCall(
                  toolCall.name,
                  toolCall.input,
                );
                log(`@brain /prompt META-TOOL: ${toolCall.name}`);
                if (toolCall.name === LOAD_TOOLS_NAME) {
                  promptSelectedTools = promptDynamic.getActiveTools(allTools);
                  promptRequestOptions = {
                    ...promptRequestOptions,
                    tools:
                      promptSelectedTools.length > 0
                        ? promptSelectedTools
                        : undefined,
                  };
                }
                promptMessages.push(
                  vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(toolCall.callId, [
                      new vscode.LanguageModelTextPart(metaResult ?? ""),
                    ]),
                  ]),
                );
                continue;
              }

              // ─── Check if user previously declined this tool ──────
              if (promptDeclinedTools.has(toolCall.name)) {
                log(
                  `@brain /prompt: ⛔ Skipping ${toolCall.name} (user previously declined)`,
                );
                promptMessages.push(
                  vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(toolCall.callId, [
                      new vscode.LanguageModelTextPart(
                        `Tool "${toolCall.name}" was previously declined by the user. ` +
                          `Do NOT retry this tool. Use an alternative approach or skip this step entirely.`,
                      ),
                    ]),
                  ]),
                );
                continue;
              }

              // ─── Signal user if tool may require confirmation ──────
              if (mayRequireConfirmation(toolCall.name)) {
                stream.progress(`🔐 Awaiting approval for ${toolCall.name}...`);
              }

              const toolResult = await vscode.lm.invokeTool(
                toolCall.name,
                {
                  input: toolCall.input,
                  toolInvocationToken: request.toolInvocationToken,
                },
                token,
              );
              promptMessages.push(
                vscode.LanguageModelChatMessage.User([
                  new vscode.LanguageModelToolResultPart(
                    toolCall.callId,
                    toolResult.content,
                  ),
                ]),
              );
            } catch (toolErr) {
              // ─── User declined the confirmation dialog ─────────
              if (isUserCancellation(toolErr)) {
                promptDeclinedTools.add(toolCall.name);
                log(`@brain /prompt: 🚫 User declined: ${toolCall.name}`);
                promptMessages.push(
                  vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(toolCall.callId, [
                      new vscode.LanguageModelTextPart(
                        `The user declined to execute "${toolCall.name}". ` +
                          `This is a user choice — do NOT retry this tool. ` +
                          `Use an alternative approach, a different tool, or skip this step.`,
                      ),
                    ]),
                  ]),
                );
                continue;
              }

              // Try auto-loading from registry if dynamic mode is active
              if (promptDynamic.isDynamic()) {
                const autoLoaded = promptDynamic.tryAutoLoad(toolCall.name);
                if (autoLoaded) {
                  log(
                    `@brain /prompt: Auto-loaded ${toolCall.name}, retrying...`,
                  );
                  promptSelectedTools = promptDynamic.getActiveTools(allTools);
                  promptRequestOptions = {
                    ...promptRequestOptions,
                    tools:
                      promptSelectedTools.length > 0
                        ? promptSelectedTools
                        : undefined,
                  };
                  try {
                    const retryResult = await vscode.lm.invokeTool(
                      toolCall.name,
                      {
                        input: toolCall.input,
                        toolInvocationToken: request.toolInvocationToken,
                      },
                      token,
                    );
                    promptMessages.push(
                      vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(
                          toolCall.callId,
                          retryResult.content,
                        ),
                      ]),
                    );
                    continue;
                  } catch (retryErr) {
                    log(`@brain /prompt: Auto-load retry failed: ${retryErr}`);
                  }
                }
              }
              promptMessages.push(
                vscode.LanguageModelChatMessage.User([
                  new vscode.LanguageModelToolResultPart(toolCall.callId, [
                    new vscode.LanguageModelTextPart(
                      `Tool "${toolCall.name}" failed: ${toolErr}`,
                    ),
                  ]),
                ]),
              );
            }
          }
        }

        // AutoCapture from response
        if (ctx.autoCapture && fullResponse) {
          await ctx.autoCapture.capture(fullResponse, "llm-response");
        }

        return {
          metadata: {
            promptUsed: prompt.name,
            hasCodeChanges: /```/.test(fullResponse),
          },
        };
      } catch (err) {
        log(`@brain /prompt: LLM error: ${err}`);
        stream.markdown(`⚠️ Error al procesar el prompt: ${err}\n`);
        return { metadata: { error: true } };
      }
    }

    // ─── HELP ──────────────────────────────────────────────────────────
    case "help":
    default: {
      const all = promptManager.list();
      stream.markdown(
        `## 📦 Prompt Manager\n\n` +
          `Guarda y reutiliza prompts con un solo comando.\n\n` +
          `### Comandos\n\n` +
          `| Acción | Comando |\n` +
          `|--------|---------|\n` +
          `| Guardar | \`/prompt --save <nombre> <texto>\` |\n` +
          `| Usar | \`/prompt <nombre>\` |\n` +
          `| Listar | \`/prompt --list\` |\n` +
          `| Eliminar | \`/prompt --delete <nombre>\` |\n\n`,
      );

      if (all.length > 0) {
        stream.markdown(`### Prompts guardados (${all.length})\n\n`);
        for (const p of all) {
          stream.markdown(`- \`${p.name}\`\n`);
        }
      } else {
        stream.markdown(
          "_No tienes prompts guardados. Empieza con:_\n" +
            "```\n@brain /prompt --save moderador Eres un moderador de discusiones...\n```\n",
        );
      }
      return { metadata: {} };
    }
  }
}

// ─── Loop Command (/loop) ──────────────────────────────────────────────────

/**
 * /loop — Starts or continues an interactive feedback loop.
 *
 * This initiates Loop Mode: the agent processes a goal/prompt, then enters
 * a continuous feedback cycle with the user via Brain HQ.
 *
 * Unlike orchestration (multi-agent) or swarm (parallel workers), loop is
 * a 1:1 interactive cycle: process → synthesize → await feedback → repeat.
 */
export async function handleLoopCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  return handleLoopSlashCommand(request, stream, token, ctx);
}
