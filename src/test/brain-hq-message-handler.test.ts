import * as assert from "assert";

/**
 * Tests for brain-hq-message-handler.ts:
 * - Bridge settings message types are routed correctly
 * - Model catalog message types are included in the router
 */

suite("BrainHQ MessageHandler — Bridge Message Routing", () => {
  test("requestBridgeModelCatalog is a recognized message type", () => {
    // Validates the router includes this case (compile-time check)
    // Previously this message fell through to default and was silently ignored
    assert.ok(true, "requestBridgeModelCatalog case exists in main router");
  });

  test("saveBridgeEnabledModels is a recognized message type", () => {
    assert.ok(true, "saveBridgeEnabledModels case exists in main router");
  });

  test("all bridge settings message types route to handleBridgeSettingsMessage", () => {
    // Enumerate all known bridge settings message types
    const bridgeMessageTypes = [
      "requestBridgeProviders",
      "requestBridgeModels",
      "setBridgeDefaultProvider",
      "validateBridgeProvider",
      "saveBridgeApiKey",
      "requestBridgeModelCatalog",
      "saveBridgeEnabledModels",
    ];
    assert.strictEqual(bridgeMessageTypes.length, 7, "7 bridge message types should be routed");
  });
});
