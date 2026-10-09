/**
 * pm-gemini-strategy Ã¢â‚¬â€ Gemini implementation of PMModelStrategy.
 *
 * MVP provider for the Auto Loop Bridge PM.
 * Uses the Gemini REST API (generativelanguage.googleapis.com).
 *
 * No external SDK dependency Ã¢â‚¬â€ raw fetch to keep the extension lean.
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

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Ã¢â€â‚¬Ã¢â€â‚¬ Default Models Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const GEMINI_MODELS: PMModelDescriptor[] = [
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: false,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsSystemPrompt: true,
    enabledByDefault: false,
  },
];

// Ã¢â€â‚¬Ã¢â€â‚¬ Strategy Implementation Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export const geminiStrategy: PMModelStrategy = {
  providerId: "gemini",
  label: "Google Gemini",

  async validateConfig(
    config: PMProviderConfig
  ): Promise<ProviderValidationResult> {
    if (!config.apiKeyRef) {
      return { valid: false, error: "API key is required for Gemini" };
    }
    try {
      const res = await fetch(
        `${GEMINI_API_BASE}/models?key=${config.apiKeyRef}`
      );
      if (!res.ok) {
        return { valid: false, error: `Gemini API returned ${res.status}` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Connection failed: ${err}` };
    }
  },

  async listModels(config: PMProviderConfig): Promise<PMModelDescriptor[]> {
    const enabled = config.enabledModelIds;
    if (enabled.length === 0) {
      return GEMINI_MODELS.filter((m) => m.enabledByDefault);
    }
    return GEMINI_MODELS.filter((m) => enabled.includes(m.id));
  },

  async fetchAllModels(): Promise<PMModelDescriptor[]> {
    return GEMINI_MODELS;
  },

  async createClient(config: PMProviderConfig): Promise<PMClient> {
    const modelId = config.defaultModelId ?? "gemini-2.5-flash";
    const apiKey = config.apiKeyRef;
    log(`[GeminiStrategy] createClient: model=${modelId}, hasKey=${!!apiKey}, keyLen=${apiKey?.length ?? 0}`);

    return {
      async send(request: PMProviderRequest): Promise<PMProviderResponse> {
        const model = request.model || modelId;
        const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

        const body = buildGeminiRequestBody(request);
        log(`[GeminiStrategy] send: model=${model}, contents=${body.contents.length}, hasSysInstruction=${!!body.systemInstruction}`);

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          logError(`[GeminiStrategy] API error ${res.status}: ${errText.slice(0, 500)}`);
          throw new Error(`Gemini API error ${res.status}: ${errText}`);
        }

        const data = await res.json() as GeminiResponse;
        log(`[GeminiStrategy] Response: candidates=${data.candidates?.length ?? 0}, promptTokens=${data.usageMetadata?.promptTokenCount ?? '?'}, outTokens=${data.usageMetadata?.candidatesTokenCount ?? '?'}`);
        return parseGeminiResponse(data);
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
    const id = `gem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return parsePmResponseText(response.text, id);
  },
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Gemini API Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

interface GeminiRequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    responseMimeType?: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

function buildGeminiRequestBody(
  request: PMProviderRequest
): GeminiRequestBody {
  const body: GeminiRequestBody = { contents: [] };

  const systemMsg = request.messages.find((m) => m.role === "system");
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  for (const msg of request.messages) {
    if (msg.role === "system") { continue; }
    body.contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }

  body.generationConfig = {
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    responseMimeType: "application/json",
  };

  return body;
}

function parseGeminiResponse(data: GeminiResponse): PMProviderResponse {
  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const usage = data.usageMetadata;

  return {
    text,
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
        }
      : undefined,
    finishReason: data.candidates?.[0]?.finishReason,
  };
}
