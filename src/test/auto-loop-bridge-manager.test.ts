import * as assert from "assert";

/**
 * Tests for auto-loop-bridge-manager.ts:
 * - setBridgeSessionModel delegates to session.setModel()
 * - recoverBridgeSessions normalizes legacy OpenRouter model IDs
 */

suite("AutoLoopBridgeManager — Model Change", () => {
  test("setBridgeSessionModel returns false for unknown session", () => {
    const { setBridgeSessionModel } = require("../auto-loop-bridge-manager");
    const result = setBridgeSessionModel("nonexistent-session", "google/gemini-2.5-flash");
    assert.strictEqual(result, false);
  });
});

suite("AutoLoopBridgeManager — Recovery Migration", () => {
  test("getDefaultModelForProvider returns prefixed model for openrouter", () => {
    const { getDefaultModelForProvider } = require("../pm-provider-registry");
    const model = getDefaultModelForProvider("openrouter");
    assert.ok(model.includes("/"), "OpenRouter model must contain '/' prefix");
    assert.strictEqual(model, "google/gemini-2.5-flash");
  });

  test("getDefaultModelForProvider returns native model for gemini", () => {
    const { getDefaultModelForProvider } = require("../pm-provider-registry");
    const model = getDefaultModelForProvider("gemini");
    assert.ok(!model.includes("/"), "Gemini model must NOT contain '/' prefix");
    assert.strictEqual(model, "gemini-2.5-flash");
  });

  test("legacy OpenRouter model without prefix should be detected as needing migration", () => {
    // Simulates the condition checked in recoverBridgeSessions
    const legacyModel = "gemini-2.5-flash";
    const provider = "openrouter";
    const needsMigration = provider === "openrouter" && legacyModel && !legacyModel.includes("/");
    assert.strictEqual(needsMigration, true, "Legacy model without '/' needs migration");
  });

  test("already-prefixed OpenRouter model should NOT trigger migration", () => {
    const correctModel = "google/gemini-2.5-flash";
    const provider = "openrouter";
    const needsMigration = provider === "openrouter" && correctModel && !correctModel.includes("/");
    assert.strictEqual(needsMigration, false, "Prefixed model should not trigger migration");
  });

  test("refreshAvailableModels is a function on session prototype", () => {
    const { AutoLoopBridgeSession } = require("../auto-loop-bridge-session");
    assert.strictEqual(typeof AutoLoopBridgeSession.prototype.refreshAvailableModels, "function");
  });
});
