/**
 * subagent-stop.test.mjs — Integration tests for the subagent-stop hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - Handles stop_hook_active field
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

const HOOK = "subagent-stop.mjs";

describe("subagent-stop hook", () => {
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
    assertValidHookOutput(output, "subagent-stop");
    assert.equal(output.continue, true);
  });

  it("handles stop_hook_active flag", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      agent_id: "test-agent-002",
      agent_type: "reviewer",
      sessionId: "test-session-2",
      stop_hook_active: true,
    });
    assertValidHookOutput(output, "subagent-stop");
    assert.equal(output.continue, true);
  });

  it("handles missing agent fields gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "subagent-stop");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "subagent-stop");
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
