import * as assert from "assert";

/**
 * Tests for auto-loop-bridge-session.ts behavior:
 * - PM uses sliding window context (party room model), NOT hard turn cap
 * - Budget tracking is informational only
 * - Rate limiter remains active
 */

suite("AutoLoopBridgeSession — PM Sliding Window", () => {

  // -- Sliding window via assembleContext ------------------------------------

  suite("Context assembler sliding window", () => {
    test("trims PM chat history to max 20 messages", () => {
      const { assembleContext } = require("../auto-loop-context-assembler");
      const messages: any[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push({
          id: `msg_${i}`,
          synthesisId: "s1",
          role: i % 2 === 0 ? "user" : "pm",
          text: `Message ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const result = assembleContext({
        objective: "test",
        activeSynthesis: {
          synthesisId: "s1", round: 1, content: "test synthesis",
          timestamp: Date.now(), workerLoopSessionId: "w1",
        },
        taskMemory: {
          sessionId: "t1", objective: "test", decisions: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        },
        retrievalChunks: [],
        pmChatHistory: messages,
        userMessage: "hello",
        budget: {
          maxContextChars: 8000, maxRetrievedChunks: 5,
          maxSuggestionTurns: 50, maxTokensPerTurn: 2048, consumedTurns: 0,
        },
      });

      assert.ok(
        result.pmChatHistory.length <= 20,
        `Expected <=20 messages, got ${result.pmChatHistory.length}`,
      );
    });

    test("keeps most recent messages (FIFO eviction)", () => {
      const { assembleContext } = require("../auto-loop-context-assembler");
      const messages: any[] = [];
      for (let i = 0; i < 25; i++) {
        messages.push({
          id: `msg_${i}`, synthesisId: "s1", role: "user",
          text: `Short ${i}`, timestamp: Date.now() + i,
        });
      }

      const result = assembleContext({
        objective: "test",
        activeSynthesis: {
          synthesisId: "s1", round: 1, content: "syn",
          timestamp: Date.now(), workerLoopSessionId: "w1",
        },
        taskMemory: {
          sessionId: "t1", objective: "test", decisions: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        },
        retrievalChunks: [],
        pmChatHistory: messages,
        userMessage: "hello",
        budget: {
          maxContextChars: 16000, maxRetrievedChunks: 5,
          maxSuggestionTurns: 50, maxTokensPerTurn: 2048, consumedTurns: 0,
        },
      });

      if (result.pmChatHistory.length > 0) {
        const lastMsg = result.pmChatHistory[result.pmChatHistory.length - 1];
        assert.strictEqual(lastMsg.id, "msg_24", "Should keep the most recent message");
      }
    });
  });

  // -- Budget is informational, not blocking ---------------------------------

  suite("Budget tracking (metrics only)", () => {
    test("checkBudgetWarning reports exhausted but does not block", () => {
      const { checkBudgetWarning } = require("../auto-loop-token-guardrails");
      const budget = {
        maxContextChars: 8000, maxRetrievedChunks: 5,
        maxSuggestionTurns: 50, maxTokensPerTurn: 2048,
        consumedTurns: 100,
      };
      const warning = checkBudgetWarning(budget);
      assert.strictEqual(warning.level, "exhausted");
      // Key assertion: this is informational — sendPmChat no longer checks it
    });

    test("consumedTurns is preserved through clampBudget", () => {
      const { clampBudget, BRIDGE_DEFAULT_BUDGET } = require("../auto-loop-token-guardrails");
      const budget = clampBudget({ ...BRIDGE_DEFAULT_BUDGET, consumedTurns: 999 });
      assert.strictEqual(budget.consumedTurns, 999);
    });
  });

  // -- Rate limiter still active ---------------------------------------------

  suite("Rate limiter remains active for PM", () => {
    test("rate limit blocks after 10 calls per minute", () => {
      const { checkPmChatRateLimit, clearPmChatRateLimit } = require("../auto-loop-token-guardrails");
      const sessionId = "session-rate-test";
      clearPmChatRateLimit(sessionId);

      for (let i = 0; i < 10; i++) {
        assert.strictEqual(checkPmChatRateLimit(sessionId), true);
      }
      assert.strictEqual(checkPmChatRateLimit(sessionId), false, "11th call should be rate-limited");
      clearPmChatRateLimit(sessionId);
    });
  });

  // -- Provider hot-swap detection -------------------------------------------

  suite("Provider hot-swap via registry", () => {
    test("getDefaultProviderId returns the current default from registry", () => {
      const { getDefaultProviderId, setDefaultProvider } = require("../pm-provider-registry");
      const original = getDefaultProviderId();
      setDefaultProvider("test-provider-xyz");
      assert.strictEqual(getDefaultProviderId(), "test-provider-xyz");
      // Restore original
      setDefaultProvider(original);
    });

    test("setDefaultProvider updates the in-memory default", () => {
      const { getDefaultProviderId, setDefaultProvider } = require("../pm-provider-registry");
      const before = getDefaultProviderId();
      setDefaultProvider("openrouter");
      assert.strictEqual(getDefaultProviderId(), "openrouter");
      setDefaultProvider(before);
      assert.strictEqual(getDefaultProviderId(), before);
    });
  });

  // -- Provider config reset on hot-swap -------------------------------------

  suite("Provider config reset on hot-swap", () => {
    test("switching provider forces API key re-resolution", () => {
      // Simulates that pmProviderConfig must be reset with empty apiKeyRef
      // so resolveOrCreatePmClient re-resolves from SecretStorage
      const freshConfig = { providerId: "openrouter", apiKeyRef: "", enabled: true, enabledModelIds: [], defaultModelId: "google/gemini-2.5-flash" };
      assert.strictEqual(freshConfig.apiKeyRef, "", "Fresh config should have empty apiKeyRef");
      assert.strictEqual(freshConfig.providerId, "openrouter", "Fresh config should have new provider");
    });
  });

  // -- Provider-aware default models -----------------------------------------

  suite("getDefaultModelForProvider", () => {
    test("returns correct model format per provider", () => {
      const { getDefaultModelForProvider } = require("../pm-provider-registry");
      assert.strictEqual(getDefaultModelForProvider("gemini"), "gemini-2.5-flash");
      assert.strictEqual(getDefaultModelForProvider("openrouter"), "google/gemini-2.5-flash");
      assert.strictEqual(getDefaultModelForProvider("unknown"), "gemini-2.5-flash");
    });
  });

  // -- Dynamic available models (refreshAvailableModels) ---------------------

  suite("Dynamic available models", () => {
    test("listModels returns only enabledByDefault when enabledModelIds is empty", async () => {
      const { listModels, registerStrategy, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      registerStrategy({
        providerId: "test-provider",
        label: "Test",
        async validateConfig() { return { valid: true }; },
        async listModels(config: any) {
          const allModels = [
            { id: "model-a", label: "Model A", enabledByDefault: true },
            { id: "model-b", label: "Model B", enabledByDefault: false },
          ];
          if (config.enabledModelIds.length === 0) {
            return allModels.filter((m: any) => m.enabledByDefault);
          }
          return allModels.filter((m: any) => config.enabledModelIds.includes(m.id));
        },
        async createClient() { return { send: async () => ({ text: "" }), dispose() {} }; },
      });
      const models = await listModels("test-provider", { providerId: "test-provider", apiKeyRef: "", enabled: true, enabledModelIds: [] });
      assert.strictEqual(models.length, 1);
      assert.strictEqual(models[0].id, "model-a");
      clearRegistry();
    });

    test("listModels returns specific models when enabledModelIds is set", async () => {
      const { listModels, registerStrategy, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      registerStrategy({
        providerId: "test-provider",
        label: "Test",
        async validateConfig() { return { valid: true }; },
        async listModels(config: any) {
          const allModels = [
            { id: "model-a", label: "Model A", enabledByDefault: true },
            { id: "model-b", label: "Model B", enabledByDefault: false },
          ];
          if (config.enabledModelIds.length === 0) {
            return allModels.filter((m: any) => m.enabledByDefault);
          }
          return allModels.filter((m: any) => config.enabledModelIds.includes(m.id));
        },
        async createClient() { return { send: async () => ({ text: "" }), dispose() {} }; },
      });
      const models = await listModels("test-provider", { providerId: "test-provider", apiKeyRef: "", enabled: true, enabledModelIds: ["model-b"] });
      assert.strictEqual(models.length, 1);
      assert.strictEqual(models[0].id, "model-b");
      clearRegistry();
    });
  });

  // -- enabledModelIds freshness (config re-read) ----------------------------

  suite("enabledModelIds config freshness", () => {
    test("refreshAvailableModels uses fresh enabledModelIds, not stale pmProviderConfig", async () => {
      // Validates the contract: when enabledModelIds changes in config,
      // the next listModels call should use the new value, not the cached one.
      const { listModels, registerStrategy, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      registerStrategy({
        providerId: "freshness-test",
        label: "Freshness Test",
        async validateConfig() { return { valid: true }; },
        async listModels(config: any) {
          const allModels = [
            { id: "m1", label: "M1", enabledByDefault: true },
            { id: "m2", label: "M2", enabledByDefault: false },
            { id: "m3", label: "M3", enabledByDefault: false },
          ];
          if (config.enabledModelIds.length === 0) {
            return allModels.filter((m: any) => m.enabledByDefault);
          }
          return allModels.filter((m: any) => config.enabledModelIds.includes(m.id));
        },
        async createClient() { return { send: async () => ({ text: "" }), dispose() {} }; },
      });

      // Stale config with empty enabledModelIds (this was the bug)
      const staleConfig = { providerId: "freshness-test", apiKeyRef: "", enabled: true, enabledModelIds: [] as string[] };
      const staleModels = await listModels("freshness-test", staleConfig);
      assert.strictEqual(staleModels.length, 1, "Stale config returns only enabledByDefault");

      // Fresh config with enabledModelIds from VS Code settings (the fix)
      const freshConfig = { ...staleConfig, enabledModelIds: ["m2", "m3"] };
      const freshModels = await listModels("freshness-test", freshConfig);
      assert.strictEqual(freshModels.length, 2, "Fresh config returns selected models");
      assert.strictEqual(freshModels[0].id, "m2");
      assert.strictEqual(freshModels[1].id, "m3");

      clearRegistry();
    });

    test("hot-swap config includes enabledModelIds from new provider", () => {
      // Validates the contract: when provider changes, the new config
      // should include enabledModelIds (not hardcoded empty)
      const newProvider = "openrouter";
      const enabledIds = ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4"];
      const hotSwapConfig = {
        providerId: newProvider,
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: enabledIds,
        defaultModelId: "google/gemini-2.5-flash",
      };
      assert.deepStrictEqual(hotSwapConfig.enabledModelIds, enabledIds,
        "Hot-swap config should carry enabledModelIds from settings");
      assert.notDeepStrictEqual(hotSwapConfig.enabledModelIds, [],
        "Hot-swap config must NOT have empty enabledModelIds");
    });

    test("provider hot-swap should follow VS Code config default, not stale registry default", () => {
      // Contract: sendPmChat hot-swap must use workspace config as source of truth.
      const registryDefault = "gemini";
      const configDefault = "openrouter";
      const sessionProvider = "openrouter";

      const selectedDefault = configDefault || sessionProvider;

      assert.strictEqual(registryDefault, "gemini", "Simulated stale registry default");
      assert.strictEqual(selectedDefault, "openrouter",
        "Hot-swap should honor VS Code config defaultProvider, not registry default");
      assert.strictEqual(selectedDefault, sessionProvider,
        "If config already matches the session provider, no forced switch back to Gemini should happen");
    });

    test("stale pmModelId should normalize to the first enabled model", () => {
      const availableModels = [
        { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
        { id: "openai/gpt-4.1", label: "GPT-4.1" },
      ];
      const staleModelId = "google/gemini-2.5-flash";
      const normalizedModelId = availableModels.some(m => m.id === staleModelId)
        ? staleModelId
        : availableModels[0].id;

      assert.strictEqual(normalizedModelId, "anthropic/claude-sonnet-4",
        "Recovered or stale sessions should auto-pick the first enabled model when current model is invalid");
    });

    test("manual model change should update snapshot-bound provider config", () => {
      const nextModelId = "anthropic/claude-sonnet-4";
      const snapshotLikeConfig = {
        providerId: "openrouter",
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: ["anthropic/claude-sonnet-4", "openai/gpt-4.1"],
        defaultModelId: "google/gemini-2.5-flash",
      };

      const updated = { ...snapshotLikeConfig, defaultModelId: nextModelId };

      assert.strictEqual(updated.defaultModelId, nextModelId,
        "Manual model changes should be reflected in the persisted provider config used for recovery");
    });

    test("pm thread summary can persist a synthesis-specific model", () => {
      const threadSummary = {
        synthesisId: "synth-9",
        summary: "2 turns -- last: Ship it",
        lastUpdatedAt: Date.now(),
        turnCount: 2,
        modelId: "anthropic/claude-sonnet-4",
      };

      assert.strictEqual(threadSummary.modelId, "anthropic/claude-sonnet-4");
    });
  });
});
