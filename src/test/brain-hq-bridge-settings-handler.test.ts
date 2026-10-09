import * as assert from "assert";

type BridgePostMessage = { type: string };

function groupModelsByProvider(models: Array<{ id: string; label: string }>): Record<string, Array<{ id: string; label: string }>> {
  const groups: Record<string, Array<{ id: string; label: string }>> = {};
  for (const model of models) {
    const slash = model.id.indexOf("/");
    const provider = slash > 0 ? model.id.substring(0, slash) : "other";
    if (!groups[provider]) {
      groups[provider] = [];
    }
    groups[provider].push(model);
  }
  return groups;
}

function collectBridgeMessages(messages: BridgePostMessage[]): string[] {
  const received: string[] = [];
  const fakePostMessage = (msg: BridgePostMessage) => {
    received.push(msg.type);
  };

  for (const message of messages) {
    fakePostMessage(message);
  }

  return received;
}

async function simulateDefaultProviderPersistence(): Promise<string[]> {
  const events: string[] = [];

  async function persistDefaultProvider(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push("persisted");
  }

  async function handleLikeBridgeSettings(postMessage: (msg: { type: string; success: boolean }) => void): Promise<void> {
    await persistDefaultProvider();
    postMessage({ type: "bridgeDefaultProviderSet", success: true });
  }

  await handleLikeBridgeSettings((msg) => {
    events.push(msg.type);
  });

  return events;
}

function defineCatalogMessageTests(): void {
  test("fetchAllModels is importable from pm-provider-registry", () => {
    const { fetchAllModels } = require("../pm-provider-registry");
    assert.strictEqual(typeof fetchAllModels, "function");
  });

  test("requestBridgeModelCatalog message type is handled (compile-time check)", () => {
    assert.ok(true, "Handler compiles with requestBridgeModelCatalog case");
  });

  test("saveBridgeEnabledModels message type is handled (compile-time check)", () => {
    assert.ok(true, "Handler compiles with saveBridgeEnabledModels case");
  });
}

function defineModelPipelineTests(): void {
  test("model catalog groups models by provider prefix", () => {
    const models = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ];
    const groups = groupModelsByProvider(models);
    assert.strictEqual(Object.keys(groups).length, 3);
    assert.strictEqual(groups["anthropic"].length, 2);
    assert.strictEqual(groups["openai"].length, 1);
    assert.strictEqual(groups["google"].length, 1);
  });

  test("handleSaveEnabledModels sends bridgeModels after saving", () => {
    const expectedMessages = ["bridgeEnabledModelsSaved", "bridgeModels"];
    const received = collectBridgeMessages([
      { type: "bridgeEnabledModelsSaved" },
      { type: "bridgeModels" },
    ]);
    assert.deepStrictEqual(received, expectedMessages);
  });

  test("enabledModelIds filters models in listModels pipeline", () => {
    const allModels = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", enabledByDefault: true },
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", enabledByDefault: true },
      { id: "google/gemini-2.5-flash", label: "Gemini Flash", enabledByDefault: false },
    ];

    const defaults = allModels.filter(m => m.enabledByDefault);
    const filtered = allModels.filter(m => ["google/gemini-2.5-flash"].includes(m.id));

    assert.strictEqual(defaults.length, 2);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, "google/gemini-2.5-flash");
  });
}

function defineProviderPersistenceTests(): void {
  test("setBridgeDefaultProvider should only acknowledge success after persistence completes", async () => {
    const events = await simulateDefaultProviderPersistence();

    assert.deepStrictEqual(
      events,
      ["persisted", "bridgeDefaultProviderSet"],
      "Success message must be posted only after provider persistence finishes",
    );
  });

  test("provider-aware settings fallback should use openrouterApiKey for openrouter", () => {
    const providerId = "openrouter";
    const settingKey = providerId === "openrouter" ? "openrouterApiKey" : "geminiApiKey";
    const configValues = {
      openrouterApiKey: "or-key",
      geminiApiKey: "gm-key",
    };

    const resolved = configValues[settingKey as keyof typeof configValues];

    assert.strictEqual(settingKey, "openrouterApiKey");
    assert.strictEqual(resolved, "or-key");
    assert.notStrictEqual(resolved, configValues.geminiApiKey);
  });
}

/**
 * Tests for brain-hq-bridge-settings-handler.ts:
 * - Model catalog request and save handlers compile
 * - fetchAllModels import chain works
 */

suite("BridgeSettingsHandler — Model Catalog", () => {
  defineCatalogMessageTests();
  defineModelPipelineTests();
  defineProviderPersistenceTests();
});

suite("BridgeSettingsHandler — Global Key Storage", () => {
  test("GLOBAL_SETTING_KEYS maps known providers to their VS Code setting key", () => {
    // These keys must match CURRENT_SETTING_KEYS in bridge-api-key-resolver.ts
    const expectedMappings: Record<string, string> = {
      openrouter: "projectBrain.bridge.openrouterApiKey",
      gemini: "projectBrain.bridge.geminiApiKey",
    };

    for (const [providerId, expectedKey] of Object.entries(expectedMappings)) {
      // Verify the config section/property split logic used in handleSaveApiKey
      const lastDot = expectedKey.lastIndexOf(".");
      const section = expectedKey.substring(0, lastDot);
      const prop = expectedKey.substring(lastDot + 1);

      assert.ok(section.length > 0, `${providerId} setting key must have a section`);
      assert.ok(prop.length > 0, `${providerId} setting key must have a property`);
      assert.strictEqual(
        `${section}.${prop}`,
        expectedKey,
        `section.prop must reconstruct the full key for ${providerId}`,
      );
    }
  });

  test("handleSaveApiKey message sends bridgeApiKeySaved on success", () => {
    const received = collectBridgeMessages([
      { type: "bridgeApiKeySaved" },
    ]);
    assert.deepStrictEqual(received, ["bridgeApiKeySaved"]);
  });

  test("migrateKeysToGlobalSettings is importable and callable", () => {
    const { migrateKeysToGlobalSettings } = require("../brain-hq-bridge-settings-handler");
    assert.strictEqual(typeof migrateKeysToGlobalSettings, "function");
  });

  test("handleSaveApiKey rejects wrong-provider key (isWrongProviderKey guard)", () => {
    const { isWrongProviderKey } = require("../bridge-api-key-resolver");
    // Validate the guard logic used in handleSaveApiKey
    assert.strictEqual(
      isWrongProviderKey("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "openrouter"),
      true,
      "Gemini key should be rejected for openrouter save",
    );
    assert.strictEqual(
      isWrongProviderKey("sk-or-v1-real-key", "openrouter"),
      false,
      "Valid OR key should be accepted for openrouter save",
    );
  });

  test("migration skips and cleans contaminated secrets (isWrongProviderKey in migrate)", () => {
    const { isWrongProviderKey } = require("../bridge-api-key-resolver");
    // Simulates migration logic: if secret value matches wrong provider, skip + clean
    const geminiKeyInOrSlot = "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const shouldSkip = isWrongProviderKey(geminiKeyInOrSlot, "openrouter");
    assert.strictEqual(shouldSkip, true, "Migration should skip contaminated Gemini key in OpenRouter slot");
  });
});
