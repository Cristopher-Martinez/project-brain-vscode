/**
 * Delegation & Swarm LM Tools for Project Brain.
 *
 * Extracted from lm-tools.ts for modularity:
 * - DelegateTaskTool — delegates a prompt to a model via ModelRouter
 * - SwarmTool — multi-agent parallel execution with auto-decompose
 */

import * as vscode from "vscode";
import { DelegateTaskKind, ModelRouter, ModelTier } from "./model-router";
import {
  swarmComplete,
  swarmFail,
  swarmProgress,
  swarmStart,
} from "./swarm-state";

// ——— DelegateTask ———————————————————————————————————————————————

export interface DelegateTaskInput {
  prompt: string;
  taskKind?: string;
  maxTier?: string;
  maxRetries?: number;
}

export class DelegateTaskTool implements vscode.LanguageModelTool<DelegateTaskInput> {
  constructor(
    private modelRouter: ModelRouter,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DelegateTaskInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const {
      prompt,
      taskKind = "summarize",
      maxTier = "free",
      maxRetries,
    } = options.input;
    this.log(
      `[LM Tool] delegateTask: [${taskKind}] maxTier=${maxTier} prompt="${prompt.substring(0, 80)}..."`,
    );

    try {
      const models = this.modelRouter.getAvailableModels();
      if (models.length === 0) {
        await this.modelRouter.discoverModels();
      }

      const fallback = this.modelRouter.getAvailableModels()[0];
      if (!fallback) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "ERROR: No models available for delegation.",
          ),
        ]);
      }

      const result = await this.modelRouter.delegateTask(
        prompt,
        token,
        fallback,
        {
          taskKind: taskKind as DelegateTaskKind,
          maxTier: maxTier as ModelTier,
          maxRetries,
        },
      );

      const report = [
        `## Delegation Result`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Model** | ${result.decision.selectedModel.id} |`,
        `| **Tier** | ${result.decision.reason} |`,
        `| **Task Kind** | ${taskKind} |`,
        `| **Attempts** | ${result.attempts} |`,
        `| **Escalated** | ${result.wasEscalated ? "Yes ⬆️" : "No"} |`,
        `| **Validation** | ${result.validation.isValid ? "✅ Passed" : "❌ Failed"} (score: ${result.validation.score.toFixed(2)}) |`,
        `| **Time** | ${result.responseTimeMs}ms |`,
        ``,
        `### Output`,
        ``,
        result.text,
      ].join("\n");

      this.log(
        `[LM Tool] delegateTask: ✅ model=${result.decision.selectedModel.id}, score=${result.validation.score.toFixed(2)}, ${result.responseTimeMs}ms`,
      );

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(report),
      ]);
    } catch (err) {
      this.log(`[LM Tool] delegateTask error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Delegation failed: ${err}`),
      ]);
    }
  }
}

// ——— SwarmTask ——————————————————————————————————————————————————

export interface SwarmToolInput {
  goal: string;
  tasks?: {
    id: string;
    prompt: string;
    taskKind?: string;
    maxTier?: string;
  }[];
  concurrency?: number;
  useForks?: boolean;
}

export class SwarmTool implements vscode.LanguageModelTool<SwarmToolInput> {
  private autoCapture: { capture: (text: string) => Promise<number> } | null =
    null;

  constructor(
    private modelRouter: ModelRouter,
    private log: (msg: string) => void,
  ) {}

  /** Inject AutoCapture for swarm-to-neuroplasticity feedback loop. */
  setAutoCapture(capture: {
    capture: (text: string) => Promise<number>;
  }): void {
    this.autoCapture = capture;
  }

  /**
   * Auto-decompose: when no tasks provided, use LLM to break goal into subtasks.
   * Inspired by KiloCode's Orchestrator Mode — decomposes complex goals into
   * specialized worker tasks automatically.
   */
  private async autoDecompose(
    goal: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
  ): Promise<
    { id: string; prompt: string; taskKind: string; maxTier: string }[]
  > {
    const plannerPrompt = [
      `You are a task planner. Decompose this goal into 2-6 independent worker tasks.`,
      `Each worker runs in parallel with its own LLM + tools (file read/write, terminal, search).`,
      ``,
      `Goal: ${goal}`,
      ``,
      `Respond with ONLY a JSON array (no markdown, no explanation):`,
      `[{"id": "w1", "prompt": "detailed instruction", "taskKind": "raw|generate-code|code-review|summarize|extract|debug-analyze|refactor|document", "maxTier": "free|cheap|standard"}]`,
      ``,
      `Rules:`,
      `- Each task must be self-contained (workers can't see each other's output)`,
      `- Use descriptive IDs: "review-auth", "scan-deps", "test-api", etc.`,
      `- Match taskKind to the work type for optimal model selection`,
      `- Use "free" tier for simple tasks, "cheap" for code gen, "standard" for complex analysis`,
      `- Keep prompts specific and actionable — include file paths, function names, etc. when relevant`,
    ].join("\n");

    const messages = [vscode.LanguageModelChatMessage.User(plannerPrompt)];

    let responseText = "";
    const response = await model.sendRequest(messages, {}, token);
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        responseText += part.value;
      }
    }

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) {
      this.log(
        `[Swarm] Auto-decompose failed to parse: ${responseText.substring(0, 200)}`,
      );
      throw new Error("Auto-decompose: LLM response was not valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      id: string;
      prompt: string;
      taskKind?: string;
      maxTier?: string;
    }[];

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Auto-decompose: got empty task array");
    }

    // Validate and normalize
    return parsed.map((t, i) => ({
      id: t.id || `w${i + 1}`,
      prompt: t.prompt || goal,
      taskKind: t.taskKind || "raw",
      maxTier: t.maxTier || "free",
    }));
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SwarmToolInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { goal, concurrency } = options.input;
    let { tasks } = options.input;
    const useForks = options.input.useForks ?? false;

    try {
      const { SwarmOrchestrator } = await import("./swarm-orchestrator");
      const orchestrator = new SwarmOrchestrator(this.modelRouter, this.log);

      const models = this.modelRouter.getAvailableModels();
      if (models.length === 0) {
        await this.modelRouter.discoverModels();
      }
      const fallback = this.modelRouter.getAvailableModels()[0];
      if (!fallback) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "ERROR: No models available for swarm workers.",
          ),
        ]);
      }

      // ——— Auto-decompose: if no tasks, let LLM plan them ———————
      const isAutoDecompose = !tasks || tasks.length === 0;
      if (isAutoDecompose) {
        this.log(`[LM Tool] swarm: auto-decompose mode for goal="${goal}"`);
        try {
          tasks = await this.autoDecompose(goal, fallback, token);
          this.log(
            `[LM Tool] swarm: decomposed into ${tasks.length} tasks: ${tasks.map((t) => t.id).join(", ")}`,
          );
        } catch (err) {
          this.log(`[LM Tool] swarm: auto-decompose failed: ${err}`);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Auto-decompose failed: ${err}. Provide explicit tasks[] instead.`,
            ),
          ]);
        }
      }

      swarmStart({
        goal,
        concurrency: concurrency ?? 4,
        taskIds: tasks!.map((t) => t.id),
      });
      this.log(
        `[LM Tool] swarm: goal="${goal}", tasks=${tasks!.length}${isAutoDecompose ? " (auto-planned)" : ""}, concurrency=${concurrency ?? 4}`,
      );

      const swarmTasks = tasks!.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        taskKind: (t.taskKind ??
          "raw") as import("./model-router-types").DelegateTaskKind,
        maxTier: (t.maxTier ?? "free") as ModelTier,
      }));

      const report = await orchestrator.execute(
        { goal, tasks: swarmTasks, concurrency, useForks },
        token,
        fallback,
        {
          onProgress: (taskId, msg) => {
            this.log(`[Swarm ${taskId}] ${msg}`);
            swarmProgress(taskId, msg);
          },
        },
      );

      // ─── Neuroplasticity feedback: capture learnings from workers ───
      if (this.autoCapture) {
        const successTexts = report.results
          .filter((r) => r.success && r.text.length > 50)
          .map((r) => r.text);
        if (successTexts.length > 0) {
          const combined = successTexts.join("\n\n---\n\n");
          this.autoCapture.capture(combined).catch((err) => {
            this.log(`[Swarm] AutoCapture feedback failed: ${err}`);
          });
        }
      }

      const output = orchestrator.formatReport(report);
      swarmComplete({
        summary: output,
        workers: report.results.map((r) => ({
          taskId: r.taskId,
          success: r.success,
          error: r.error,
          model: r.model,
          tier: r.tier,
          rounds: r.rounds,
          toolCalls: r.toolCalls.length,
          durationMs: r.durationMs,
          estimatedInputTokens: r.estimatedInputTokens ?? 0,
          estimatedOutputTokens: r.estimatedOutputTokens ?? 0,
          message: r.success ? "✅ Complete" : `❌ ${r.error ?? "Failed"}`,
        })),
      });
      this.log(
        `[LM Tool] swarm: ✅ ${report.successCount}/${report.results.length} succeeded, ${report.totalToolCalls} tool calls, ~${((report.totalEstimatedInputTokens + report.totalEstimatedOutputTokens) / 1000).toFixed(1)}K tokens, ${report.totalDurationMs}ms`,
      );

      const autoTag = isAutoDecompose
        ? `\n\n> **Auto-decomposed** from goal into ${tasks!.length} tasks: ${tasks!.map((t) => t.id).join(", ")}\n`
        : "";
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(autoTag + output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] swarm error: ${err}`);
      swarmFail(String(err));
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Swarm failed: ${err}`),
      ]);
    }
  }
}


