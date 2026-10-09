// SOURCE MAP - model-router.ts (orchestrator)
// Classification -> model-router-classification.ts
// Selection      -> model-router-selection.ts
// Delegation     -> model-router-delegation.ts
// Persistence    -> model-router-persistence.ts

import * as vscode from "vscode";
import {
  ModelProfile,
  ModelTier,
  RoutingDecision,
  SlaveValidationResult,
  TaskClassification,
  TaskResult,
  TIER_PRIORITY,
} from "./model-router-types";
import type { PromptLoader } from "./prompt-loader";
import { AdaptiveLatencyTracker } from "./adaptive-latency";
import { classifyTask as classifyTaskCore } from "./model-router-classification";
import {
  detectTier,
  inferCapabilities,
  prioritizeTools,
  selectModel as selectModelCore,
} from "./model-router-selection";
import {
  buildStatus,
  loadPerformanceData,
  recordResult as recordResultCore,
  savePerformanceData,
} from "./model-router-persistence";
import {
  DelegateTaskOptions,
  delegateTask as delegateTaskCore,
} from "./model-router-delegation";

export {
  DelegateTaskKind,
  ModelProfile,
  ModelTier,
  RoutingDecision,
  SlaveValidationResult,
  TaskClassification,
  TaskResult,
} from "./model-router-types";
export { SlavePower } from "./slave-protocol";

export class ModelRouter {
  private profiles: Map<string, ModelProfile> = new Map();
  private performanceLog: TaskResult[] = [];
  private availableModels: vscode.LanguageModelChat[] = [];
  private readonly log: (msg: string) => void;
  private readonly context: vscode.ExtensionContext;
  private disposed = false;
  private modelChangeListener: vscode.Disposable | undefined;

  private readonly MAX_HISTORY_ENTRIES = 500;
  private readonly SUCCESS_THRESHOLD = 0.5;
  private readonly MIN_SAMPLES = 3;
  readonly brainTier: ModelTier;
  readonly defaultMaxTier: ModelTier;
  readonly maxRetries: number;
  readonly maxPowerRounds: number;
  promptLoader?: PromptLoader;
  latencyTracker?: AdaptiveLatencyTracker;

  constructor(context: vscode.ExtensionContext, log: (msg: string) => void) {
    this.context = context;
    this.log = log;

    const config = vscode.workspace.getConfiguration("projectBrain.modelRouter");
    this.brainTier = config.get<ModelTier>("brainTier", "ultra");
    this.defaultMaxTier = config.get<ModelTier>("defaultMaxTier", "free");
    this.maxRetries = config.get<number>("maxRetries", 3);
    this.maxPowerRounds = config.get<number>("maxPowerRounds", 5);
    this.log(
      `[ModelRouter] Config: brainTier=${this.brainTier}, defaultMaxTier=${this.defaultMaxTier}, maxRetries=${this.maxRetries}, maxPowerRounds=${this.maxPowerRounds}`,
    );

    this.loadPerformanceData();
    this.modelChangeListener = vscode.lm.onDidChangeChatModels(() => {
      this.log("[ModelRouter] Models changed — re-discovering");
      void this.discoverModels();
    });
    context.subscriptions.push(this.modelChangeListener);
  }

  async discoverModels(): Promise<void> {
    try {
      this.availableModels = await vscode.lm.selectChatModels();
      this.log(`[ModelRouter] Discovered ${this.availableModels.length} models`);

      for (const model of this.availableModels) {
        const existing = this.profiles.get(model.id);
        const tier = detectTier(model, this.log);

        if (existing) {
          existing.maxInputTokens = model.maxInputTokens;
          existing.tier = tier;
        } else {
          this.profiles.set(model.id, {
            id: model.id,
            family: model.family,
            vendor: model.vendor,
            maxInputTokens: model.maxInputTokens,
            tier,
            capabilities: inferCapabilities(tier),
            performanceHistory: [],
            successRate: {},
            avgResponseQuality:
              tier === "ultra"
                ? 0.95
                : tier === "premium"
                  ? 0.9
                  : tier === "standard"
                    ? 0.75
                    : 0.6,
          });
          this.log(
            `[ModelRouter] New model: ${model.id} (family=${model.family}, tier=${tier})`,
          );
        }

        if (this.latencyTracker) {
          this.latencyTracker.setModelTier(model.id, tier);
        }
      }
    } catch (err) {
      this.log(`[ModelRouter] Discovery failed: ${err}`);
    }
  }

  classifyTask(prompt: string, command?: string): TaskClassification {
    return classifyTaskCore(prompt, command, this.log);
  }

  selectModel(
    task: TaskClassification,
    fallbackModel: vscode.LanguageModelChat,
    overrideMinTier?: ModelTier,
  ): RoutingDecision {
    return selectModelCore({
      availableModels: this.availableModels,
      profiles: this.profiles,
      task,
      fallbackModel,
      overrideMinTier,
      minSamples: this.MIN_SAMPLES,
      successThreshold: this.SUCCESS_THRESHOLD,
      log: this.log,
    });
  }

  async routeRequest(
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    fallbackModel: vscode.LanguageModelChat,
    prompt: string,
    command?: string,
    overrideMinTier?: ModelTier,
    requestOptions?: vscode.LanguageModelChatRequestOptions,
  ): Promise<{
    response: vscode.LanguageModelChatResponse;
    decision: RoutingDecision;
    startTime: number;
    requestOptionsUsed: vscode.LanguageModelChatRequestOptions;
  }> {
    if (this.availableModels.length === 0) {
      await this.discoverModels();
    }

    const task = this.classifyTask(prompt, command);
    const effectiveOverride = task.requiresReasoning ? overrideMinTier : undefined;
    const decision = this.selectModel(task, fallbackModel, effectiveOverride);

    this.log(
      `[ModelRouter] Routing: "${prompt.substring(0, 40)}..." → ${decision.selectedModel.id} (${decision.reason})`,
    );
    const selectedProfile = this.profiles.get(decision.selectedModel.id);
    if (
      selectedProfile &&
      selectedProfile.vendor !== "local" &&
      !selectedProfile.id.toLowerCase().includes("local")
    ) {
      this.log(
        `[ModelRouter] ⚠️ DATA EXFIL WARNING: Prompt routed to external model "${decision.selectedModel.id}" (vendor: ${selectedProfile.vendor}). Content leaves local machine.`,
      );
    }

    const MAX_TOOLS_FREE = 128;
    let effectiveOptions: vscode.LanguageModelChatRequestOptions =
      requestOptions ?? {};
    const selectedTier = this.profiles.get(decision.selectedModel.id)?.tier;
    if (
      selectedTier &&
      TIER_PRIORITY[selectedTier] < TIER_PRIORITY.standard &&
      requestOptions?.tools &&
      requestOptions.tools.length > MAX_TOOLS_FREE
    ) {
      const tools = prioritizeTools(requestOptions.tools, MAX_TOOLS_FREE);
      effectiveOptions = { ...requestOptions, tools };
      this.log(
        `[ModelRouter] Tools capped: ${requestOptions.tools.length} → ${tools.length} (${selectedTier} tier limit)`,
      );
    }

    const startTime = Date.now();
    const response = await decision.selectedModel.sendRequest(
      messages,
      effectiveOptions,
      token,
    );
    return { response, decision, startTime, requestOptionsUsed: effectiveOptions };
  }

  async delegateTask(
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
    return delegateTaskCore(
      {
        discoverModels: () => this.discoverModels(),
        getAvailableModels: () => this.getAvailableModels(),
        getProfiles: () => this.getProfiles(),
        classifyTask: (inputPrompt, command) => this.classifyTask(inputPrompt, command),
        selectModel: (task, model, minTier) => this.selectModel(task, model, minTier),
        recordResult: (decision, start, responseText) =>
          this.recordResult(decision, start, responseText),
        promptLoader: this.promptLoader,
        maxRetries: this.maxRetries,
        maxPowerRounds: this.maxPowerRounds,
        log: this.log,
      },
      prompt,
      token,
      fallbackModel,
      options,
    );
  }

  recordResult(
    decision: RoutingDecision,
    startTime: number,
    responseText: string,
  ): void {
    recordResultCore(
      {
        profiles: this.profiles,
        performanceLog: this.performanceLog,
        maxHistoryEntries: this.MAX_HISTORY_ENTRIES,
        latencyTracker: this.latencyTracker,
        log: this.log,
      },
      decision,
      startTime,
      responseText,
    );
    this.savePerformanceData();
  }

  private savePerformanceData(): void {
    savePerformanceData(this.context, this.profiles, this.performanceLog, this.log);
  }

  private loadPerformanceData(): void {
    this.performanceLog = loadPerformanceData(
      this.context,
      this.profiles,
      this.log,
    );
  }

  getStatus(): string {
    return buildStatus(
      this.availableModels.length,
      this.performanceLog.length,
      this.profiles,
    );
  }

  getAvailableModels(): vscode.LanguageModelChat[] {
    return [...this.availableModels];
  }

  getProfiles(): Map<string, ModelProfile> {
    return new Map(this.profiles);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.modelChangeListener?.dispose();
    this.savePerformanceData();
    this.log("[ModelRouter] Disposed");
  }
}
