import * as assert from "assert";
import {
  getBridgeApiKeySettingKey,
  selectBridgeApiKeyResolution,
  isWrongProviderKey,
} from "../bridge-api-key-resolver";

function makeSettingInspection(
  key: string,
  values: { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string },
): { key: string; globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } {
  return { key, ...values };
}

suite("BridgeApiKeyResolver", () => {
  test("prefers direct key over every fallback", () => {
    const result = selectBridgeApiKeyResolution(
      " direct-key ",
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: "secret-key" }],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", { workspaceValue: "settings-key" })],
    );

    assert.strictEqual(result.apiKey, "direct-key");
    assert.strictEqual(result.source, "direct");
  });

  test("prefers secret storage over settings", () => {
    const result = selectBridgeApiKeyResolution(
      "",
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: "secret-key" }],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", { workspaceValue: "settings-key" })],
    );

    assert.strictEqual(result.apiKey, "secret-key");
    assert.strictEqual(result.source, "secret:projectBrain.bridge.openrouter.apiKey");
  });

  test("prefers workspace folder setting over broader scopes", () => {
    const result = selectBridgeApiKeyResolution(
      undefined,
      [],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", {
        globalValue: "global-key",
        workspaceValue: "workspace-key",
        workspaceFolderValue: "folder-key",
      })],
    );

    assert.strictEqual(result.apiKey, "folder-key");
    assert.strictEqual(
      result.source,
      "setting:projectBrain.bridge.openrouterApiKey:workspaceFolderValue",
    );
  });

  test("supports legacy setting keys when current key is absent", () => {
    const result = selectBridgeApiKeyResolution(
      undefined,
      [],
      [
        makeSettingInspection("projectBrain.bridge.openrouterApiKey", {}),
        makeSettingInspection("projectBrain.openrouterApiKey", { workspaceValue: "legacy-key" }),
      ],
    );

    assert.strictEqual(result.apiKey, "legacy-key");
    assert.strictEqual(
      result.source,
      "setting:projectBrain.openrouterApiKey:workspaceValue",
    );
    assert.strictEqual(getBridgeApiKeySettingKey("openrouter"), "projectBrain.bridge.openrouterApiKey");
  });

  test("falls back to global settings when no secret or workspace key exists", () => {
    const result = selectBridgeApiKeyResolution(
      undefined,
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: "" }],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", {
        globalValue: "global-or-key",
      })],
    );

    assert.strictEqual(result.apiKey, "global-or-key");
    assert.strictEqual(
      result.source,
      "setting:projectBrain.bridge.openrouterApiKey:globalValue",
    );
  });

  test("returns empty when no source has a key", () => {
    const result = selectBridgeApiKeyResolution(
      undefined,
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: "" }],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", {})],
    );

    assert.strictEqual(result.apiKey, "");
    assert.strictEqual(result.source, "missing");
    assert.ok(result.checkedSources.length > 0, "should have checked at least one source");
  });

  test("checkedSources tracks all attempted sources in order", () => {
    const result = selectBridgeApiKeyResolution(
      "",
      [
        { key: "secretA", value: "" },
        { key: "secretB", value: "" },
      ],
      [makeSettingInspection("settingA", {})],
    );

    assert.ok(result.checkedSources.includes("secret:secretA"));
    assert.ok(result.checkedSources.includes("secret:secretB"));
    assert.ok(result.checkedSources.includes("setting:settingA:globalValue"));
  });

  test("skips Gemini-like key when resolving for openrouter", () => {
    const geminiKey = "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = selectBridgeApiKeyResolution(
      undefined,
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: geminiKey }],
      [makeSettingInspection("projectBrain.bridge.openrouterApiKey", { globalValue: geminiKey })],
      "openrouter",
    );

    assert.strictEqual(result.apiKey, "", "Should skip Gemini key for openrouter");
    assert.strictEqual(result.source, "missing");
    assert.ok(
      result.checkedSources.some(s => s.includes("wrong-provider")),
      "Should annotate skipped sources",
    );
  });

  test("does NOT skip Gemini-like key when resolving for gemini", () => {
    const geminiKey = "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const result = selectBridgeApiKeyResolution(
      undefined,
      [{ key: "projectBrain.bridge.gemini.apiKey", value: geminiKey }],
      [],
      "gemini",
    );

    assert.strictEqual(result.apiKey, geminiKey, "Should accept Gemini key for gemini");
  });

  test("does NOT skip OpenRouter key when resolving for openrouter", () => {
    const orKey = "sk-or-testing-key-value-123456789";
    const result = selectBridgeApiKeyResolution(
      undefined,
      [{ key: "projectBrain.bridge.openrouter.apiKey", value: orKey }],
      [],
      "openrouter",
    );

    assert.strictEqual(result.apiKey, orKey, "Should accept OpenRouter key for openrouter");
  });
});

suite("isWrongProviderKey", () => {
  test("detects Gemini key used for openrouter", () => {
    assert.strictEqual(isWrongProviderKey("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "openrouter"), true);
  });

  test("accepts Gemini key for gemini", () => {
    assert.strictEqual(isWrongProviderKey("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "gemini"), false);
  });

  test("detects OpenRouter key used for gemini", () => {
    assert.strictEqual(isWrongProviderKey("sk-or-v1-abc123", "gemini"), true);
  });

  test("accepts OpenRouter key for openrouter", () => {
    assert.strictEqual(isWrongProviderKey("sk-or-v1-abc123", "openrouter"), false);
  });

  test("returns false when no providerId", () => {
    assert.strictEqual(isWrongProviderKey("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
  });
});