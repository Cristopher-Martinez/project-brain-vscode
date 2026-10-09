/**
 * session-start.test.mjs — Integration tests for the session-start hook.
 *
 * Verifies:
 * - Valid JSON output with { continue: true }
 * - hookSpecificOutput contains additionalContext (string)
 * - Handles minimal input (just cwd)
 * - Handles missing cwd gracefully
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "session-start.mjs";

describe("session-start hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "session-start");
    assert.equal(output.continue, true);
  });

  it("includes hookSpecificOutput with additionalContext", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assert.ok(output.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.equal(
      typeof output.hookSpecificOutput.additionalContext,
      "string",
      "additionalContext should be a string",
    );
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, { cwd: tmpDir });
    assert.equal(exitCode, 0);
  });

  it("handles empty input gracefully (no crash)", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "session-start");
    assert.equal(output.continue, true);
  });
});
