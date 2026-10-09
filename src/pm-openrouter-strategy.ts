/**
 * pm-openrouter-strategy â€” OpenRouter implementation of PMModelStrategy.
 *
 * Uses the OpenAI-compatible REST API at api.openrouter.ai/api/v1.
 * No external SDK dependency â€” raw fetch.
 */

import { log, logError } from "./logger";
import {
  PMClient,
  PMModelDescriptor,
  PMProviderConfig,
  PMProviderRequest,
  PMProviderResponse,
  PMRequestInput,
  PmSuggestionResult,
  ProviderValidationResult,
} from "./auto-loop-bridge-types";
import {
  PMModelStrategy,
  PM_SYSTEM_PROMPT,
  buildPmSystemPrompt,
  buildPmUserMessage,
  parsePmResponseText,
} from "./pm-model-strategy";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

function describeOpenRouterKey(apiKey: string): string {
  if (!apiKey) {
    return "missing";
  }
  if (/^AIza[0-9A-Za-z\-_]{35}$/.test(apiKey)) {
    return "gemini-like";
  }
  if (apiKey.startsWith("sk-or-")) {
    return "openrouter-like";
  }
  return "unknown-format";
}

function assertOpenRouterKeyLooksValid(apiKey: string): void {
  const keyKind = describeOpenRouterKey(apiKey);
  if (keyKind === "gemini-like") {
    throw new Error(
      "OpenRouter API key appears to be a Gemini key (AIza...). Configure projectBrain.bridge.openrouterApiKey with a real OpenRouter key.",
    );
  }
}

// â€” Default Models â€”
const OPENROUTER_MODELS: PMModelDescriptor[] = [
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash (OpenRouter)",
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: true,
  },
  {
    id: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4 (OpenRouter)",
    contextWindow: 200000,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    label: "GPT-4.1 Mini (OpenRouter)",
    contextWindow: 1047576,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: true,
  },
];

async function getOpenRouterCatalog(
  config: PMProviderConfig,
): Promise<PMModelDescriptor[]> {
  if (!config.apiKeyRef) {
    log("[OpenRouterStrategy] fetchAllModels: no API key, returning curated list");
    return OPENROUTER_MODELS;
  }
  try {
    const res = await fetch(`${OPENROUTER_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${config.apiKeyRef}` },
    });
    if (!res.ok) {
      logError(`[OpenRouterStrategy] fetchAllModels: API returned ${res.status}`);
      return OPENROUTER_MODELS;
    }
    const data = (await res.json()) as OpenRouterModelsResponse;
    return (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.name || m.id,
      contextWindow: m.context_length,
      supportsStreaming: true,
      supportsSystemPrompt: true,
      enabledByDefault: false,
    }));
  } catch (err) {
    logError(`[OpenRouterStrategy] fetchAllModels failed: ${err}`);
    return OPENROUTER_MODELS;
  }
}

// â€” Strategy Implementation â€”

export const openrouterStrategy: PMModelStrategy = {
  providerId: "openrouter",
  label: "OpenRouter",

  async validateConfig(
    config: PMProviderConfig,
  ): Promise<ProviderValidationResult> {
    if (!config.apiKeyRef) {
      return { valid: false, error: "API key is required for OpenRouter" };
    }
    const apiKey = config.apiKeyRef.trim();
    try {
      assertOpenRouterKeyLooksValid(apiKey);
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await fetch(`${OPENROUTER_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { valid: false, error: `OpenRouter API returned ${res.status}` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Connection failed: ${err}` };
    }
  },

  async listModels(config: PMProviderConfig): Promise<PMModelDescriptor[]> {
    const enabled = config.enabledModelIds;
    if (enabled.length === 0) {
      return OPENROUTER_MODELS.filter((m) => m.enabledByDefault);
    }
    const catalog = await getOpenRouterCatalog(config);
    return catalog.filter((m) => enabled.includes(m.id));
  },

  async createClient(config: PMProviderConfig): Promise<PMClient> {
    const modelId = config.defaultModelId ?? "google/gemini-2.5-flash";
    const apiKey = config.apiKeyRef.trim();
    const keyKind = describeOpenRouterKey(apiKey);
    log(
      `[OpenRouterStrategy] createClient: model=${modelId}, hasKey=${!!apiKey}, keyLen=${apiKey?.length ?? 0}, keyKind=${keyKind}`,
    );
    if (!apiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    assertOpenRouterKeyLooksValid(apiKey);

    return {
      async send(request: PMProviderRequest): Promise<PMProviderResponse> {
        const model = request.model || modelId;
        const url = `${OPENROUTER_API_BASE}/chat/completions`;

        const body = buildOpenRouterBody(request, model);
        const headers = new Headers({
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        });
        const authHeaderPresent = headers.has("Authorization");
        log(
          `[OpenRouterStrategy] send: model=${model}, messages=${body.messages.length}, authHeader=${authHeaderPresent}, keyLen=${apiKey.length}, keyKind=${keyKind}`,
        );

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          const authDiag = `[authDiag header=${authHeaderPresent} keyLen=${apiKey.length} keyKind=${keyKind}]`;
          logError(
            `[OpenRouterStrategy] API error ${res.status} ${authDiag}: ${errText.slice(0, 500)}`,
          );
          throw new Error(`OpenRouter API error ${res.status} ${authDiag}: ${errText}`);
        }

        const data = (await res.json()) as OpenRouterResponse;
        log(
          `[OpenRouterStrategy] Response: choices=${data.choices?.length ?? 0}, usage=${JSON.stringify(data.usage ?? {})}`,
        );
        return parseOpenRouterResponse(data);
      },
    };
  },

  async buildRequest(input: PMRequestInput): Promise<PMProviderRequest> {
    const userMessage = buildPmUserMessage(input);
    return {
      model: "",
      messages: [
        { role: "system", content: buildPmSystemPrompt(input.responseLanguage, input.identityPrompt) },
        { role: "user", content: userMessage },
      ],
      maxTokens: input.budget.maxTokensPerTurn ?? 2048,
      temperature: 0.3,
    };
  },

  parseResponse(response: PMProviderResponse): PmSuggestionResult {
    const id = `or_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return parsePmResponseText(response.text, id);
  },

  async fetchAllModels(config: PMProviderConfig): Promise<PMModelDescriptor[]> {
    return getOpenRouterCatalog(config);
  },
};

// â€” OpenRouter API Helpers â€”

interface OpenRouterBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: string };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
  }>;
}

function buildOpenRouterBody(
  request: PMProviderRequest,
  model: string,
): OpenRouterBody {
  return {
    model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    response_format: { type: "json_object" },
  };
}

function parseOpenRouterResponse(data: OpenRouterResponse): PMProviderResponse {
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage;
  return {
    text,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        }
      : undefined,
    finishReason: data.choices?.[0]?.finish_reason,
  };
}