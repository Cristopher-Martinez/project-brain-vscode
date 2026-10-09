import * as assert from "assert";

/**
 * Tests for pm-model-strategy.ts:
 * - PMModelStrategy interface shape (fetchAllModels is optional)
 * - buildPmSystemPrompt and buildPmUserMessage exports
 */

suite("PMModelStrategy — Interface & Helpers", () => {
  test("buildPmSystemPrompt returns a string", () => {
    const { buildPmSystemPrompt } = require("../pm-model-strategy");
    const prompt = buildPmSystemPrompt();
    assert.strictEqual(typeof prompt, "string");
    assert.ok(prompt.length > 0, "prompt should not be empty");
  });

  test("buildPmUserMessage returns a string", () => {
    const { buildPmUserMessage } = require("../pm-model-strategy");
    const msg = buildPmUserMessage({
      sessionGoal: "Test goal",
      workerSynthesis: "Worker done",
      humanFeedback: null,
      conversationHistory: [],
    });
    assert.strictEqual(typeof msg, "string");
    assert.ok(msg.includes("Test goal"), "should contain the session goal");
  });

  test("inferIntent returns a valid intent", () => {
    const { inferIntent } = require("../pm-model-strategy");
    const intent = inferIntent({ action: "suggest" });
    assert.ok(typeof intent === "string", "intent should be a string");
  });

  test("fetchAllModels is an optional method on strategies", () => {
    // Validates that a strategy without fetchAllModels still conforms
    const { registerStrategy, listModels, clearRegistry } = require("../pm-provider-registry");
    clearRegistry();
    const minimalStrategy = {
      providerId: "minimal",
      label: "Minimal",
      validateConfig: async () => ({ valid: true }),
      listModels: async () => [{ id: "m1", label: "M1" }],
      createClient: async () => ({ send: async () => ({ text: "" }) }),
      buildRequest: async () => ({ model: "", messages: [] }),
      parseResponse: () => ({ id: "", type: "suggest", content: "" }),
    };
    // Should not throw — fetchAllModels is optional
    registerStrategy(minimalStrategy);
    return listModels("minimal", { providerId: "minimal", apiKeyRef: "", enabled: true, enabledModelIds: [] })
      .then((models: any[]) => {
        assert.strictEqual(models.length, 1);
        clearRegistry();
      });
  });
});
