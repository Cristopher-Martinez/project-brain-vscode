/**
 * pm-intent-classifier � pre-classification of user messages via cheap LLM call.
 *
 * Uses the same PM client but with a minimal prompt to classify intent
 * BEFORE the full PM response. This is more reliable than self-classification.
 */

import { PmIntent, PM_INTENT_VALUES, PMClient, PMProviderRequest } from "./auto-loop-bridge-types";
import { log, logWarn } from "./logger";

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier. Given a user message in a PM-worker bridge session, classify the intent.

Respond with EXACTLY one of these words as plain text (not json, just one word):
- direct_answer � user is asking a question or requesting content FROM YOU
- delegate � user wants to instruct the WORKER to do something
- clarification � user message is ambiguous, needs clarification
- status_check � user is asking for a progress update

Examples:
"give me a markdown summary" ? direct_answer
"tell the worker to fix the bug" ? delegate
"what do you think?" ? direct_answer
"have it add tests" ? delegate
"how is it going?" ? status_check
"refactor that module" ? delegate
"explain what happened" ? direct_answer`;

/**
 * Pre-classify intent using a cheap LLM call.
 * Returns null if classification fails (caller should fallback to self-classification).
 */
export async function classifyIntent(
  client: PMClient,
  userMessage: string,
  model: string,
): Promise<PmIntent | null> {
  try {
    const request: PMProviderRequest = {
      model,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userMessage.slice(0, 500) },
      ],
      maxTokens: 20,
    };

    log(`[IntentClassifier] classifying: "${userMessage.slice(0, 80)}..."`);
    const response = await client.send(request);
    const raw = (response.text ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");

    if ((PM_INTENT_VALUES as readonly string[]).includes(raw)) {
      log(`[IntentClassifier] classified as: ${raw}`);
      return raw as PmIntent;
    }

    // Try partial match
    for (const intent of PM_INTENT_VALUES) {
      if (raw.includes(intent)) {
        log(`[IntentClassifier] partial match: ${raw} ? ${intent}`);
        return intent;
      }
    }

    logWarn(`[IntentClassifier] unrecognized response: "${raw}"`);
    return null;
  } catch (err) {
    logWarn(`[IntentClassifier] classification failed: ${err}`);
    return null;
  }
}
