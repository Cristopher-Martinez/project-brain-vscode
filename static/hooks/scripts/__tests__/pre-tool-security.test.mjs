/**
 * pre-tool-security.test.mjs — Integration tests for the pre-tool-security hook.
 *
 * Verifies:
 * - Valid JSON output for known safe tools
 * - Valid JSON output for unknown tools
 * - Handles missing tool_name/tool_input gracefully
 * - Security pipeline produces additionalContext
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "pre-tool-security.mjs";

describe("pre-tool-security hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true for a safe tool", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/some/file.ts", oldString: "a", newString: "b" },
    });
    assertValidHookOutput(output, "pre-tool-security");
    assert.equal(output.continue, true);
  });

  it("returns valid JSON for an unknown tool", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "unknown_tool_xyz",
      tool_input: {},
    });
    assertValidHookOutput(output, "pre-tool-security");
    assert.equal(output.continue, true);
  });

  it("handles missing tool_name gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "pre-tool-security");
    assert.equal(output.continue, true);
  });

  it("handles empty input gracefully", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "pre-tool-security");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "run_in_terminal",
      tool_input: { command: "echo hello" },
    });
    assert.equal(exitCode, 0);
  });
});

// ——— Block reason lifecycle tests ———
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

describe("block reason lifecycle", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  function blockReasonPath() {
    return join(tmpDir, ".project-brain", "loops", "last-tool-block.json");
  }

  function writeBlockReason(data) {
    const dir = join(tmpDir, ".project-brain", "loops");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(blockReasonPath(), JSON.stringify(data), "utf8");
  }

  it("injects previous block reason into additionalContext", async () => {
    writeBlockReason({
      tool: "run_in_terminal",
      reason: "Destructive command detected",
      timestamp: Date.now(),
    });

    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    assertValidHookOutput(output, "pre-tool-security");
    const ctx = output.hookSpecificOutput?.additionalContext || "";
    assert.ok(
      ctx.includes("PREVIOUS TOOL BLOCKED"),
      `Expected block reason in context, got: ${ctx.slice(0, 200)}`,
    );
    assert.ok(ctx.includes("Destructive command detected"));
  });

  it("deletes block reason file after consumption (one-shot)", async () => {
    writeBlockReason({
      tool: "some_tool",
      reason: "Test reason",
      timestamp: Date.now(),
    });

    assert.ok(
      existsSync(blockReasonPath()),
      "Block file should exist before consumption",
    );

    await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    assert.ok(
      !existsSync(blockReasonPath()),
      "Block file should be deleted after consumption",
    );
  });

  it("does not inject block reason on second call (file already consumed)", async () => {
    writeBlockReason({
      tool: "dangerous_tool",
      reason: "Blocked for test",
      timestamp: Date.now(),
    });

    // First call consumes it
    await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    // Second call should NOT have block reason
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    const ctx = output.hookSpecificOutput?.additionalContext || "";
    assert.ok(
      !ctx.includes("PREVIOUS TOOL BLOCKED"),
      `Block reason should not persist after consumption, got: ${ctx.slice(0, 200)}`,
    );
  });

  it("ignores expired block reasons (TTL > 5 min)", async () => {
    writeBlockReason({
      tool: "expired_tool",
      reason: "Old reason",
      timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    });

    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    const ctx = output.hookSpecificOutput?.additionalContext || "";
    assert.ok(
      !ctx.includes("PREVIOUS TOOL BLOCKED"),
      `Expired block reason should be ignored, got: ${ctx.slice(0, 200)}`,
    );
    // Expired file should also be cleaned up
    assert.ok(
      !existsSync(blockReasonPath()),
      "Expired block file should be deleted during cleanup",
    );
  });

  it("handles missing block file gracefully", async () => {
    // Ensure no block file exists
    if (existsSync(blockReasonPath())) unlinkSync(blockReasonPath());

    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: { filePath: "/f.ts", oldString: "a", newString: "b" },
    });

    assertValidHookOutput(output, "pre-tool-security");
    assert.equal(output.continue, true);
  });
});
