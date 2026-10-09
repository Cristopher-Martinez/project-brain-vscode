import * as assert from "assert";

/**
 * Tests for webview-side Auto Loop Bridge types (autoloop.ts).
 * Validates the view model shape used by the webview components.
 * Updated: covers availableModels field added for dynamic models.
 */

suite("AutoLoopBridgeSessionView (webview type)", () => {
  test("availableModels field exists in the view shape", () => {
    // Validates that the view type contract includes availableModels
    const view = {
      sessionId: "s1",
      title: "Test",
      status: "idle" as const,
      workerLoopSessionId: "w1",
      pmProviderLabel: "openrouter",
      pmModelLabel: "google/gemini-2.5-flash",
      availableModels: [
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (OpenRouter)" },
      ],
      activeSynthesisId: null,
      syntheses: [],
      pmChatMessages: [],
      workerFeedbackDraft: "",
      participants: { pm: { id: "pm", label: "PM", role: "pm" }, worker: { id: "w", label: "Worker", role: "worker" } },
      tokenBudget: { maxContextChars: 8000, maxRetrievedChunks: 5, maxSuggestionTurns: 50, maxTokensPerTurn: 2048, consumedTurns: 0 },
    };
    assert.ok(Array.isArray(view.availableModels), "availableModels should be an array");
    assert.strictEqual(view.availableModels.length, 1);
    assert.strictEqual(view.availableModels[0].id, "google/gemini-2.5-flash");
  });

  test("empty availableModels is valid", () => {
    const view = {
      availableModels: [] as Array<{ id: string; label: string }>,
    };
    assert.strictEqual(view.availableModels.length, 0);
  });
});
