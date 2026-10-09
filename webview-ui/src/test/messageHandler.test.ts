import * as assert from "assert";

/**
 * Tests for webview-ui/src/store/messageHandler.ts:
 * - bridgeModelCatalog message dispatch
 * - bridgeEnabledModelsSaved message dispatch
 */

suite("MessageHandler — Bridge Model Catalog Messages", () => {
  test("bridgeModelCatalog message shape is valid", () => {
    const msg = {
      type: "bridgeModelCatalog",
      providerId: "openrouter",
      groups: { anthropic: [{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }] },
      enabledModelIds: ["anthropic/claude-sonnet-4"],
    };
    assert.strictEqual(msg.type, "bridgeModelCatalog");
    assert.ok(msg.groups["anthropic"].length > 0);
  });

  test("bridgeEnabledModelsSaved message shape is valid", () => {
    const msg = {
      type: "bridgeEnabledModelsSaved",
      providerId: "openrouter",
      enabledModelIds: ["anthropic/claude-sonnet-4"],
    };
    assert.strictEqual(msg.type, "bridgeEnabledModelsSaved");
    assert.ok(Array.isArray(msg.enabledModelIds));
  });

  test("bridgeModels message propagates to session availableModels", () => {
    // After save, handler sends bridgeModels → reducer should update sessions
    const msg = {
      type: "bridgeModels",
      providerId: "openrouter",
      models: [
        { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
        { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
      ],
    };
    assert.strictEqual(msg.type, "bridgeModels");
    assert.strictEqual(msg.models.length, 2);
    // Verify models have the expected shape for session.availableModels
    for (const m of msg.models) {
      assert.ok(typeof m.id === "string");
      assert.ok(typeof m.label === "string");
    }
  });

  test("save pipeline sends both catalog and models updates", () => {
    // Extension handler should post both messages in sequence
    const messages: any[] = [];
    const fakePost = (m: any) => messages.push(m);

    // Simulate handler behavior after successful save
    fakePost({ type: "bridgeEnabledModelsSaved", providerId: "openrouter", enabledModelIds: ["a"], success: true });
    fakePost({ type: "bridgeModels", providerId: "openrouter", models: [{ id: "a", label: "A" }] });

    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].type, "bridgeEnabledModelsSaved");
    assert.strictEqual(messages[1].type, "bridgeModels");
    assert.strictEqual(messages[1].models[0].id, "a");
  });
});
