/**
 * auto-loop-bridge-pm-chat -- PM call execution logic extracted from BridgeSession.
 *
 * Contains the core PM provider call, identity loading, and error formatting.
 * Extracted to keep auto-loop-bridge-session.ts under 400 lines.
 */

import * as vscode from "vscode";
import type {
  BridgeSynthesis,
  PmErrorCode,
  BridgeTaskMemoryData,
  BridgeTokenBudget,
  PmChatMessage,
  PMClient,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";
import {
  assembleContext,
  type ContextAssemblerInput,
} from "./auto-loop-context-assembler";
import { log, logWarn } from "./logger";
import { resolveProvider } from "./pm-provider-registry";
import { queryConversationMemory } from "./bridge-conversation-rag";
import { classifyIntent } from "./pm-intent-classifier";
import { AgentIdentityManager } from "./agent-identity";
import { getGlobalConfig } from "./global-config-accessor";
import { mapPmNetworkError } from "./pm-network-error-mapper";

// -- Types --

export interface PmCallInput {
  sessionId: string;
  synthesisId: string;
  userText: string;
  retrievalChunks: string[];
  repoRoot: string;
  objective: string;
  synthesis: BridgeSynthesis;
  chatHistory: PmChatMessage[];
  taskMemory: BridgeTaskMemoryData;
  budget: BridgeTokenBudget;
  pmProviderId: string;
  pmModelId: string;
  workerLoopSessionId?: string;
  workerLoopState?: "active" | "awaiting" | "completed" | "error" | "disconnected";
  canDispatchFeedback?: boolean;
  client: PMClient;
  identityPrompt?: string;
  bitacoraContext?: string;
  projectMemoryContext?: string;
}

// -- PM Call Execution --

/**
 * Execute a PM provider call: assemble context, classify intent, call provider, parse response.
 */
export async function executePmCall(input: PmCallInput): Promise<PmSuggestionResult> {
  const strategy = resolveProvider(input.pmProviderId);
  if (!strategy) {
    throw new Error("PM strategy not found for provider: " + input.pmProviderId);
  }

  log("[BridgePM] building context for " + strategy.providerId);

  const ctxInput: ContextAssemblerInput = {
    objective: input.objective,
    activeSynthesis: input.synthesis,
    taskMemory: input.taskMemory,
    retrievalChunks: input.retrievalChunks,
    pmChatHistory: input.chatHistory,
    userMessage: input.userText,
    budget: input.budget,
    conversationRagChunks: queryConversationMemory(
      input.repoRoot, input.sessionId, input.userText, 20,
    ),
    responseLanguage:
      vscode.workspace.getConfiguration("projectBrain.bridge")
        .get<string>("responseLanguage") ?? "auto",
    identityPrompt: input.identityPrompt,
    workerLoopSessionId: input.workerLoopSessionId,
    workerLoopState: input.workerLoopState,
    canDispatchFeedback: input.canDispatchFeedback,
    bitacoraContext: input.bitacoraContext,
    projectMemoryContext: input.projectMemoryContext,
  };

  const assembled = assembleContext(ctxInput);

  // Pre-classify intent using cheap LLM call
  const preIntent = await classifyIntent(input.client, input.userText, input.pmModelId);
  if (preIntent) {
    assembled.preClassifiedIntent = preIntent;
  } else {
    logWarn("[BridgePM] classification failed -- falling back to PM self-classification");
  }

  const request = await strategy.buildRequest(assembled);
  request.model = input.pmModelId;
  log("[BridgePM] sending request to " + request.model);

  const response = await input.client.send(request);
  const suggestion = strategy.parseResponse(response);

  // Override intent with pre-classification (authoritative)
  if (preIntent) {
    suggestion.intent = preIntent;
    log("[BridgePM] intent overridden to " + preIntent + " (pre-classified)");
  }

  log("[BridgePM] parsed suggestion id=" + suggestion.id + " risk=" + suggestion.risk);
  return suggestion;
}

// -- Identity Loading --

/**
 * Load identity prompt from AgentIdentityManager or fallback to filesystem.
 * Returns the loaded prompt, or the cached value if loading fails.
 */
export function loadIdentityPrompt(
  repoRoot: string,
  cached?: string,
): string | undefined {
  try {
    const folders = vscode.workspace.workspaceFolders;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const wf = folders?.find(f => norm(f.uri.fsPath) === norm(repoRoot));

    if (!wf) {
      log("[BridgePM] freshIdentityPrompt: no WF match for repoRoot=" + repoRoot);
      if (!cached) {
        const identityPath = require("path").join(
          repoRoot, ".project-brain", "memory", "08_AGENT_IDENTITY.md",
        );
        if (require("fs").existsSync(identityPath)) {
          const raw = require("fs").readFileSync(identityPath, "utf-8") as string;
          log("[BridgePM] freshIdentityPrompt: loaded from file (" + raw.length + " chars)");
          return raw;
        }
      }
      return cached;
    }

    const mgr = new AgentIdentityManager(wf, log, getGlobalConfig());
    const prompt = mgr.getIdentityPrompt();
    if (prompt) {
      log("[BridgePM] freshIdentityPrompt: loaded via manager (" + prompt.length + " chars)");
      return prompt;
    }
    log("[BridgePM] freshIdentityPrompt: manager returned null");
  } catch (e) {
    log("[BridgePM] freshIdentityPrompt error: " + e);
  }
  return cached;
}

// -- Error Formatting --

/**
 * Format PM chat error for logging and conversation store.
 */
export function formatPmError(
  err: unknown,
  pmProviderId: string,
  pmModelId: string,
): {
  detail: string;
  cause: string;
  stack: string;
  errorCode: PmErrorCode;
  userMessage: string;
  hint: string;
  debugRaw: string;
} {
  const mapped = mapPmNetworkError(err, pmProviderId, pmModelId);
  return {
    detail: mapped.detail,
    cause: mapped.cause,
    stack: mapped.stack,
    errorCode: mapped.errorCode,
    userMessage: mapped.userMessage,
    hint: mapped.hint,
    debugRaw: mapped.debugRaw,
  };
}