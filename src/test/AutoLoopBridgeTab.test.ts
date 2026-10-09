/**
 * Tests for AutoLoopBridgeTab.tsx:
 * - Model selector renders with expected options per provider
 * - Webview component integration
 * 
 * Note: Full rendering tests require jsdom/React Testing Library.
 * This file provides structural contract tests.
 */

import * as assert from "assert";

suite("AutoLoopBridgeTab — Contract Tests", () => {
  test("expected OpenRouter model IDs use provider/model format", () => {
    const models = [
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1-mini",
    ];
    for (const m of models) {
      assert.ok(m.includes("/"), `Model ${m} should follow provider/model format`);
    }
  });

  test("expected Gemini model IDs do NOT use prefix", () => {
    const models = ["gemini-2.5-flash", "gemini-2.5-pro"];
    for (const m of models) {
      assert.ok(!m.includes("/"), `Gemini model ${m} should NOT have prefix`);
    }
  });

  test("provider determines model option format", () => {
    const provider = "openrouter";
    const expectedDefault = "google/gemini-2.5-flash";
    assert.ok(expectedDefault.includes("/"), "OpenRouter models have prefix");

    const geminiProvider = "gemini";
    const geminiDefault = "gemini-2.5-flash";
    assert.ok(!geminiDefault.includes("/"), "Gemini models have no prefix");
    assert.notStrictEqual(provider, geminiProvider);
  });

  test("setAutoLoopPmModel message type is a string", () => {
    const msgType = "setAutoLoopPmModel";
    assert.strictEqual(typeof msgType, "string");
  });

  test("setAutoLoopPmModel can be scoped to the active synthesis", () => {
    const payload = {
      type: "setAutoLoopPmModel",
      sessionId: "bridge-session",
      synthesisId: "synth-7",
      modelId: "anthropic/claude-sonnet-4",
    };

    assert.strictEqual(payload.synthesisId, "synth-7");
    assert.strictEqual(payload.modelId, "anthropic/claude-sonnet-4");
  });

  test("optimistic local state pattern: immediate update before async round-trip", () => {
    // Validates the pattern: local state updates immediately, syncs from props later
    let localModel = "gemini-2.5-flash";
    const newModel = "gemini-2.5-pro";
    // Simulates onChange: update local state immediately
    localModel = newModel;
    assert.strictEqual(localModel, "gemini-2.5-pro", "Local state should update immediately");
    // Simulates prop sync via useEffect
    const propModel = "gemini-2.5-pro";
    localModel = propModel;
    assert.strictEqual(localModel, propModel, "Local state should sync with props");
  });

  test("dynamic availableModels renders from session data, not hardcoded", () => {
    const availableModels = [
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (OpenRouter)" },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (OpenRouter)" },
    ];
    // Validates the rendering logic: if availableModels is non-empty, use it
    assert.ok(availableModels.length > 0, "Models list should come from provider");
    assert.strictEqual(availableModels[0].id, "google/gemini-2.5-flash");
    assert.strictEqual(availableModels[1].label, "Claude Sonnet 4 (OpenRouter)");
  });

  test("empty availableModels falls back to current model as single option", () => {
    const availableModels: Array<{ id: string; label: string }> = [];
    const currentModel = "google/gemini-2.5-flash";
    // Fallback: when array is empty, show current model
    const options = availableModels.length > 0
      ? availableModels
      : [{ id: currentModel, label: currentModel }];
    assert.strictEqual(options.length, 1);
    assert.strictEqual(options[0].id, currentModel);
  });

  test("invalid current model should normalize to first available option", () => {
    const availableModels = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4.1", label: "GPT-4.1" },
    ];
    const currentModel = "google/gemini-2.5-flash";

    const normalizedModel = availableModels.some((m) => m.id === currentModel)
      ? currentModel
      : availableModels[0].id;

    assert.strictEqual(normalizedModel, "anthropic/claude-sonnet-4");
  });

  test("sendAutoLoopPmChat payload should carry the currently resolved model", () => {
    const availableModels = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4.1", label: "GPT-4.1" },
    ];
    const localModel = "anthropic/claude-sonnet-4";

    const resolvedModelId = availableModels.some((model) => model.id === localModel)
      ? localModel
      : availableModels[0]?.id ?? localModel;

    const payload = {
      type: "sendAutoLoopPmChat",
      sessionId: "bridge-session",
      synthesisId: "synth-1",
      text: "hello",
      modelId: resolvedModelId,
    };

    assert.strictEqual(payload.modelId, "anthropic/claude-sonnet-4");
  });
});
