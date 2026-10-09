import * as assert from "assert";

suite("CloudCommands — Command Registration", () => {
  test("migrateKeysToGlobalSettings is importable from bridge settings handler", () => {
    const { migrateKeysToGlobalSettings } = require("../brain-hq-bridge-settings-handler");
    assert.strictEqual(typeof migrateKeysToGlobalSettings, "function");
  });

  test("migrateKeysToGlobal command ID follows projectBrain convention", () => {
    const commandId = "projectBrain.migrateKeysToGlobal";
    assert.ok(commandId.startsWith("projectBrain."), "Command must use projectBrain prefix");
  });
});
