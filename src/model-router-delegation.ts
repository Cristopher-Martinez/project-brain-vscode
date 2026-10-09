import * as vscode from "vscode";
import type { PromptLoader } from "./prompt-loader";
import {
  DelegateTaskKind,
  ModelProfile,
  ModelTier,
  RoutingDecision,
  SlaveValidationResult,
  TaskClassification,
  TIER_PRIORITY,
} from "./model-router-types";
import {
  DEFAULT_POWERS,
  executePower,
  parsePowerRequest,
  refineSlavePrompt,
  validateSlaveOutput,
} from "./slave-protocol";
import { findNextTierModel } from "./model-router-selection";

export interface DelegateTaskOptions {
  taskKind?: DelegateTaskKind;
  command?: string;
  systemPrompt?: string;
  maxTier?: ModelTier;
  maxRetries?: number;
  skipValidation?: boolean;
  outputConstraints?: {
    maxLength?: number;
    format?: "text" | "json" | "markdown" | "csv";
    language?: string;
  };
}

export interface DelegateRuntime {
  discoverModels: () => Promise<void>;
  getAvailableModels: () => vscode.LanguageModelChat[];
  getProfiles: () => Map<string, ModelProfile>;
  classifyTask: (prompt: string, command?: string) => TaskClassification;
  selectModel: (
    task: TaskClassification,
    fallbackModel: vscode.LanguageModelChat,
    overrideMinTier?: ModelTier,
  ) => RoutingDecision;
  recordResult: (
    decision: RoutingDecision,
    startTime: number,
    responseText: string,
  ) => void;
  promptLoader?: PromptLoader;
  maxRetries: number;
  maxPowerRounds: number;
  log: (msg: string) => void;
}

export async function delegateTask(
  runtime: DelegateRuntime,
  prompt: string,
  token: vscode.CancellationToken,
  fallbackModel: vscode.LanguageModelChat,
  options?: DelegateTaskOptions,
): Promise<{
  text: string;
  decision: RoutingDecision;
  responseTimeMs: number;
  validation: SlaveValidationResult;
  attempts: number;
  wasEscalated: boolean;
}> {
  if (runtime.getAvailableModels().length === 0) {
    await runtime.discoverModels();
  }

  const taskKind = options?.taskKind ?? "raw";
  const maxRetries = options?.maxRetries ?? runtime.maxRetries;
  const task = runtime.classifyTask(prompt, options?.command);
  const decision = runtime.selectModel(task, fallbackModel);
  let currentModel = decision.selectedModel;
  let wasEscalated = false;

  if (options?.maxTier) {
    const maxPriority = TIER_PRIORITY[options.maxTier];
    const selectedProfile = runtime.getProfiles().get(decision.selectedModel.id);
    if (selectedProfile && TIER_PRIORITY[selectedProfile.tier] > maxPriority) {
      const capped = runtime
        .getAvailableModels()
        .map((model) => ({ model, profile: runtime.getProfiles().get(model.id) }))
        .filter(
          (entry): entry is { model: vscode.LanguageModelChat; profile: ModelProfile } =>
            entry.profile != null && TIER_PRIORITY[entry.profile.tier] <= maxPriority,
        )
        .sort(
          (a, b) => TIER_PRIORITY[b.profile.tier] - TIER_PRIORITY[a.profile.tier],
        );

      if (capped.length > 0) {
        currentModel = capped[0].model;
        decision.selectedModel = currentModel;
        decision.reason = `delegated (capped at ${options.maxTier}): ${capped[0].profile.tier}`;
      }
    }
  }

  const powers = DEFAULT_POWERS[taskKind] ?? [];
  if (powers.length > 0) {
    runtime.log(`[ModelRouter] Powers granted for [${taskKind}]: ${powers.join(", ")}`);
  }

  const { systemPrompt: refinedSystem, userPrompt: refinedUser } =
    refineSlavePrompt(
      taskKind,
      prompt,
      options?.outputConstraints,
      powers.length > 0 ? powers : undefined,
      runtime.promptLoader,
    );
  const finalSystemPrompt = options?.systemPrompt ?? refinedSystem;
  const selectedProfile = runtime.getProfiles().get(currentModel.id);
  const tierLabel = selectedProfile?.tier ?? "unknown";
  runtime.log(
    `[ModelRouter] Delegating [${taskKind}]: "${prompt.substring(0, 50)}..." → ${currentModel.id} (${tierLabel} slave)`,
  );

  const overallStartTime = Date.now();
  let text = "";
  let validation: SlaveValidationResult = {
    isValid: false,
    score: 0,
    issues: [],
    canRetry: false,
    feedback: "",
  };
  let attempts = 0;
  const failedModels = new Set<string>();

  while (attempts < maxRetries + 1) {
    attempts++;
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(finalSystemPrompt),
    ];

    if (attempts === 1) {
      messages.push(vscode.LanguageModelChatMessage.User(refinedUser));
    } else if (validation.feedback) {
      messages.push(vscode.LanguageModelChatMessage.User(refinedUser));
      messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `CORRECTION REQUIRED:\n${validation.feedback}`,
        ),
      );
    }

    runtime.log(
      `[ModelRouter] Delegate attempt ${attempts}/${maxRetries} → ${currentModel.id}`,
    );

    try {
      const attemptStart = Date.now();
      const response = await currentModel.sendRequest(messages, {}, token);
      text = "";
      for await (const fragment of response.text) {
        text += fragment;
      }

      const attemptMs = Date.now() - attemptStart;
      runtime.log(
        `[ModelRouter] Attempt ${attempts}: ${text.length} chars in ${attemptMs}ms`,
      );

      if (powers.length > 0) {
        let powerRounds = 0;
        while (powerRounds < runtime.maxPowerRounds) {
          const parsed = parsePowerRequest(text);
          if (!parsed.request) break;

          powerRounds++;
          const powerReq = parsed.request;
          if (!powers.includes(powerReq.power)) {
            runtime.log(
              `[ModelRouter] Slave requested unauthorized power: ${powerReq.power} — denied`,
            );
            const denialMsg = `POWER DENIED: You do not have access to "${powerReq.power}". Available powers: ${powers.join(", ")}. Continue without it.`;
            messages.push(vscode.LanguageModelChatMessage.Assistant(text));
            messages.push(vscode.LanguageModelChatMessage.User(denialMsg));
          } else {
            runtime.log(
              `[ModelRouter] Power round ${powerRounds}/${runtime.maxPowerRounds}: ${powerReq.power}(${JSON.stringify(powerReq.args)})`,
            );
            const powerResult = await executePower(powerReq, runtime.log);
            const resultMsg = powerResult.success
              ? `POWER RESULT (${powerReq.power}):\n${powerResult.data}`
              : `POWER FAILED (${powerReq.power}): ${powerResult.error || "Unknown error"}. Continue with what you have.`;
            messages.push(vscode.LanguageModelChatMessage.Assistant(text));
            messages.push(vscode.LanguageModelChatMessage.User(resultMsg));
          }

          const powerResponse = await currentModel.sendRequest(messages, {}, token);
          text = "";
          for await (const fragment of powerResponse.text) {
            text += fragment;
          }
          runtime.log(
            `[ModelRouter] Power round ${powerRounds} response: ${text.length} chars`,
          );
        }

        if (powerRounds > 0) {
          runtime.log(
            `[ModelRouter] Power loop complete: ${powerRounds} rounds used`,
          );
        }
      }

      if (options?.skipValidation) {
        validation = {
          isValid: true,
          score: 0.7,
          issues: [],
          canRetry: false,
          feedback: "",
        };
        break;
      }

      validation = validateSlaveOutput(taskKind, text, prompt);
      if (validation.isValid) {
        runtime.log(
          `[ModelRouter] Validation passed (score: ${validation.score.toFixed(2)})`,
        );
        break;
      }

      runtime.log(
        `[ModelRouter] Validation failed: ${validation.issues.join(", ")} (score: ${validation.score.toFixed(2)})`,
      );

      if (attempts >= maxRetries && validation.canRetry) {
        failedModels.add(currentModel.id);
        const escalated = findNextTierModel({
          currentModel,
          failedModels,
          maxTier: options?.maxTier,
          availableModels: runtime.getAvailableModels(),
          profiles: runtime.getProfiles(),
        });
        if (escalated) {
          runtime.log(
            `[ModelRouter] Slave failed ${maxRetries}x — escalating to ${escalated.id}`,
          );
          currentModel = escalated;
          decision.selectedModel = escalated;
          decision.wasEscalated = true;
          wasEscalated = true;
          validation.feedback = "";
        } else {
          runtime.log(
            "[ModelRouter] No higher model available — returning best effort",
          );
          break;
        }
      } else if (!validation.canRetry) {
        runtime.log("[ModelRouter] Output too broken to retry — giving up");
        break;
      }
    } catch (err) {
      runtime.log(`[ModelRouter] Delegate error (${currentModel.id}): ${err}`);
      failedModels.add(currentModel.id);
      const alternate = findNextTierModel({
        currentModel,
        failedModels,
        maxTier: options?.maxTier,
        availableModels: runtime.getAvailableModels(),
        profiles: runtime.getProfiles(),
      });

      if (alternate) {
        runtime.log(
          `[ModelRouter] Model ${currentModel.id} errored — trying ${alternate.id}`,
        );
        currentModel = alternate;
        decision.selectedModel = alternate;
        attempts--;
        continue;
      }

      runtime.log("[ModelRouter] All eligible models exhausted — giving up");
      validation = {
        isValid: false,
        score: 0,
        issues: [`Error: ${err}`],
        canRetry: false,
        feedback: "",
      };
      break;
    }
  }

  const responseTimeMs = Date.now() - overallStartTime;
  const recordDecision: RoutingDecision = {
    ...decision,
    selectedModel: currentModel,
  };
  runtime.recordResult(recordDecision, overallStartTime, text);

  runtime.log(
    `[ModelRouter] Delegate complete: ${attempts} attempts, ${validation.isValid ? "✓ valid" : "✗ invalid"}, ${responseTimeMs}ms total${wasEscalated ? " [ESCALATED]" : ""}`,
  );

  return {
    text,
    decision: recordDecision,
    responseTimeMs,
    validation,
    attempts,
    wasEscalated,
  };
}
