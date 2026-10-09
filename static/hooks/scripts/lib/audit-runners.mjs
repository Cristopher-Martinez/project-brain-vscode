/**
 * audit-runners.mjs — Extracted TSC and test runner utilities for audit gate.
 * Separated from audit-gate.mjs to keep files under 400 lines.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { basename, join } from "path";
import { getLoopsDir } from "./brain-paths.mjs";

// ─── Test Contract Reader ──────────────────────────────────

const CONTRACT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Read the test contract from .project-brain/loops/test-contract.json.
 * Returns null if missing, malformed, or expired.
 */
export function readTestContract(cwd) {
  const cachePath = join(getLoopsDir(cwd), "test-contract.json");
  if (!existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Date.now() - cache.timestamp > CONTRACT_CACHE_TTL) return null;
    return cache.contract || null;
  } catch (err) {
    console.warn(
      "[TEST-CONTRACT] Corrupt contract cache. Forcing regeneration.",
    );
    try {
      unlinkSync(cachePath);
    } catch {
      /* already gone */
    }
    return null;
  }
}

/**
 * Run TypeScript compilation check.
 * @param {string} cwd - Project root
 * @returns {{ pass: boolean, output: string }}
 */
export function runTscCheck(cwd) {
  try {
    const result = execFileSync(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false"],
      {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { pass: true, output: result || "" };
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    // Filter out node_modules noise
    const lines = output.split("\n").filter((l) => !l.includes("node_modules"));
    return { pass: false, output: lines.join("\n") };
  }
}

/** Extensions that represent testable code files. */
const TESTABLE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Run tests for modules related to edited files.
 * @param {string} cwd - Project root
 * @param {string[]} editedFiles - List of edited file paths
 * @returns {{ pass: boolean, output: string, testsFound: boolean }}
 */
export function runTestsForModules(cwd, editedFiles) {
  // Filter to only testable code files first
  const codeFiles = editedFiles.filter((ef) =>
    TESTABLE_EXTENSIONS.test(basename(ef)),
  );
  // Discover test files matching edited modules
  const testFiles = [];
  for (const ef of codeFiles) {
    const base = basename(ef).replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
    // Search for matching test files in common test directories
    const testDirs = [
      join(cwd, "__tests__"),
      join(cwd, "src", "__tests__"),
      join(cwd, "static", "hooks", "scripts", "__tests__"),
      join(cwd, ".github", "hooks", "scripts", "__tests__"),
    ];
    for (const dir of testDirs) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir);
        for (const f of files) {
          if (f.includes(base) && /\.test\.(ts|tsx|js|jsx|mjs)$/.test(f)) {
            const fullPath = join(dir, f);
            if (!testFiles.includes(fullPath)) testFiles.push(fullPath);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (testFiles.length === 0) {
    return {
      pass: true,
      output: "No matching test files found",
      testsFound: false,
    };
  }

  // Use contract's framework for test runner selection
  const contract = readTestContract(cwd);

  try {
    const { cmd, args } = resolveTestExecution(contract, testFiles);
    // Validate non-Node runners exist in PATH
    if (!isNodeRunner(cmd) && !commandExists(cmd)) {
      return {
        pass: false,
        output: `❌ Test runner '${cmd}' not found in PATH. Install it or configure a test script in package.json.`,
        testsFound: true,
      };
    }
    const result = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { pass: true, output: result || "", testsFound: true };
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    return { pass: false, output, testsFound: true };
  }
}

/**
 * Resolve test execution command from contract framework.
 * Returns { cmd, args } — cmd may be non-npx for non-Node frameworks.
 * @param {object|null} contract - Test contract
 * @param {string[]} testFiles - Test file paths
 * @returns {{ cmd: string, args: string[] }}
 */
function resolveTestExecution(contract, testFiles) {
  const framework = contract?.framework || "mocha";
  switch (framework) {
    case "vitest":
      return { cmd: "npx", args: ["vitest", "run", ...testFiles] };
    case "jest":
      return { cmd: "npx", args: ["jest", "--no-cache", ...testFiles] };
    case "pytest":
      return { cmd: "pytest", args: testFiles.length ? testFiles : [] };
    case "rspec":
      return { cmd: "bundle", args: ["exec", "rspec", ...testFiles] };
    case "go-test":
      return { cmd: "go", args: ["test", "./..."] };
    case "cargo-test":
      return { cmd: "cargo", args: ["test"] };
    case "mocha":
    default:
      return {
        cmd: "npx",
        args: ["mocha", ...testFiles, "--timeout", "15000"],
      };
  }
}

/** Check if a command exists in PATH. */
function commandExists(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Returns true if cmd is a Node package runner (npx). */
function isNodeRunner(cmd) {
  return cmd === "npx";
}
