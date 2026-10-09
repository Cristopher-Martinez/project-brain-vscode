/**
 * pre-compact.test.mjs — Integration tests for the pre-compact hook.
 *
 * Verifies:
 * - Valid JSON output with continue: true
 * - hookSpecificOutput shape
 * - Handles missing transcript_path gracefully
 * - Handles empty input gracefully
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertValidHookOutput,
  createTempWorkspace,
  runHook,
} from "./test-helper.mjs";

const HOOK = "pre-compact.mjs";

describe("pre-compact hook", () => {
  let tmpDir, cleanup;

  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());
  });

  after(() => cleanup());

  it("returns valid JSON with continue: true", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "pre-compact");
    assert.equal(output.continue, true);
  });

  it("handles transcript_path pointing to a real file", async () => {
    const transcriptFile = join(tmpDir, "transcript.md");
    writeFileSync(transcriptFile, "User: hello\nAssistant: hi\n".repeat(50));
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      transcript_path: transcriptFile,
    });
    assertValidHookOutput(output, "pre-compact");
    assert.equal(output.continue, true);
  });

  it("handles missing transcript_path gracefully", async () => {
    const { output } = await runHook(HOOK, { cwd: tmpDir });
    assertValidHookOutput(output, "pre-compact");
    assert.equal(output.continue, true);
  });

  it("handles empty input without crash", async () => {
    const { output } = await runHook(HOOK, {});
    assertValidHookOutput(output, "pre-compact");
    assert.equal(output.continue, true);
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runHook(HOOK, { cwd: tmpDir });
    assert.equal(exitCode, 0);
  });
});
