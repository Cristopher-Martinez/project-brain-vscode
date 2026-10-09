#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Self-Learning Module (vectorize --scan-all)
 *
 * Tests the changes made for repos without a memory/ folder:
 *   1. Vectorize a repo WITHOUT memory/ using --scan-all → should succeed
 *   2. Vectorize a repo WITHOUT memory/ WITHOUT --scan-all → should fail
 *   3. Vectorize a project WITH docs/memory/ (backward compat) → should succeed
 *   4. Verify output parsing works for chunks/files
 *
 * Usage:
 *   node scripts/smoke-test-self-learning.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_PATH = resolve(process.cwd());
const CLI_PATH = join(PROJECT_PATH, "dist", "mcp-server", "cli.mjs");
const TEMP_DIR = join(PROJECT_PATH, ".test-self-learning");
const TEMP_NO_MEMORY = join(TEMP_DIR, "no-memory-repo");
const TEMP_WITH_MEMORY = join(TEMP_DIR, "with-memory-repo");

let passed = 0;
let failed = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(label) {
  passed++;
  console.log(`  ✅ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.log(`  ❌ ${label}: ${detail}`);
}

function setup() {
  // Clean up from previous runs
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });

  // Create repo WITHOUT memory folder (like forge-orchestrator)
  mkdirSync(TEMP_NO_MEMORY, { recursive: true });
  mkdirSync(join(TEMP_NO_MEMORY, "docs"), { recursive: true });
  mkdirSync(join(TEMP_NO_MEMORY, "src"), { recursive: true });
  writeFileSync(
    join(TEMP_NO_MEMORY, "README.md"),
    "# Test Repo\n\nThis is a test.",
  );
  writeFileSync(
    join(TEMP_NO_MEMORY, "CHANGELOG.md"),
    "# Changelog\n\n## v1.0\n- Initial release",
  );
  writeFileSync(
    join(TEMP_NO_MEMORY, "docs", "GUIDE.md"),
    "# Guide\n\nStep 1. Do the thing.",
  );
  writeFileSync(join(TEMP_NO_MEMORY, "src", "index.ts"), "export const x = 1;"); // non-md

  // Create repo WITH docs/memory/ folder (like project-brain)
  mkdirSync(join(TEMP_WITH_MEMORY, "docs", "memory"), { recursive: true });
  writeFileSync(
    join(TEMP_WITH_MEMORY, "docs", "memory", "01_OVERVIEW.md"),
    "# Overview\n\nProject description here.",
  );
  writeFileSync(
    join(TEMP_WITH_MEMORY, "docs", "memory", "02_ARCH.md"),
    "# Architecture\n\nModular design.",
  );
  writeFileSync(
    join(TEMP_WITH_MEMORY, "README.md"),
    "# Should Not Be Indexed\n\nThis is outside memory/.",
  );
}

function cleanup() {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });
}

function runCli(args) {
  return execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, EMBEDDING_PROVIDER: "tfidf" }, // No OpenAI needed
  });
}

function runCliFail(args) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EMBEDDING_PROVIDER: "tfidf" },
    });
    return null; // Didn't fail
  } catch (err) {
    return err.stderr || err.message || "exit code non-zero";
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testScanAllSuccess() {
  console.log("\n🧪 Test 1: --scan-all on repo WITHOUT memory/");
  try {
    const out = runCli(["vectorize", TEMP_NO_MEMORY, "--force", "--scan-all"]);
    if (out.includes("Indexed successfully")) ok("Indexed successfully");
    else fail("Missing 'Indexed successfully'", out.slice(-200));

    if (out.includes("No memory folder found, scanning all .md"))
      ok("Fallback message present");
    else fail("Missing fallback message", out.slice(0, 200));

    // Should have found 3 .md files
    const filesMatch = /Files:\s*(\d+)/i.exec(out);
    if (filesMatch && parseInt(filesMatch[1]) === 3) ok(`Found 3 files`);
    else
      fail(
        "Expected 3 files",
        filesMatch ? `Got ${filesMatch[1]}` : "No match",
      );

    const chunksMatch = /Chunks:\s*(\d+)/i.exec(out);
    if (chunksMatch && parseInt(chunksMatch[1]) > 0)
      ok(`Generated ${chunksMatch[1]} chunks`);
    else
      fail(
        "Expected >0 chunks",
        chunksMatch ? `Got ${chunksMatch[1]}` : "No match",
      );
  } catch (err) {
    fail("Unexpected error", err.message);
  }
}

function testNoScanAllFails() {
  console.log(
    "\n🧪 Test 2: WITHOUT --scan-all on repo WITHOUT memory/ (should fail)",
  );
  const errOutput = runCliFail(["vectorize", TEMP_NO_MEMORY, "--force"]);
  if (errOutput) ok("Correctly failed without --scan-all");
  else fail("Should have failed", "But succeeded");
}

function testWithMemoryFolder() {
  console.log(
    "\n🧪 Test 3: Standard vectorize WITH docs/memory/ (backward compat)",
  );
  try {
    const out = runCli(["vectorize", TEMP_WITH_MEMORY, "--force"]);
    if (out.includes("Indexed successfully")) ok("Indexed successfully");
    else fail("Missing 'Indexed successfully'", out.slice(-200));

    // Should NOT contain fallback message
    if (!out.includes("scanning all .md files from project root"))
      ok("No fallback (memory/ found)");
    else fail("Should not use fallback", "Memory folder exists");

    // Should only index 2 files (inside docs/memory/, not README.md)
    const filesMatch = /Files:\s*(\d+)/i.exec(out);
    if (filesMatch && parseInt(filesMatch[1]) === 2)
      ok(`Found 2 files (only memory/)`);
    else
      fail(
        "Expected 2 files",
        filesMatch ? `Got ${filesMatch[1]}` : "No match",
      );
  } catch (err) {
    fail("Unexpected error", err.message);
  }
}

function testScanAllWithMemoryFolder() {
  console.log(
    "\n🧪 Test 4: --scan-all WITH docs/memory/ (memory/ should take priority)",
  );
  try {
    const out = runCli([
      "vectorize",
      TEMP_WITH_MEMORY,
      "--force",
      "--scan-all",
    ]);
    if (out.includes("Indexed successfully")) ok("Indexed successfully");
    else fail("Missing 'Indexed successfully'", out.slice(-200));

    // Memory folder exists, so fallback should NOT trigger even with --scan-all
    if (!out.includes("scanning all .md files from project root"))
      ok("Memory/ used (priority over --scan-all)");
    else
      fail(
        "Should prefer memory/",
        "Fallback triggered despite memory/ existing",
      );
  } catch (err) {
    fail("Unexpected error", err.message);
  }
}

function testEmptyRepo() {
  console.log("\n🧪 Test 5: --scan-all on repo with 0 .md files");
  const emptyDir = join(TEMP_DIR, "empty-repo");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "index.ts"), "export const x = 1;");
  try {
    const out = runCli(["vectorize", emptyDir, "--force", "--scan-all"]);
    if (out.includes("Found 0 markdown files")) ok("Found 0 files (graceful)");
    else if (out.includes("Indexed successfully"))
      ok("Indexed (0 files, not a crash)");
    else fail("Unexpected output", out.slice(-200));
  } catch (err) {
    // Might fail gracefully — that's OK too
    if (err.status === 0) ok("Exited cleanly with 0 files");
    else fail("Crashed on empty repo", err.message?.slice(0, 200));
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("🏴‍☠️ Self-Learning Smoke Test Suite");
console.log(`   CLI: ${CLI_PATH}`);

if (!existsSync(CLI_PATH)) {
  console.error("❌ CLI not found. Run 'npm run compile' first.");
  process.exit(1);
}

setup();
try {
  testScanAllSuccess();
  testNoScanAllFails();
  testWithMemoryFolder();
  testScanAllWithMemoryFolder();
  testEmptyRepo();
} finally {
  cleanup();
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
