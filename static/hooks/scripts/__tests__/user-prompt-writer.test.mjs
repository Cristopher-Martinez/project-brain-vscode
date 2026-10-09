/**
 * user-prompt-writer.test.mjs — Integration tests for the user-prompt-writer hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - hookSpecificOutput shape
 * - Handles prompt field
 * - Short prompts get early return
 * - Handles empty input gracefully
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "user-prompt-writer.mjs";

describe("user-prompt-writer hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true for normal prompt", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      prompt:
        "I want to refactor the session manager to use dependency injection",
    });
    assertValidHookOutput(output, "user-prompt-writer");
    assert.equal(output.continue, true);
  });

  it("handles short prompt (< 5 chars) gracefully", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      prompt: "hi",
    });
    assertValidHookOutput(output, "user-prompt-writer");
    assert.equal(output.continue, true);
  });

  it("handles missing prompt gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "user-prompt-writer");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "user-prompt-writer");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, {
      cwd: tmpDir,
      prompt: "What is the architecture of this project?",
    });
    assert.equal(exitCode, 0);
  });
});
