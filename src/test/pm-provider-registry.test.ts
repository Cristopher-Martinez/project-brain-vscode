import * as assert from "assert";

type ProviderConfig = {
  providerId: string;
  apiKeyRef: string;
  enabled: boolean;
  enabledModelIds: string[];
};

/**
 * Tests for pm-provider-registry.ts:
 * - getDefaultModelForProvider returns correct model format per provider
 * - getDefaultProviderId / setDefaultProvider round-trip
 */

suite("PM Provider Registry", () => {
  suite("getDefaultModelForProvider", () => {
    test("returns google/-prefixed model for openrouter", () => {
      const { getDefaultModelForProvider } = require("../pm-provider-registry");
      assert.strictEqual(getDefaultModelForProvider("openrouter"), "google/gemini-2.5-flash");
    });

    test("returns native model ID for gemini", () => {
      const { getDefaultModelForProvider } = require("../pm-provider-registry");
      assert.strictEqual(getDefaultModelForProvider("gemini"), "gemini-2.5-flash");
    });

    test("returns gemini fallback for unknown provider", () => {
      const { getDefaultModelForProvider } = require("../pm-provider-registry");
      assert.strictEqual(getDefaultModelForProvider("some-unknown"), "gemini-2.5-flash");
    });
  });

  suite("getDefaultProviderId", () => {
    test("returns a string or null", () => {
      const { getDefaultProviderId } = require("../pm-provider-registry");
      const result = getDefaultProviderId();
      assert.ok(result === null || typeof result === "string");
    });
  });

  suite("fetchAllModels", () => {
    test("falls back to listModels when fetchAllModels not implemented", () => {
      const { registerStrategy, fetchAllModels, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      registerStrategy({
        providerId: "test",
        label: "Test",
        validateConfig: async () => ({ valid: true }),
        listModels: async () => [{ id: "m1", label: "Model 1" }],
        createClient: async () => ({ send: async () => ({ text: "" }) }),
        buildRequest: async () => ({ model: "", messages: [] }),
        parseResponse: () => ({ id: "", type: "suggest", content: "" }),
      });

      return fetchAllModels("test", { providerId: "test", apiKeyRef: "", enabled: true, enabledModelIds: [] })
        .then((models: any[]) => {
          assert.strictEqual(models.length, 1);
          assert.strictEqual(models[0].id, "m1");
          clearRegistry();
        });
    });

    test("returns empty for unknown provider", () => {
      const { fetchAllModels, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      return fetchAllModels("unknown", { providerId: "unknown", apiKeyRef: "", enabled: true, enabledModelIds: [] })
        .then((models: any[]) => {
          assert.strictEqual(models.length, 0);
        });
    });
  });

  suite("createClient", () => {
    test("rethrows provider creation failures instead of returning null", async () => {
      const { registerStrategy, createClient, clearRegistry } = require("../pm-provider-registry");
      clearRegistry();
      registerStrategy({
        providerId: "test",
        label: "Test",
        validateConfig: async () => ({ valid: true }),
        listModels: async () => [{ id: "m1", label: "Model 1" }],
        createClient: async () => {
          throw new Error("boom");
        },
        buildRequest: async () => ({ model: "", messages: [] }),
        parseResponse: () => ({ id: "", type: "suggest", content: "" }),
      });

      try {
        await assert.rejects(
          () => createClient("test", {
            providerId: "test",
            apiKeyRef: "",
            enabled: true,
            enabledModelIds: [],
          } satisfies ProviderConfig),
          /boom/,
        );
      } finally {
        clearRegistry();
      }
    });
  });
});
