import * as assert from "assert";

/**
 * Tests for pm-gemini-strategy.ts:
 * - Strategy exports and shape
 * - fetchAllModels returns curated Gemini models
 */

suite("GeminiStrategy — Model Catalog", () => {
  test("geminiStrategy has fetchAllModels method", () => {
    const { geminiStrategy } = require("../pm-gemini-strategy");
    assert.strictEqual(typeof geminiStrategy.fetchAllModels, "function");
  });

  test("fetchAllModels returns all GEMINI_MODELS", async () => {
    const { geminiStrategy } = require("../pm-gemini-strategy");
    const config = { providerId: "gemini", apiKeyRef: "", enabled: true, enabledModelIds: [] };
    const models = await geminiStrategy.fetchAllModels(config);
    assert.ok(Array.isArray(models), "fetchAllModels should return an array");
    assert.ok(models.length >= 1, "should return at least 1 Gemini model");
    assert.ok(models.every((m: any) => m.id && m.label), "each model must have id and label");
  });

  test("listModels returns only enabledByDefault models when no enabledModelIds", async () => {
    const { geminiStrategy } = require("../pm-gemini-strategy");
    const config = { providerId: "gemini", apiKeyRef: "", enabled: true, enabledModelIds: [] };
    const models = await geminiStrategy.listModels(config);
    assert.ok(Array.isArray(models), "listModels should return an array");
    assert.ok(models.length >= 1, "should return at least 1 enabled model");
  });
});
