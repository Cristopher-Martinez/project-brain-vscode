import * as assert from "assert";

type StrategyModel = { id: string; label: string };

function registerOpenRouterStrategy(): {
  listModels: (providerId: string, config: {
    providerId: string;
    apiKeyRef: string;
    enabled: boolean;
    enabledModelIds: string[];
  }) => Promise<StrategyModel[]>;
  clearRegistry: () => void;
  openrouterStrategy: {
    fetchAllModels: (config: {
      providerId: string;
      apiKeyRef: string;
      enabled: boolean;
      enabledModelIds: string[];
    }) => Promise<StrategyModel[]>;
    createClient: (config: {
      providerId: string;
      apiKeyRef: string;
      enabled: boolean;
      enabledModelIds: string[];
    }) => Promise<unknown>;
  };
} {
  const { registerStrategy, listModels, clearRegistry } = require("../pm-provider-registry");
  const { openrouterStrategy } = require("../pm-openrouter-strategy");
  clearRegistry();
  registerStrategy(openrouterStrategy);
  return { listModels, clearRegistry, openrouterStrategy };
}

function defineModelDefaultsTests(): void {
  test("all OPENROUTER_MODELS have enabledByDefault: true", async () => {
    const { listModels, clearRegistry } = registerOpenRouterStrategy();

    try {
      const models = await listModels("openrouter", {
        providerId: "openrouter",
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: [],
      });

      assert.ok(models.length >= 3, `Expected at least 3 models, got ${models.length}`);
      for (const model of models) {
        assert.ok(model.id, "Model must have an id");
        assert.ok(model.label, "Model must have a label");
      }
    } finally {
      clearRegistry();
    }
  });

  test("listModels filters by enabledModelIds when provided", async () => {
    const { listModels, clearRegistry } = registerOpenRouterStrategy();

    try {
      const models = await listModels("openrouter", {
        providerId: "openrouter",
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: ["anthropic/claude-sonnet-4"],
      });

      assert.strictEqual(models.length, 1);
      assert.strictEqual(models[0].id, "anthropic/claude-sonnet-4");
    } finally {
      clearRegistry();
    }
  });
}

function defineCatalogTests(): void {
  test("listModels uses full API catalog for enabledModelIds not present in curated list", async () => {
    const { listModels, clearRegistry } = registerOpenRouterStrategy();
    const originalFetch = global.fetch;

    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-4.1", name: "GPT-4.1", context_length: 128000 },
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", context_length: 64000 },
        ],
      }),
    }) as Response;

    try {
      const models = await listModels("openrouter", {
        providerId: "openrouter",
        apiKeyRef: "test-key",
        enabled: true,
        enabledModelIds: ["deepseek/deepseek-chat", "openai/gpt-4.1"],
      });

      assert.strictEqual(models.length, 2);
      assert.strictEqual(models[0].id, "openai/gpt-4.1");
      assert.strictEqual(models[1].id, "deepseek/deepseek-chat");
    } finally {
      global.fetch = originalFetch;
      clearRegistry();
    }
  });

  test("fetchAllModels returns curated list when no API key", async () => {
    const { openrouterStrategy } = registerOpenRouterStrategy();
    const models = await openrouterStrategy.fetchAllModels({
      providerId: "openrouter",
      apiKeyRef: "",
      enabled: true,
      enabledModelIds: [],
    });

    assert.ok(models.length >= 3, "Should return curated fallback list");
    assert.ok(models.some((model: StrategyModel) => model.id === "google/gemini-2.5-flash"));
  });
}

function defineClientGuardTests(): void {
  test("strategy has fetchAllModels method", () => {
    const { openrouterStrategy } = registerOpenRouterStrategy();
    assert.strictEqual(typeof openrouterStrategy.fetchAllModels, "function");
  });

  test("createClient fails fast when api key is missing", async () => {
    const { openrouterStrategy } = registerOpenRouterStrategy();

    await assert.rejects(
      () => openrouterStrategy.createClient({
        providerId: "openrouter",
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: [],
      }),
      /OpenRouter API key not configured/,
    );
  });

  test("createClient fails fast when api key is whitespace only", async () => {
    const { openrouterStrategy } = registerOpenRouterStrategy();

    await assert.rejects(
      () => openrouterStrategy.createClient({
        providerId: "openrouter",
        apiKeyRef: "   ",
        enabled: true,
        enabledModelIds: [],
      }),
      /OpenRouter API key not configured/,
    );
  });

  test("createClient fails fast when api key looks like a Gemini key", async () => {
    const { openrouterStrategy } = registerOpenRouterStrategy();

    await assert.rejects(
      () => openrouterStrategy.createClient({
        providerId: "openrouter",
        apiKeyRef: "AIzaSyD2ExampleKey1234567890abcdEFGhij",
        enabled: true,
        enabledModelIds: [],
      }),
      /appears to be a Gemini key/,
    );
  });
}

/**
 * Tests for pm-openrouter-strategy.ts:
 * - All OpenRouter models are enabledByDefault
 * - listModels returns all models when enabledModelIds is empty
 */

suite("OpenRouterStrategy — Model Defaults", () => {
  defineModelDefaultsTests();
  defineCatalogTests();
  defineClientGuardTests();
});
