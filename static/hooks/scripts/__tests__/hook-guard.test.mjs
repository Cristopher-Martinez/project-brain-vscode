/**
 * hook-guard.test.mjs — Tests for the guardedHook wrapper itself.
 *
 * Verifies:
 * - Valid JSON output on success
 * - Crash recovery with error injection
 * - Health file recording
 * - Malformed stdin handling
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Creates a temporary hook script that uses guardedHook.
 * @param {string} dir — directory to write the script
 * @param {string} body — JS code inside the guardedHook callback
 * @returns {string} — path to the created script
 */
function createTestHook(dir, body, hookName = "test-hook") {
  const guardAbsPath = resolve(__dirname, "..", "lib", "hook-guard.mjs");
  const guardUrl = pathToFileURL(guardAbsPath).href;
  const script = `
import { guardedHook } from "${guardUrl}";
guardedHook("${hookName}", async (input) => {
  ${body}
});
`;
  const scriptPath = join(dir, `test-hook-${Date.now()}.mjs`);
  writeFileSync(scriptPath, script);
  return scriptPath;
}

function runScript(scriptPath, input = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      { timeout: timeoutMs, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          return reject(new Error("Timeout"));
        }
        let output = null;
        if (stdout.trim()) {
          try {
            output = JSON.parse(stdout.trim());
          } catch {
            output = stdout.trim();
          }
        }
        resolve({ output, stderr, exitCode: error ? error.code || 1 : 0 });
      },
    );
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

describe("guardedHook", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "guard-test-"));
    mkdirSync(join(tmpDir, ".project-brain", "loops"), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the callback result as JSON", async () => {
    const script = createTestHook(
      tmpDir,
      `
      return { continue: true, hookSpecificOutput: { test: "ok" } };
    `,
    );
    const { output } = await runScript(script, { cwd: tmpDir });
    assert.equal(output.continue, true);
    assert.equal(output.hookSpecificOutput.test, "ok");
  });

  it("passes parsed stdin as input parameter", async () => {
    const script = createTestHook(
      tmpDir,
      `
      return { continue: true, hookSpecificOutput: { echo: input.myField } };
    `,
    );
    const { output } = await runScript(script, {
      cwd: tmpDir,
      myField: "hello",
    });
    assert.equal(output.hookSpecificOutput.echo, "hello");
  });

  it("catches callback errors and injects crash context", async () => {
    const script = createTestHook(
      tmpDir,
      `
      throw new Error("deliberate crash");
    `,
      "crash-test",
    );
    const { output } = await runScript(script, { cwd: tmpDir });
    assert.equal(output.continue, true);
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes("HOOK CRASH"),
      "Should contain HOOK CRASH indicator",
    );
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes("deliberate crash"),
      "Should contain the error message",
    );
  });

  it("records health status on success", async () => {
    const hookName = `health-ok-${Date.now()}`;
    const script = createTestHook(
      tmpDir,
      `
      return { continue: true };
    `,
      hookName,
    );
    await runScript(script, { cwd: tmpDir });

    const healthFile = join(
      tmpDir,
      ".project-brain",
      "loops",
      "hook-health.json",
    );
    const health = JSON.parse(readFileSync(healthFile, "utf8"));
    assert.equal(health[hookName].status, "ok");
    assert.equal(health[hookName].consecutiveOk, 1);
  });

  it("records health status on crash", async () => {
    const hookName = `health-crash-${Date.now()}`;
    const script = createTestHook(
      tmpDir,
      `
      throw new Error("boom");
    `,
      hookName,
    );
    await runScript(script, { cwd: tmpDir });

    const healthFile = join(
      tmpDir,
      ".project-brain",
      "loops",
      "hook-health.json",
    );
    const health = JSON.parse(readFileSync(healthFile, "utf8"));
    assert.equal(health[hookName].status, "crash");
    assert.equal(health[hookName].consecutiveOk, 0);
    assert.equal(health[hookName].error, "boom");
  });

  it("handles malformed stdin gracefully", async () => {
    const script = createTestHook(
      tmpDir,
      `
      return { continue: true, hookSpecificOutput: { gotInput: Object.keys(input).length } };
    `,
    );
    // Send garbage instead of JSON
    const { output } = await new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [script],
        { timeout: 8000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
        (error, stdout) => {
          let out = null;
          if (stdout.trim()) {
            try {
              out = JSON.parse(stdout.trim());
            } catch {
              out = stdout.trim();
            }
          }
          resolve({ output: out });
        },
      );
      child.stdin.write("this is not json{{{");
      child.stdin.end();
    });
    assert.equal(output.continue, true);
    assert.equal(output.hookSpecificOutput.gotInput, 0);
  });

  it("handles empty stdin gracefully", async () => {
    const script = createTestHook(
      tmpDir,
      `
      return { continue: true };
    `,
    );
    const { output } = await new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [script],
        { timeout: 8000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
        (error, stdout) => {
          let out = null;
          if (stdout.trim()) {
            try {
              out = JSON.parse(stdout.trim());
            } catch {
              out = stdout.trim();
            }
          }
          resolve({ output: out });
        },
      );
      child.stdin.end(); // No data at all
    });
    assert.equal(output.continue, true);
  });

  it("handles import errors inside callback", async () => {
    const script = createTestHook(
      tmpDir,
      `
      const { nonExistent } = await import("./does-not-exist.mjs");
      return { continue: true };
    `,
      "import-crash",
    );
    const { output } = await runScript(script, { cwd: tmpDir });
    assert.equal(output.continue, true);
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes("HOOK CRASH"),
      "Should catch import errors",
    );
  });
});
