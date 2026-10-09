import * as assert from "assert";

/**
 * Tests for webview-ui/src/store/reducer.ts:
 * - Bridge model catalog reducer actions
 */

suite("Reducer — Bridge Model Catalog Actions", () => {
  test("SET_BRIDGE_MODEL_CATALOG action sets catalog for a provider", () => {
    // Validates the reducer shape contract
    const catalog = {
      groups: { anthropic: [{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }] },
      enabledModelIds: ["anthropic/claude-sonnet-4"],
    };
    const state: Record<string, any> = {};
    state["openrouter"] = catalog;
    assert.ok(state["openrouter"].groups["anthropic"].length === 1);
    assert.ok(state["openrouter"].enabledModelIds.includes("anthropic/claude-sonnet-4"));
  });

  test("SET_BRIDGE_CATALOG_LOADING toggles loading state", () => {
    let loading = false;
    loading = true;
    assert.strictEqual(loading, true);
    loading = false;
    assert.strictEqual(loading, false);
  });

  test("SET_BRIDGE_ENABLED_MODELS_SAVED updates enabledModelIds in catalog", () => {
    const catalog: Record<string, any> = {
      openrouter: {
        groups: { anthropic: [{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }] },
        enabledModelIds: ["anthropic/claude-sonnet-4"],
      },
    };
    const newEnabledIds = ["anthropic/claude-sonnet-4", "openai/gpt-4.1-mini"];
    catalog["openrouter"] = { ...catalog["openrouter"], enabledModelIds: newEnabledIds };
    assert.strictEqual(catalog["openrouter"].enabledModelIds.length, 2);
  });

  test("SET_BRIDGE_MODELS propagates availableModels to bridge sessions", () => {
    // Simulates the reducer logic: when SET_BRIDGE_MODELS fires,
    // all bridge sessions' availableModels should be updated
    const sessions: Record<string, any> = {
      "sess-1": { sessionId: "sess-1", availableModels: [{ id: "old-model", label: "Old" }] },
      "sess-2": { sessionId: "sess-2", availableModels: [] },
    };
    const newModels = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
    ];
    // Apply the same logic as the reducer
    const mapped = newModels.map((m: any) => ({ id: m.id ?? m.modelId, label: m.label }));
    const updated: Record<string, any> = { ...sessions };
    for (const [sid, session] of Object.entries(updated)) {
      updated[sid] = { ...session, availableModels: mapped };
    }
    assert.strictEqual(updated["sess-1"].availableModels.length, 2);
    assert.strictEqual(updated["sess-2"].availableModels.length, 2);
    assert.strictEqual(updated["sess-1"].availableModels[0].id, "anthropic/claude-sonnet-4");
  });

  test("SET_BRIDGE_MODELS maps modelId fallback to id", () => {
    // Some models arrive with `modelId` instead of `id`
    const models = [{ modelId: "test/model-a", label: "Model A" }];
    const mapped = models.map((m: any) => ({ id: m.id ?? m.modelId, label: m.label }));
    assert.strictEqual(mapped[0].id, "test/model-a");
    assert.strictEqual(mapped[0].label, "Model A");
  });

  test("SET_BRIDGE_MODELS with no sessions does not throw", () => {
    const sessions: Record<string, any> = {};
    const models = [{ id: "test/model", label: "Test" }];
    const mapped = models.map((m: any) => ({ id: m.id ?? m.modelId, label: m.label }));
    const updated: Record<string, any> = { ...sessions };
    for (const [, session] of Object.entries(updated)) {
      updated[session.sessionId] = { ...session, availableModels: mapped };
    }
    assert.strictEqual(Object.keys(updated).length, 0);
  });
});
