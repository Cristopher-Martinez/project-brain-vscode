/**
 * subagent-start.test.mjs — Integration tests for the subagent-start hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - Handles agent_id and agent_type fields
 * - Handles minimal/empty input gracefully
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "subagent-start.mjs";

describe("subagent-start hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      agent_id: "test-agent-001",
      agent_type: "coder",
      sessionId: "test-session",
    });
    assertValidHookOutput(output, "subagent-start");
    assert.equal(output.continue, true);
  });

  it("includes hookSpecificOutput with additionalContext", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      agent_id: "test-agent-002",
      agent_type: "reviewer",
      sessionId: "test-session-2",
    });
    assert.ok(output.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.equal(
      typeof output.hookSpecificOutput.additionalContext,
      "string",
      "additionalContext should be a string",
    );
  });

  it("handles missing agent fields gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "subagent-start");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "subagent-start");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, {
      cwd: tmpDir,
      agent_id: "test-agent-003",
      agent_type: "coder",
    });
    assert.equal(exitCode, 0);
  });
});
