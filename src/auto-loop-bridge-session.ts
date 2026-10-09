/** auto-loop-bridge-session — Lifecycle of a single Auto Loop Bridge room. */
import * as vscode from "vscode";
import type {
  AutoLoopBridgeSessionState,
  AutoLoopBridgeSessionView,
  BridgeParticipants,
  BridgeSynthesis,
  BridgeTaskMemoryData,
  BridgeTokenBudget,
  PmChatMessage,
  PMClient,
  PMProviderConfig,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";
import { toChatMessageView, toSynthesisView } from "./auto-loop-bridge-views";
import { buildParticipants as buildParticipantsHelper, appendUserMessage as appendUserMessageHelper, appendPmResponse as appendPmResponseHelper, resolveOrCreatePmClient } from "./auto-loop-bridge-session-helpers";
import {
  emitBridgeEvent,
  setBridgeState,
  updateBridgeFeedbackDraft,
  updateBridgeStatus,
  updateBridgeSynthesis,
} from "./auto-loop-events";
import {
  validateDispatch,
  validatePromotion,
  validateRoute,
} from "./auto-loop-role-router";
import { getDefaultModelForProvider, listModels } from "./pm-provider-registry";
import {
  createEmptyTaskMemory,
  loadTaskMemory,
  saveTaskMemory,
  updatePmChatSummary,
} from "./auto-loop-task-memory";
import {
  BRIDGE_DEFAULT_BUDGET,
  checkPmChatRateLimit,
  clampBudget,
  clearPmChatRateLimit,
} from "./auto-loop-token-guardrails";
import { log, logError, logWarn } from "./logger";
import { createBitacora, loadBitacora, saveBitacora, extractBitacoraEntries, appendBitacoraEntries, formatBitacoraForContext } from "./bridge-session-bitacora";
import { fetchProjectMemory, formatProjectMemoryForContext } from "./bridge-project-memory";
import { isMemoryIntrospectionQuery, buildMemoryDump } from "./bridge-memory-introspection";
import type { SessionBitacora } from "./auto-loop-bridge-types";
import { appendMessage as saveConvMessage, initConversation } from "./bridge-conversation-store";
import {
  resolveFeedbackTargetLoopSessionId,
  resolveWorkerLoopState,
} from "./bridge-loop-state-resolver";
// ————————————————— Types ——————————————————
export interface BridgeSessionConfig {
  sessionId: string;
  title: string;
  workerLoopSessionId: string;
  pmProviderId: string;
  pmModelId: string;
  pmProviderConfig: PMProviderConfig;
  repoRoot: string;
  objective: string;
  budget?: Partial<BridgeTokenBudget>;
  identityPrompt?: string;
}
import type { BridgeSessionSnapshot } from "./bridge-session-state-store";
import { saveBridgeSnapshot } from "./bridge-session-state-store";
import { executePmCall, loadIdentityPrompt, formatPmError } from "./auto-loop-bridge-pm-chat";
export class AutoLoopBridgeSession {
  private state: AutoLoopBridgeSessionState;
  private syntheses: BridgeSynthesis[] = [];
  private pmChatMessages: Map<string, PmChatMessage[]> = new Map();
  private lastSuggestions: Map<string, PmSuggestionResult> = new Map();
  private taskMemory: BridgeTaskMemoryData;
  private bitacora: SessionBitacora;
  private pmClient: PMClient | null = null;
  private readonly repoRoot: string;
  private pmProviderConfig: PMProviderConfig;
  private identityPrompt?: string;
  private cachedModels: Array<{ id: string; label: string }> = [];

  constructor(config: BridgeSessionConfig) {
    this.repoRoot = config.repoRoot;
    this.pmProviderConfig = config.pmProviderConfig;
    this.identityPrompt = config.identityPrompt;

    const budget: BridgeTokenBudget = clampBudget({
      ...BRIDGE_DEFAULT_BUDGET,
      ...config.budget,
      consumedTurns: 0,
    });

    this.state = {
      sessionId: config.sessionId,
      title: config.title,
      status: "idle",
      workerLoopSessionId: config.workerLoopSessionId,
      pmProviderId: config.pmProviderId,
      pmModelId: config.pmModelId,
      activeSynthesisId: null,
      taskMemoryRef: config.sessionId,
      tokenBudget: budget,
      pmChatThreads: {},
      workerFeedbackDraft: "",
      participantState: this.buildParticipants(config),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.taskMemory = loadTaskMemory(this.repoRoot, config.sessionId) ?? createEmptyTaskMemory(config.sessionId, config.objective);

    this.bitacora = loadBitacora(this.repoRoot, config.sessionId) ?? createBitacora(config.sessionId);

    setBridgeState(this.state);
    initConversation(this.repoRoot, config.sessionId, config.objective, config.pmProviderId, config.pmModelId);
    emitBridgeEvent("session_created", config.sessionId, {
      title: config.title,
    });
    log(`[BridgeSession] Created: ${config.title} (${config.sessionId})`);
  }
  // -- Getters --

  get sessionId(): string {
    return this.state.sessionId;
  }
  get status() {
    return this.state.status;
  }
  get rootPath(): string {
    return this.repoRoot;
  }

  getState(): AutoLoopBridgeSessionState {
    return { ...this.state };
  }

  updateWorkerLoopSessionId(newLoopId: string): void {
    this.state.workerLoopSessionId = newLoopId;
    log(`[BridgeSession] workerLoopSessionId updated to ${newLoopId.substring(0, 8)}`);
  }
  // ——————————————— Synthesis ————————————————
  addSynthesis(synthesis: BridgeSynthesis): void {
    this.syntheses.push(synthesis);
    this.setActiveSynthesis(synthesis.synthesisId);
    log(`[BridgeSession] Synthesis added: round ${synthesis.round}`);
  }

  /**
   * Bulk-load historical syntheses (e.g., from loop history).
   * Activates the most recent synthesis automatically.
   */
  bulkLoadSyntheses(items: BridgeSynthesis[]): void {
    for (const s of items) {
      this.syntheses.push(s);
    }
    if (items.length > 0) {
      this.setActiveSynthesis(items[items.length - 1].synthesisId);
      log(`[BridgeSession] Bulk-loaded ${items.length} historical syntheses`);
    }
  }

  setActiveSynthesis(synthesisId: string): void {
    this.state.activeSynthesisId = synthesisId;
    const threadModelId = this.state.pmChatThreads[synthesisId]?.modelId;
    if (threadModelId) {
      this.state.pmModelId = threadModelId;
      this.state.participantState.pm.modelId = threadModelId;
    }
    this.state.updatedAt = Date.now();
    updateBridgeSynthesis(this.state.sessionId, synthesisId);
    setBridgeState(this.state);
    try { saveBridgeSnapshot(this.repoRoot, this.toSnapshot()); } catch (e) { logWarn("[BridgeSession] snapshot save failed: " + e); }
    emitBridgeEvent("synthesis_selected", this.state.sessionId, {
      synthesisId,
    });
  }

  /** Refresh the cached available models from the provider strategy. */
  async refreshAvailableModels(): Promise<void> {
    try {
      // Re-read enabledModelIds from VS Code config (user may have changed them via catalog)
      const enabledIds = vscode.workspace
        .getConfiguration("projectBrain.bridge")
        .get<string[]>(`${this.state.pmProviderId}.enabledModelIds`, []);
      const freshConfig = { ...this.pmProviderConfig, enabledModelIds: enabledIds };
      const models = await listModels(this.state.pmProviderId, freshConfig);
      this.cachedModels = models.map(m => ({ id: m.id, label: m.label }));

      const modelStillAvailable = this.cachedModels.some(m => m.id === this.state.pmModelId);
      if (!modelStillAvailable && this.cachedModels.length > 0) {
        const fallbackModelId = this.cachedModels[0].id;
        log(`[BridgeSession] Normalizing stale model: ${this.state.pmModelId} → ${fallbackModelId}`);
        this.state.pmModelId = fallbackModelId;
        this.pmProviderConfig = {
          ...freshConfig,
          defaultModelId: fallbackModelId,
        };
        if (this.pmClient?.dispose) { this.pmClient.dispose(); }
        this.pmClient = null;
        this.state.updatedAt = Date.now();
        setBridgeState(this.state);
      }
    } catch (err) {
      log(`[BridgeSession] Failed to refresh models: ${err}`);
    }
  }

  /** Change PM model at runtime (manual override from chat UI). */
  setModel(modelId: string, synthesisId?: string): void {
    log(`[BridgeSession] Manual model change: ${this.state.pmModelId} → ${modelId}`);
    this.state.pmModelId = modelId;
    this.state.participantState.pm.modelId = modelId;
    const targetSynthesisId = synthesisId ?? this.state.activeSynthesisId;
    if (targetSynthesisId) {
      const thread = this.state.pmChatThreads[targetSynthesisId];
      this.state.pmChatThreads[targetSynthesisId] = {
        synthesisId: targetSynthesisId,
        summary: thread?.summary ?? "",
        lastUpdatedAt: Date.now(),
        turnCount: thread?.turnCount ?? (this.pmChatMessages.get(targetSynthesisId)?.length ?? 0),
        modelId,
      };
    }
    if (this.pmProviderConfig) { this.pmProviderConfig = { ...this.pmProviderConfig, defaultModelId: modelId }; }
    if (this.pmClient?.dispose) { this.pmClient.dispose(); }
    this.pmClient = null;
    this.state.updatedAt = Date.now();
    setBridgeState(this.state);
    try { saveBridgeSnapshot(this.repoRoot, this.toSnapshot()); } catch (e) { logWarn("[BridgeSession] snapshot save failed: " + e); }
  }

  // ———————————————— PM Chat —————————————————
  async sendPmChat(
    synthesisId: string,
    text: string,
    retrievalChunks: string[] = [],
  ): Promise<PmSuggestionResult | null> {
    const persistDebugRaw = vscode.workspace
      .getConfiguration("projectBrain.bridge")
      .get<boolean>("debugPersistence", false);

    const route = validateRoute(
      { channel: "pm_chat", origin: "user", sessionId: this.state.sessionId, synthesisId, text, timestamp: Date.now() },
      this.state.status,
    );
    if (!route.allowed) {
      logWarn("[BridgeSession] PM Chat blocked: " + route.reason);
      saveConvMessage(
        this.repoRoot,
        this.state.sessionId,
        "pm",
        {
          errorCode: "BRIDGE_ROUTE_BLOCKED",
          message: "No pude procesar este mensaje porque la sesion no permite PM chat en el estado actual.",
          hint: route.reason,
          debugRaw: route.reason,
        },
        synthesisId,
        { persistDebugRaw },
      );
      return null;
    }

    // PM uses a sliding context window (last 20 messages), NOT a hard turn cap.
    // The trimChatHistory() in the context assembler handles the "party room" eviction.
    // consumedTurns is kept for metrics only — it never blocks the PM.

    if (!checkPmChatRateLimit(this.state.sessionId)) {
      logWarn("[BridgeSession] PM Chat blocked: rate limit exceeded");
      saveConvMessage(
        this.repoRoot,
        this.state.sessionId,
        "pm",
        {
          errorCode: "BRIDGE_RATE_LIMIT",
          message: "Se alcanzo el limite temporal de mensajes PM.",
          hint: "Espera unos segundos y vuelve a intentar.",
          debugRaw: "Rate limit exceeded",
        },
        synthesisId,
        { persistDebugRaw },
      );
      return null;
    }

    const synthesis = this.syntheses.find(s => s.synthesisId === synthesisId);
    if (!synthesis) {
      logWarn("[BridgeSession] Synthesis not found: " + synthesisId);
      saveConvMessage(
        this.repoRoot,
        this.state.sessionId,
        "pm",
        {
          errorCode: "BRIDGE_SYNTHESIS_NOT_FOUND",
          message: "No se encontro la sintesis seleccionada para esta sesion.",
          hint: "Refresca la vista del Bridge y selecciona una sintesis valida.",
          debugRaw: synthesisId,
        },
        synthesisId,
        { persistDebugRaw },
      );
      return null;
    }

    this.appendUserMessage(synthesisId, text);
    saveConvMessage(this.repoRoot, this.state.sessionId, "user", text, synthesisId);
    updateBridgeStatus(this.state.sessionId, "waiting_pm");

    try {
      this.refreshProviderIfChanged();
      const client = await this.getOrCreateClient();

      this.identityPrompt = loadIdentityPrompt(this.repoRoot, this.identityPrompt);

      const bitacoraCtx = formatBitacoraForContext(this.bitacora, Math.floor(this.state.tokenBudget.maxContextChars * 0.10));
      let projectMemCtx = "";
      try { const pmCtx = await fetchProjectMemory(this.repoRoot, this.taskMemory.objective, text); projectMemCtx = formatProjectMemoryForContext(pmCtx, Math.floor(this.state.tokenBudget.maxContextChars * 0.15)); } catch (e) { logWarn("[BridgeSession] project memory fetch failed: " + e); }

      if (isMemoryIntrospectionQuery(text)) { const dump = buildMemoryDump({ bitacora: this.bitacora, taskMemory: this.taskMemory, projectMemoryContext: projectMemCtx, chatHistoryCount: (this.pmChatMessages.get(synthesisId) ?? []).length, repoRoot: this.repoRoot }); projectMemCtx = dump + (projectMemCtx ? "\n\n" + projectMemCtx : ""); }

      const workerLoopState = resolveWorkerLoopState(this.state.workerLoopSessionId);
      const feedbackTargetLoopId = resolveFeedbackTargetLoopSessionId(this.state.workerLoopSessionId);
      const canDispatchFeedback = !!feedbackTargetLoopId;

      const suggestion = await executePmCall({
        sessionId: this.state.sessionId, synthesisId, userText: text,
        retrievalChunks, repoRoot: this.repoRoot,
        objective: this.taskMemory.objective, synthesis,
        chatHistory: this.pmChatMessages.get(synthesisId) ?? [],
        taskMemory: this.taskMemory, budget: this.state.tokenBudget,
        pmProviderId: this.state.pmProviderId,
        pmModelId: this.state.pmModelId, client,
        workerLoopSessionId: this.state.workerLoopSessionId,
        workerLoopState,
        canDispatchFeedback,
        identityPrompt: this.identityPrompt,
        bitacoraContext: bitacoraCtx || undefined,
        projectMemoryContext: projectMemCtx || undefined,
      });

      this.appendPmResponse(synthesisId, suggestion);
      saveConvMessage(
        this.repoRoot,
        this.state.sessionId,
        "pm",
        suggestion,
        synthesisId,
        { persistDebugRaw },
      );
      this.state.tokenBudget.consumedTurns++;
      this.state.status = "waiting_user";
      this.state.updatedAt = Date.now();
      setBridgeState(this.state);
      emitBridgeEvent("pm_suggestion", this.state.sessionId, suggestion);
      try { saveBridgeSnapshot(this.repoRoot, this.toSnapshot()); } catch (e) { logWarn("[BridgeSession] snapshot save failed: " + e); }
      return suggestion;
    } catch (err) {
      const { detail, cause, stack, errorCode, userMessage, hint, debugRaw } = formatPmError(
        err,
        this.state.pmProviderId,
        this.state.pmModelId,
      );
      logError("[BridgeSession] PM Chat error: " + detail);
      const errMsgs = this.pmChatMessages.get(synthesisId) ?? [];
      errMsgs.push({ id: "err_" + Date.now(), synthesisId, role: "pm", text: userMessage, timestamp: Date.now() });
      this.pmChatMessages.set(synthesisId, errMsgs);
      saveConvMessage(
        this.repoRoot,
        this.state.sessionId,
        "pm",
        {
          errorCode,
          message: userMessage,
          hint,
          debugRaw: JSON.stringify({ detail, cause, stack, mappedDebugRaw: debugRaw }),
        },
        synthesisId,
        { persistDebugRaw },
      );
      this.state.status = "waiting_user";
      this.state.updatedAt = Date.now();
      setBridgeState(this.state);
      try { saveBridgeSnapshot(this.repoRoot, this.toSnapshot()); } catch (e) { logWarn("[BridgeSession] snapshot save failed: " + e); }
      emitBridgeEvent("error", this.state.sessionId, { message: detail });
      throw err instanceof Error ? err : new Error(detail);
    }
  }
  setWorkerFeedbackDraft(text: string): void {
    this.state.workerFeedbackDraft = text;
    this.state.updatedAt = Date.now();
    updateBridgeFeedbackDraft(this.state.sessionId, text);
    emitBridgeEvent("feedback_drafted", this.state.sessionId, { text });
  }
  promoteSuggestionToFeedback(suggestionId: string): boolean {
    const check = validatePromotion("user", this.state.status);
    if (!check.allowed) {
      logWarn(`[BridgeSession] Promotion blocked: ${check.reason}`);
      return false;
    }
    const suggestion = this.lastSuggestions.get(suggestionId);
    if (!suggestion) {
      logWarn(`[BridgeSession] Suggestion not found: ${suggestionId}`);
      return false;
    }
    this.setWorkerFeedbackDraft(suggestion.suggestedWorkerFeedback);
    return true;
  }
  dispatchWorkerFeedback(): string | null {
    const check = validateDispatch("user", this.state.status);
    if (!check.allowed) {
      logWarn(`[BridgeSession] Dispatch blocked: ${check.reason}`);
      return null;
    }
    const text = this.state.workerFeedbackDraft;
    if (!text.trim()) {
      logWarn("[BridgeSession] Empty feedback draft — nothing to dispatch");
      return null;
    }
    this.state.workerFeedbackDraft = "";
    this.state.status = "waiting_worker";
    this.state.updatedAt = Date.now();
    setBridgeState(this.state);
    emitBridgeEvent("feedback_dispatched", this.state.sessionId, { text });
    log(`[BridgeSession] Feedback dispatched to worker loop`);
    return text;
  }

  // ——————————————— Lifecycle ————————————————

  close(): void {
    this.state.status = "closed";
    this.state.updatedAt = Date.now();
    setBridgeState(this.state);
    saveTaskMemory(this.repoRoot, this.taskMemory);
    clearPmChatRateLimit(this.state.sessionId);
    if (this.pmClient?.dispose) {
      this.pmClient.dispose();
    }
    emitBridgeEvent("session_closed", this.state.sessionId, {});
    log(`[BridgeSession] Closed: ${this.state.sessionId}`);
  }

  // ——————————————— View Model ———————————————

  toView(): AutoLoopBridgeSessionView {
    const activeMsgs = this.state.activeSynthesisId
      ? (this.pmChatMessages.get(this.state.activeSynthesisId) ?? [])
      : [];

    return {
      sessionId: this.state.sessionId,
      title: this.state.title,
      status: this.state.status,
      workerLoopSessionId: this.state.workerLoopSessionId,
      workerLoopState: resolveWorkerLoopState(this.state.workerLoopSessionId),
      pmProviderLabel: this.state.pmProviderId,
      pmModelLabel: this.state.pmModelId,
      availableModels: this.cachedModels,
      activeSynthesisId: this.state.activeSynthesisId,
      syntheses: this.syntheses.map(toSynthesisView),
      pmChatMessages: activeMsgs.map(toChatMessageView),
      workerFeedbackDraft: this.state.workerFeedbackDraft,
      participants: this.state.participantState,
      tokenBudget: this.state.tokenBudget,
    };
  }

  // -- Private Helpers (delegated to session-helpers) ------------

  private buildParticipants(config: BridgeSessionConfig): BridgeParticipants {
    return buildParticipantsHelper(config);
  }

  private appendUserMessage(synthesisId: string, text: string): void {
    appendUserMessageHelper(this.pmChatMessages, synthesisId, text);
  }

  private appendPmResponse(
    synthesisId: string,
    suggestion: PmSuggestionResult,
  ): void {
    const result = appendPmResponseHelper(
      this.pmChatMessages, this.lastSuggestions, this.taskMemory,
      this.state.pmChatThreads, synthesisId, suggestion,
    );
    this.taskMemory = result.updatedTaskMemory;
    saveTaskMemory(this.repoRoot, this.taskMemory);

    const entries = extractBitacoraEntries(suggestion, this.state.tokenBudget.consumedTurns);
    if (entries.length > 0) { appendBitacoraEntries(this.bitacora, entries); saveBitacora(this.repoRoot, this.bitacora); }
  }

  private async getOrCreateClient(): Promise<PMClient> {
    const result = await resolveOrCreatePmClient(
      this.pmClient, this.pmProviderConfig, this.state.pmProviderId,
    );
    this.pmClient = result.client;
    this.pmProviderConfig = result.config;
    if (!this.pmClient) {
      throw new Error(
        `PM client creation returned null for ${this.state.pmProviderId}/${this.state.pmModelId}`,
      );
    }
    return this.pmClient;
  }
  /** Hot-swap PM provider if the user changed the default in settings. */
  private refreshProviderIfChanged(): void {
    const cfg = vscode.workspace.getConfiguration("projectBrain.bridge");
    const currentDefault = cfg.get<string>("defaultProvider") || this.state.pmProviderId;
    if (currentDefault && currentDefault !== this.state.pmProviderId) {
      log(`[BridgeSession] PM provider hot-swap: ${this.state.pmProviderId} → ${currentDefault}`);
      this.state.pmProviderId = currentDefault;
      const newModel = cfg.get<string>(`${currentDefault}.defaultModel`) || getDefaultModelForProvider(currentDefault);
      this.state.pmModelId = newModel;
      this.state.participantState.pm.modelId = newModel;
      const enabledIds = cfg.get<string[]>(`${currentDefault}.enabledModelIds`, []);
      // Reset config so resolveOrCreatePmClient re-resolves the API key for the new provider
      this.pmProviderConfig = { providerId: currentDefault, apiKeyRef: "", enabled: true, enabledModelIds: enabledIds, defaultModelId: newModel };
      if (this.pmClient?.dispose) { this.pmClient.dispose(); }
      this.pmClient = null;
      this.state.updatedAt = Date.now();
      setBridgeState(this.state);
      this.refreshAvailableModels().catch(() => {});
    }
  }

    toSnapshot(): BridgeSessionSnapshot {
    return { state: { ...this.state }, syntheses: [...this.syntheses], pmChatMessages: Object.fromEntries(this.pmChatMessages), lastSuggestions: Object.fromEntries(this.lastSuggestions), taskMemory: { ...this.taskMemory }, pmProviderConfig: { ...this.pmProviderConfig }, repoRoot: this.repoRoot, identityPrompt: this.identityPrompt, savedAt: Date.now() };
  }
  restoreFromSnapshot(s: BridgeSessionSnapshot): void {
    this.state = s.state; this.syntheses = s.syntheses; this.taskMemory = s.taskMemory; this.pmProviderConfig = s.pmProviderConfig; this.identityPrompt = s.identityPrompt;
    this.pmChatMessages = new Map(Object.entries(s.pmChatMessages)); this.lastSuggestions = new Map(Object.entries(s.lastSuggestions));
    const activeThreadModelId = this.state.activeSynthesisId
      ? this.state.pmChatThreads[this.state.activeSynthesisId]?.modelId
      : undefined;
    if (activeThreadModelId) {
      this.state.pmModelId = activeThreadModelId;
      this.state.participantState.pm.modelId = activeThreadModelId;
    }
    setBridgeState(this.state);
  }
}