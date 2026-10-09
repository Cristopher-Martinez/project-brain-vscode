/**
 * test-helper.mjs — Shared utilities for hook integration tests.
 *
 * Spawns hook scripts as child processes, pipes JSON to stdin,
 * and captures the parsed JSON output.
 *
 * Uses Node.js built-in modules only (zero dependencies).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, "..");

/**
 * Runs a hook script with the given input, returns parsed JSON output.
 * @param {string} hookFile — filename (e.g. "session-start.mjs")
 * @param {Record<string, unknown>} input — input to pipe via stdin
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] — timeout in ms
 * @returns {Promise<{ output: unknown, stderr: string, exitCode: number }>}
 */
export function runHook(hookFile, input = {}, opts = {}) {
  const { timeoutMs = 10000 } = opts;
  const scriptPath = join(SCRIPTS_DIR, hookFile);
  const stdinData = JSON.stringify(input);

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      {
        timeout: timeoutMs,
        cwd: SCRIPTS_DIR,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          return reject(
            new Error(`Hook ${hookFile} timed out after ${timeoutMs}ms`),
          );
        }

        let output = null;
        try {
          if (stdout.trim()) {
            output = JSON.parse(stdout.trim());
          }
        } catch {
          output = { __raw: stdout.trim(), __parseError: true };
        }

        resolve({
          output,
          stderr: stderr || "",
          exitCode: error ? error.code || 1 : 0,
        });
      },
    );

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Creates a temporary directory that mimics a minimal project workspace
 * with .project-brain/memory/ structure. Returns the temp path and a cleanup function.
 * @returns {{ tmpDir: string, cleanup: () => void }}
 */
export function createTempWorkspace() {
  const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
  const memoryDir = join(tmpDir, "docs", "memory");
  mkdirSync(memoryDir, { recursive: true });

  // Create minimal required files
  writeFileSync(join(memoryDir, "BOOT.md"), "# Test Project\nType: test\n");
  writeFileSync(
    join(memoryDir, "14_OPINIONS.md"),
    "---\nopinions: []\n---\n# Opinions\n",
  );
  writeFileSync(join(memoryDir, "04_LEARNINGS.md"), "---\n---\n# Learnings\n");
  writeFileSync(
    join(memoryDir, "05_TROUBLESHOOTING.md"),
    "---\n---\n# Troubleshooting\n",
  );
  writeFileSync(
    join(memoryDir, "07_SESSION_HANDOFF.md"),
    "---\n---\n# Session Handoff\n",
  );

  // Create .project-brain/loops directory
  mkdirSync(join(tmpDir, ".project-brain", "loops"), { recursive: true });

  // Create .git directory (some hooks check for git)
  mkdirSync(join(tmpDir, ".git"), { recursive: true });
  writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  };

  return { tmpDir, cleanup };
}

/**
 * Standard assertions for hook output shape.
 * @param {unknown} output — parsed hook output
 * @param {string} hookName — for error messages
 */
export function assertValidHookOutput(output, hookName) {
  if (output === null || output === undefined) {
    throw new Error(`[${hookName}] Output is null/undefined`);
  }
  if (typeof output !== "object") {
    throw new Error(`[${hookName}] Output is not an object: ${typeof output}`);
  }
  if (output.__parseError) {
    throw new Error(`[${hookName}] Output was not valid JSON: ${output.__raw}`);
  }
  if (typeof output.continue !== "boolean") {
    throw new Error(
      `[${hookName}] Missing or invalid 'continue' field: ${JSON.stringify(output.continue)}`,
    );
  }
}
