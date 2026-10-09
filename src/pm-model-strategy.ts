/**
 * pm-model-strategy — Strategy interface for PM model providers.
 *
 * Follows the same pattern as server/src/embedding-types.ts
 * (EmbeddingProvider interface with validateConfig, listModels, etc.)
 *
 * Each PM provider (Gemini, OpenAI, Anthropic, etc.) implements this
 * interface. The registry resolves which strategy to use at runtime.
 */

import {
  PMClient,
  PMModelDescriptor,
  PMProviderConfig,
  PMProviderRequest,
  PMProviderResponse,
  PMRequestInput,
  PmSuggestionResult,
  PmIntent,
  PM_INTENT_VALUES,
  ProviderValidationResult,
} from "./auto-loop-bridge-types";
import { log, logWarn } from "./logger";

// ── Strategy Interface ───────────────────────────────────────────

/**
 * Contract for PM model providers.
 * Each provider implements this to handle config validation,
 * model listing, client creation, request building, and response parsing.
 */
export interface PMModelStrategy {
  readonly providerId: string;
  readonly label: string;

  /** Check if provider config is valid (API key present, etc.) */
  validateConfig(config: PMProviderConfig): Promise<ProviderValidationResult>;

  /** List available models for this provider (filtered by config) */
  listModels(config: PMProviderConfig): Promise<PMModelDescriptor[]>;

  /** Fetch the full model catalog from the provider's API (optional) */
  fetchAllModels?(config: PMProviderConfig): Promise<PMModelDescriptor[]>;

  /** Create a client instance from config */
  createClient(config: PMProviderConfig): Promise<PMClient>;

  /** Build a provider-specific request from normalized input */
  buildRequest(input: PMRequestInput): Promise<PMProviderRequest>;

  /** Parse a provider response into a structured suggestion */
  parseResponse(response: PMProviderResponse): PmSuggestionResult;
}

// ── System Prompt ────────────────────────────────────────────────

/**
 * Default system prompt template for PM role.
 * Providers can customize but should preserve the structured output format.
 */
export const PM_SYSTEM_PROMPT = `You are a PM (Product Manager) in an Auto Loop Bridge session. You are having a conversation with a human user who is overseeing an AI worker loop.

Your role:
- TALK DIRECTLY TO THE USER � they are your conversation partner
- Help them understand the worker's progress
- Offer strategic recommendations and flag risks
- When the user asks questions, ANSWER THEM directly and conversationally
- Suggest concrete feedback they can send to the worker

INTENT CLASSIFICATION (CRITICAL � read carefully):

Before responding, classify the user's message into one of these intents:

1. "direct_answer" � The user is talking TO YOU. They want YOUR opinion, YOUR analysis, or for YOU to generate content (markdown, summary, plan, etc.). Put your FULL response in "recommendation". Leave suggestedWorkerFeedback EMPTY.
   Examples: "What do you think?", "Give me a markdown of...", "Explain the progress", "What should we do next?", "Summarize what happened"

2. "delegate" � The user wants to INSTRUCT THE WORKER to do something. They are asking you to relay a task, not to do it yourself. Put a brief explanation in "recommendation" and the detailed worker instruction in "suggestedWorkerFeedback".
   Examples: "Tell the worker to fix the bug", "Have it refactor the module", "Send it instructions to add tests"

3. "clarification" � You need more information to help. Ask your question in "recommendation". Leave suggestedWorkerFeedback EMPTY.

4. "status_check" � User just wants a progress update. Summarize the synthesis in "recommendation". Leave suggestedWorkerFeedback EMPTY.

DEFAULT TO "direct_answer" WHEN UNSURE. Never put worker instructions in recommendation.

You must ALWAYS respond in this JSON structure:
{
  "intent": "direct_answer" | "delegate" | "clarification" | "status_check",
  "recommendation": "Your direct response to the user",
  "reasoning": "Your analysis of the situation (2-5 sentences)",
  "risk": "low" | "medium" | "high",
  "suggestedWorkerFeedback": "Exact text to send to the worker if approved (EMPTY unless intent is delegate)"
}

Rules:
- Be concise � the user pays per token
- ADDRESS THE USER directly (e.g. "Based on what I see..." or "I recommend...")
- NEVER talk about "the worker" as if writing an internal report � you are in a live chat
- When the user asks a question or asks you to generate content, the "recommendation" field IS your full answer
- For "direct_answer" intent: recommendation can be as long as needed (no 4-sentence limit)
- Focus on the active synthesis context
- If the worker is on track, say so briefly

WORKER LOOP STATE AWARENESS:
You receive a "Worker Loop Status" section in context. Use it:
- "awaiting" = Loop is waiting for feedback. You can suggest sending feedback via the dispatch button.
- "active" = Worker is still processing. Tell the user to wait. Do NOT suggest sending feedback.
- "disconnected" = Loop lost connection. Your response MUST tell the user: "El loop se desconectó. Haz click en el botón 🔄 Reconnect Loop en la barra de feedback para reconectarlo automáticamente." Do NOT say you can't reconnect — the button handles it. Do NOT suggest sending feedback.
- "completed" = Loop finished. Summarize outcomes. No more feedback possible.
- "error" = Loop encountered an error. Suggest checking logs or restarting.
- "canDispatchFeedback: no" = Even if state is awaiting, the dispatch route is broken. Warn the user.`;

/**
 * Build PM system prompt, optionally with language instruction.
 * When language != "auto", appends a strict language directive.
 */
export function buildPmSystemPrompt(language?: string, identityPrompt?: string): string {
  let prompt = PM_SYSTEM_PROMPT;
  if (language && language !== "auto") {
    prompt += `\n\nIMPORTANT: You MUST respond entirely in ${language}. All JSON field values must be in ${language}.`;
  }
  if (identityPrompt) {
    prompt += `\n\nAGENT IDENTITY CONTEXT:\n${identityPrompt}\nAdopt this identity in your responses. Address the user as indicated in the identity context.`;
  }
  return prompt;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Build the user message for the PM from the request input.
 * Assembles objective + synthesis + decisions + retrieval into one prompt.
 */
export function buildPmUserMessage(input: PMRequestInput): string {
  const parts: string[] = [];

  parts.push(`## Objective\n${input.objective}`);
  parts.push(
    `## Active Synthesis (Round ${input.activeSynthesis.round})\n${input.activeSynthesis.content}`
  );

  if (input.workerLoopSessionId || input.workerLoopState) {
    parts.push(
      `## Worker Loop Status\n` +
        `sessionId: ${input.workerLoopSessionId ?? "unknown"}\n` +
        `state: ${input.workerLoopState ?? "unknown"}\n` +
        `canDispatchFeedback: ${input.canDispatchFeedback === true ? "yes" : "no"}`,
    );
  }

  if (input.decisionsSummary) {
    parts.push(`## Previous Decisions\n${input.decisionsSummary}`);
  }

  if (input.retrievalPack.length > 0) {
    parts.push(
      `## Relevant Context (from memory)\n${input.retrievalPack.join("\n---\n")}`
    );
  }

  if (input.preClassifiedIntent) {
    parts.push(`## Pre-classified Intent: ${input.preClassifiedIntent}\nRespond accordingly. If intent is "direct_answer", put your full answer in "recommendation" and leave "suggestedWorkerFeedback" empty.`);
  }

  if (input.userMessage) {
    parts.push(`## User Question\n${input.userMessage}`);
  }

  const msg = parts.join("\n\n");
  log(`[PMStrategy] buildUserMessage: ${parts.length} sections, ${msg.length} chars`);
  return msg;
}

/**
 * Try to parse a PM response text as structured JSON.
 * Falls back to wrapping the raw text as recommendation if parsing fails.
 */
/**
 * Infer intent from PM response. Tries explicit field first, then heuristic.
 */
export function inferIntent(parsed: Record<string, unknown>): PmIntent {
  const explicit = String(parsed.intent || "");
  if ((PM_INTENT_VALUES as readonly string[]).includes(explicit)) {
    return explicit as PmIntent;
  }
  // Fallback heuristic: empty suggestedWorkerFeedback ? direct_answer
  const swf = String(parsed.suggestedWorkerFeedback || "").trim();
  if (!swf) { return "direct_answer"; }
  const rec = String(parsed.recommendation || "");
  if (rec.length < 200 && swf.length > rec.length) { return "delegate"; }
  return "direct_answer";
}

/**
 * Try to parse a PM response text as structured JSON.
 * Falls back to wrapping the raw text as recommendation if parsing fails.
 */
export function parsePmResponseText(
  text: string,
  suggestionId: string
): PmSuggestionResult {
  log(`[PMStrategy] parseResponse: textLen=${text.length}, id=${suggestionId}`);
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const intent = inferIntent(parsed);
      log(`[PMStrategy] parseResponse: JSON parsed OK, intent=${intent}, risk=${parsed.risk}, recLen=${String(parsed.recommendation || "").length}`);
      return {
        id: suggestionId,
        intent,
        recommendation: String(parsed.recommendation || ""),
        reasoning: String(parsed.reasoning || ""),
        risk: validateRisk(parsed.risk),
        suggestedWorkerFeedback: String(
          parsed.suggestedWorkerFeedback || ""
        ),
        raw: text,
      };
    }
  } catch (err) {
    // JSON parse failed � fall through to fallback
    logWarn(`[PMStrategy] parseResponse: JSON parse failed: ${err}`);
  }

  logWarn(`[PMStrategy] parseResponse: falling back to raw text wrapping`);
  return {
    id: suggestionId,
    intent: "direct_answer",
    recommendation: text.slice(0, 500),
    reasoning: "Could not parse structured response from PM.",
    risk: "medium",
    suggestedWorkerFeedback: "",
    raw: text,
  };
}

function validateRisk(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}