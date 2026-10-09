/**
 * session-stop.test.mjs — Integration tests for the session-stop hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - hookSpecificOutput shape
 * - Handles stop_hook_active flag
 * - Handles nextSteps and taskContext fields
 * - Handles empty input gracefully
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "session-stop.mjs";

describe("session-stop hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      stop_hook_active: false,
    });
    assertValidHookOutput(output, "session-stop");
    assert.equal(output.continue, true);
  });

  it("handles stop_hook_active flag", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      stop_hook_active: true,
    });
    assertValidHookOutput(output, "session-stop");
    assert.equal(output.continue, true);
  });

  it("handles nextSteps and taskContext fields", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      nextSteps: "Continue with testing",
      taskContext: "Refactoring hooks",
    });
    assertValidHookOutput(output, "session-stop");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "session-stop");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, { cwd: tmpDir });
    assert.equal(exitCode, 0);
  });
});
