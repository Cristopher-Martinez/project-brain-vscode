/**
 * auto-loop-bridge-session-helpers -- Extracted helpers for session internals.
 *
 * Contains: participant builder, chat message appenders, PM client resolution.
 * Extracted from auto-loop-bridge-session.ts to respect 400-line limit.
 */

import type {
  BridgeParticipants,
  PmChatMessage,
  PMClient,
  PMProviderConfig,
  BridgeTaskMemoryData,
  PmSuggestionResult,
} from "./auto-loop-bridge-types";
import type { BridgeSessionConfig } from "./auto-loop-bridge-session";
import { updatePmChatSummary } from "./auto-loop-task-memory";
import { log, logError } from "./logger";
import { resolveBridgeApiKey, isWrongProviderKey } from "./bridge-api-key-resolver";
import { createClient } from "./pm-provider-registry";

// -- Participant Builder --------------------------------------------------------

export function buildParticipants(config: BridgeSessionConfig): BridgeParticipants {
  return {
    user: {
      role: "user" as const,
      label: "CTO (You)",
      active: true,
    },
    pm: {
      role: "pm" as const,
      label: `PM (${config.pmProviderId}/${config.pmModelId})`,
      active: true,
    },
    worker: {
      role: "worker" as const,
      label: `Loop ${config.workerLoopSessionId.slice(0, 8)}`,
      active: true,
    },
  };
}

// -- Chat Message Helpers -------------------------------------------------------

/**
 * Maximum messages to keep in memory per synthesis thread.
 * Context assembler only sends last 20, so 40 gives breathing room.
 */
const MAX_INMEMORY_MESSAGES = 40;
const EVICT_TO = 30;

export function appendUserMessage(
  pmChatMessages: Map<string, PmChatMessage[]>,
  synthesisId: string,
  text: string,
): void {
  const msgs = pmChatMessages.get(synthesisId) ?? [];
  msgs.push({
    id: `usr_${Date.now()}`,
    synthesisId,
    role: "user",
    text,
    timestamp: Date.now(),
  });
  // Sliding window eviction — keep only the most recent messages in RAM
  if (msgs.length > MAX_INMEMORY_MESSAGES) {
    pmChatMessages.set(synthesisId, msgs.slice(-EVICT_TO));
  } else {
    pmChatMessages.set(synthesisId, msgs);
  }
}

export interface AppendPmResponseResult {
  updatedTaskMemory: BridgeTaskMemoryData;
  threadSummary: string;
}

export function appendPmResponse(
  pmChatMessages: Map<string, PmChatMessage[]>,
  lastSuggestions: Map<string, PmSuggestionResult>,
  taskMemory: BridgeTaskMemoryData,
  pmChatThreads: Record<string, { synthesisId: string; summary: string; lastUpdatedAt: number; turnCount: number; modelId?: string }>,
  synthesisId: string,
  suggestion: PmSuggestionResult,
): AppendPmResponseResult {
  const msgs = pmChatMessages.get(synthesisId) ?? [];
  msgs.push({
    id: suggestion.id,
    synthesisId,
    role: "pm",
    text: suggestion.recommendation,
    timestamp: Date.now(),
    suggestion,
  });
  // Sliding window eviction — same policy as appendUserMessage
  if (msgs.length > MAX_INMEMORY_MESSAGES) {
    pmChatMessages.set(synthesisId, msgs.slice(-EVICT_TO));
  } else {
    pmChatMessages.set(synthesisId, msgs);
  }
  lastSuggestions.set(suggestion.id, suggestion);

  const threadSummary = `${msgs.length} turns -- last: ${suggestion.recommendation.slice(0, 80)}`;
  pmChatThreads[synthesisId] = {
    synthesisId,
    summary: threadSummary,
    lastUpdatedAt: Date.now(),
    turnCount: msgs.length,
    modelId: pmChatThreads[synthesisId]?.modelId,
  };
  const updated = updatePmChatSummary(taskMemory, synthesisId, threadSummary);
  return { updatedTaskMemory: updated, threadSummary };
}

// -- PM Client Resolution -------------------------------------------------------

async function resolvePmProviderConfig(
  pmProviderConfig: PMProviderConfig,
  pmProviderId: string,
): Promise<PMProviderConfig> {
  let config = {
    ...pmProviderConfig,
    apiKeyRef: pmProviderConfig.apiKeyRef.trim(),
  };
  // Detect cross-provider contamination (e.g. Gemini key cached for OpenRouter via snapshot)
  if (config.apiKeyRef && isWrongProviderKey(config.apiKeyRef, pmProviderId)) {
    log(`[BridgeSession] Cached API key for ${pmProviderId} belongs to wrong provider — forcing re-resolution`);
    config = { ...config, apiKeyRef: "" };
  }
  if (!config.apiKeyRef || config.apiKeyRef.startsWith("projectBrain.")) {
    const resolved = await resolveBridgeApiKey(pmProviderId);
    if (resolved.apiKey) {
      config = { ...config, apiKeyRef: resolved.apiKey };
      log(
        `[BridgeSession] API key resolved: source=${resolved.source}, len=${resolved.apiKey.length}`,
      );
    } else {
      log(
        `[BridgeSession] API key missing for ${pmProviderId}; checked=${resolved.checkedSources.join(" | ")}`,
      );
      if (pmProviderId === "openrouter") {
        throw new Error(
          `OpenRouter API key not configured (checked: ${resolved.checkedSources.join(" | ") || "none"})`,
        );
      }
    }
  }
  return config;
}

export async function resolveOrCreatePmClient(
  existing: PMClient | null,
  pmProviderConfig: PMProviderConfig,
  pmProviderId: string,
): Promise<{ client: PMClient | null; config: PMProviderConfig }> {
  const config = await resolvePmProviderConfig(pmProviderConfig, pmProviderId);
  const keyChanged = config.apiKeyRef !== pmProviderConfig.apiKeyRef.trim();

  if (existing && !keyChanged) {
    log("[BridgeSession] Reusing existing PM client");
    return { client: existing, config };
  }

  if (existing && keyChanged) {
    log("[BridgeSession] PM client config changed, recreating client");
    existing.dispose?.();
  }

  log(`[BridgeSession] Creating new PM client: provider=${pmProviderId}, hasApiKey=${!!config.apiKeyRef}, keyLen=${config.apiKeyRef?.length ?? 0}`);
  try {
    const client = await createClient(pmProviderId, config);
    log(`[BridgeSession] PM client created: ${client ? "OK" : "NULL"}`);
    return { client, config };
  } catch (err) {
    logError(`[BridgeSession] PM client creation failed: ${err}`);
    throw err;
  }
}