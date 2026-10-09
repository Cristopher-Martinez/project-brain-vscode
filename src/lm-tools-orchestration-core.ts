/**
 * Orchestration LM Tools — Core execution
 *
 * Contains: OrchestrateTool
 */

import * as vscode from "vscode";
import { ModelRouter } from "./model-router";
import { dequeueOrchTask, getOrchConfig } from "./orchestration-config";
import { OrchestrationManager } from "./orchestration-manager";
import {
  OrchestrationSession,
  type AgentSlotConfig,
} from "./orchestration-session";
import { orchSetPromptEnhancement } from "./orchestration-state";

interface OrchestrateInput {
  prompt?: string;
  sessionId?: string;
}

export class OrchestrateTool implements vscode.LanguageModelTool<OrchestrateInput> {
  constructor(
    private modelRouter: ModelRouter,
    private orchestrationManager: OrchestrationManager,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OrchestrateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const prompt = options.input.prompt;
    const sessionId = options.input.sessionId;

    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⛔ Error: sessionId es requerido para orquestar. Asegúrate de extraerlo del prompt inicial.",
        ),
      ]);
    }

    let activeOrchSession = this.orchestrationManager.getSession(sessionId);
    const isNewSession = !activeOrchSession;

    // —— Create session if not active ————————————————————————————————
    if (!activeOrchSession) {
      const config = getOrchConfig(sessionId);
      if (!config) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "⛔ No hay configuración de orquestación pendiente. Configura el equipo desde Brain HQ y haz click en 'Launch Session'.",
          ),
        ]);
      }

      const teamConfig: AgentSlotConfig[] = config.team.map((t) => ({
        agent: t.agent,
        modelId: t.modelId,
        tier: t.tier,
      }));

      activeOrchSession = new OrchestrationSession({
        goal: config.goal,
        team: teamConfig,
        mode: config.mode || "parallel",
        orchestratorModelId: config.orchestratorModelId,
        modelRouter: this.modelRouter,
        log: this.log,
        useMailbox: config.useMailbox,
        requiresPlanApproval: config.requiresPlanApproval,
        autoApproveLowRisk: config.autoApproveLowRisk,
        useBranchIsolation: config.useBranchIsolation,
        toolInvocationToken: options.toolInvocationToken,
      });

      this.orchestrationManager.createSession(sessionId, activeOrchSession);

      this.log(
        `[Orchestrate] Session created: ${teamConfig.length} agents, goal="${config.goal.substring(0, 60)}"`,
      );
    }

    // —— Dispatch single round ———————————————————————————————————————
    const queuedPrompt = !prompt ? dequeueOrchTask(sessionId) : null;
    let currentPrompt = prompt || queuedPrompt || activeOrchSession.goal;

    // We need to track rounds per session. Let's add it to OrchestrationSession or Manager.
    // For now, let's assume OrchestrationSession tracks its own rounds, or we add it.
    // Let's add roundCounter to OrchestrationSession.
    const roundNumber = activeOrchSession.roundCount + 1;

    // —— Prompt Enhancement (first round only, if enabled) ————————
    const config = getOrchConfig(sessionId);
    let promptWasEnhanced = false;
    const originalPromptForDisplay = currentPrompt;
    if (roundNumber === 1 && config?.enhancePrompt) {
      try {
        const enhanced = await this.enhancePrompt(
          currentPrompt,
          activeOrchSession.team,
          activeOrchSession.mode,
          _token,
        );
        if (enhanced && enhanced !== currentPrompt) {
          this.log(
            `[Orchestrate] Prompt enhanced: "${enhanced.substring(0, 100)}..."`,
          );
          currentPrompt = enhanced;
          promptWasEnhanced = true;
          // Push to HQ state so Live Monitor can show before/after
          orchSetPromptEnhancement(
            sessionId,
            originalPromptForDisplay,
            enhanced,
          );
        }
      } catch (err) {
        this.log(
          `[Orchestrate] Prompt enhancement failed (using original): ${err}`,
        );
      }
    }

    try {
      const report = await activeOrchSession.dispatch(currentPrompt);

      // —— Format output —————————————————————————————————————————————
      const parts: string[] = [];

      if (isNewSession) {
        const teamSummary = activeOrchSession.team
          .map((t) => `  - ${t.agent.name} → ${t.modelId} (${t.tier})`)
          .join("\n");
        const modeLabel =
          activeOrchSession.mode === "sequential"
            ? "🔗 Sequential (pipeline)"
            : "⚡ Parallel";
        parts.push(
          `🏴‍☠️ **Sesión de orquestación iniciada**`,
          `**Objetivo:** ${activeOrchSession.goal}`,
          `**Modo:** ${modeLabel}`,
          `**Equipo:**`,
          teamSummary,
          "",
        );

        if (promptWasEnhanced) {
          parts.push(
            `🪄 **Prompt mejorado automáticamente:**`,
            `> _Original:_ ${originalPromptForDisplay.substring(0, 200)}${originalPromptForDisplay.length > 200 ? "..." : ""}`,
            `> _Mejorado:_ ${currentPrompt.substring(0, 500)}${currentPrompt.length > 500 ? "..." : ""}`,
            "",
          );
        }
      }

      parts.push(`### 🎯 Ronda ${roundNumber}`, "");

      for (const r of report.results) {
        const status = r.success ? "✅" : "❌";
        const text = r.text || r.error || "(sin output)";
        const preview =
          text.length > 1500 ? text.substring(0, 1500) + "..." : text;
        parts.push(
          `${status} **${r.taskId}** (${r.model || "?"}, ${r.rounds || 0} rounds, ${r.toolCalls?.length || 0} tool calls):`,
        );
        parts.push(preview);
        parts.push("");
      }

      const totalTokens =
        (report.totalEstimatedInputTokens + report.totalEstimatedOutputTokens) /
        1000;
      parts.push(
        `📊 ${report.successCount}/${report.results.length} OK | ~${totalTokens.toFixed(1)}K tokens | ${(report.totalDurationMs / 1000).toFixed(1)}s`,
      );

      const synthLines: string[] = [];
      synthLines.push(
        `Ronda ${roundNumber}: ${report.successCount}/${report.results.length} agentes completaron exitosamente.`,
      );
      for (const r of report.results) {
        const rText = r.text || r.error || "(sin output)";
        const rPreview =
          rText.length > 400 ? rText.substring(0, 400) + "..." : rText;
        synthLines.push(
          `- **${r.taskId}** (${r.success ? "✅" : "❌"}): ${rPreview}`,
        );
      }
      const preBuiltSynthesis = synthLines.join("\n");

      parts.push(
        "",
        `🚨 **ACCIÓN OBLIGATORIA — PASO SIGUIENTE:**`,
        `Llama AHORA a \`orchAwaitInput\` con el parámetro \`sessionId\` y \`synthesis\` que contenga tu análisis de los resultados anteriores.`,
        `Si no tienes un análisis propio, usa esta síntesis pre-construida:`,
        "",
        "```",
        preBuiltSynthesis,
        "```",
        "",
        `Ejemplo: \`orchAwaitInput({ sessionId: "${sessionId}", synthesis: "${preBuiltSynthesis.substring(0, 80)}..." })\``,
        `NO llames a \`orchestrate\` otra vez sin antes haber llamado a \`orchAwaitInput\` — el usuario necesita dar feedback.`,
      );

      this.log(
        `[Orchestrate] Round ${roundNumber} complete: "${currentPrompt.substring(0, 60)}"`,
      );

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(parts.join("\n")),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[Orchestrate] Round ${roundNumber} failed: ${msg}`);

      if (isNewSession) {
        this.orchestrationManager.removeSession(sessionId);
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ Error en ronda ${roundNumber}: ${msg}`,
        ),
      ]);
    }
  }

  private async enhancePrompt(
    originalPrompt: string,
    team: readonly AgentSlotConfig[],
    mode: string,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const teamDescription = team
      .map((t, i) => `${i + 1}. **${t.agent.name}** — ${t.agent.description}`)
      .join("\n");

    const modeExplanation =
      mode === "sequential"
        ? "SEQUENTIAL (pipeline) — each agent receives the previous agent's output as context, so tasks should be ordered as a pipeline"
        : "PARALLEL — all agents work simultaneously on the same prompt, so each agent needs clear, independent instructions";

    const systemMessage = vscode.LanguageModelChatMessage.User(
      [
        `You are a prompt engineering expert for multi-agent orchestration systems.`,
        `Your job is to take a user's goal and transform it into an optimized prompt that will produce the best results from the configured agent team.`,
        ``,
        `RULES:`,
        `- Output ONLY the enhanced prompt text — no explanations, no preamble, no markdown wrappers`,
        `- Keep the user's original intent intact — enhance, don't change the goal`,
        `- Add specific sub-tasks or focus areas for each agent based on their role`,
        `- If the mode is SEQUENTIAL, structure the prompt as a pipeline where each agent builds on the previous`,
        `- If the mode is PARALLEL, make sure each agent has clear, independent focus areas`,
        `- Reference agents by their name when assigning specific aspects`,
        `- Keep it concise but actionable — no fluff`,
        `- Write in the same language as the user's original prompt`,
        ``,
        `TEAM (in execution order):`,
        teamDescription,
        ``,
        `MODE: ${modeExplanation}`,
        ``,
        `USER'S ORIGINAL PROMPT:`,
        originalPrompt,
        ``,
        `Now produce the enhanced prompt:`,
      ].join("\n"),
    );

    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
      this.log(`[Orchestrate] No models available for prompt enhancement`);
      return originalPrompt;
    }

    const model =
      models.find((m) => m.id.includes("gpt-4o-mini")) ||
      models.find((m) => m.id.includes("gpt-4o")) ||
      models.find((m) => m.id.includes("claude")) ||
      models[0];

    const response = await model.sendRequest(
      [systemMessage],
      { modelOptions: { temperature: 0.3 } },
      token,
    );

    let enhanced = "";
    for await (const chunk of response.text) {
      enhanced += chunk;
    }

    enhanced = enhanced.trim();

    if (enhanced.length < 10 || enhanced.length > originalPrompt.length * 5) {
      this.log(
        `[Orchestrate] Enhanced prompt rejected (length=${enhanced.length}), using original`,
      );
      return originalPrompt;
    }

    return enhanced;
  }
}
