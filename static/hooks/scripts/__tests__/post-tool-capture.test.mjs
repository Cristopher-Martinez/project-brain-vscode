/**
 * post-tool-capture.test.mjs — Integration tests for the post-tool-capture hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - Handles own-tool calls (projectBrain_*)
 * - Handles external tool calls
 * - Handles missing tool_name/tool_input gracefully
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "post-tool-capture.mjs";

describe("post-tool-capture hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true for external tool", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/some/file.ts" },
    });
    assertValidHookOutput(output, "post-tool-capture");
    assert.equal(output.continue, true);
  });

  it("returns valid JSON for projectBrain tool call", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "projectBrain_searchMemory",
      tool_input: { query: "test" },
      toolName: "projectBrain_searchMemory",
      toolInput: { query: "test" },
    });
    assertValidHookOutput(output, "post-tool-capture");
    assert.equal(output.continue, true);
  });

  it("handles missing tool fields gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "post-tool-capture");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "post-tool-capture");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "run_in_terminal",
      tool_input: { command: "npm test" },
    });
    assert.equal(exitCode, 0);
  });
});
