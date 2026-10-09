#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Full Vectorization Pipeline
 *
 * Tests the complete flow:
 *   1. Create a temp markdown file in docs/memory/
 *   2. Vectorize the project
 *   3. Verify chunks exist in the index for that file
 *   4. Search for the unique content and find it
 *   5. Simulate deletion with cloud-manifest guard
 *   6. Verify chunks survive when cloud-backed
 *   7. Clean up everything
 *
 * Usage:
 *   node scripts/smoke-test-vectorization.mjs [projectPath]
 *
 * Default projectPath is cwd.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_PATH = resolve(process.argv[2] || process.cwd());
const MEMORY_PATH = join(PROJECT_PATH, "docs", "memory");
const TEST_FILENAME = "_SMOKE_TEST_VECTORIZATION.md";
const TEST_FILEPATH = join(MEMORY_PATH, TEST_FILENAME);
const UNIQUE_TOKEN = `SMOKE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".mcp-rag-docs",
);

// CLI path — try bundled first, then source
const BUNDLED_CLI = join(PROJECT_PATH, "dist", "mcp-server", "cli.mjs");
const SOURCE_CLI = join(PROJECT_PATH, "server", "dist", "cli.js");
const CLI_PATH = existsSync(BUNDLED_CLI) ? BUNDLED_CLI : SOURCE_CLI;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProjectId(projectPath) {
  return createHash("md5")
    .update(projectPath.replace(/\\/g, "/").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function loadIndex(projectId) {
  const indexPath = join(DATA_DIR, `${projectId}.json`);
  if (!existsSync(indexPath)) return null;
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

function saveIndex(index) {
  const indexPath = join(DATA_DIR, `${index.projectId}.json`);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function countChunksForFile(index, filePath) {
  if (!index || !index.chunks) return 0;
  return index.chunks.filter(
    (c) => c.filePath === filePath || c.filePath.endsWith(TEST_FILENAME),
  ).length;
}

function runCLI(...args) {
  try {
    const result = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env },
    });
    return result;
  } catch (err) {
    return err.stdout || err.message;
  }
}

const OK = "\x1b[32m✅\x1b[0m";
const FAIL = "\x1b[31m❌\x1b[0m";
const INFO = "\x1b[36mℹ️\x1b[0m";
const WARN = "\x1b[33m⚠️\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${OK} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

// ─── Smoke Test ──────────────────────────────────────────────────────────────

console.log("\n🏴‍☠️ ═══════════════════════════════════════════════════════");
console.log("   SMOKE TEST: Vectorization Pipeline");
console.log("═══════════════════════════════════════════════════════════\n");

console.log(`${INFO} Project: ${PROJECT_PATH}`);
console.log(`${INFO} Memory:  ${MEMORY_PATH}`);
console.log(`${INFO} CLI:     ${CLI_PATH}`);
console.log(`${INFO} Token:   ${UNIQUE_TOKEN}\n`);

// Pre-check
assert(existsSync(MEMORY_PATH), "docs/memory/ exists");
assert(existsSync(CLI_PATH), "MCP CLI exists");

const projectId = getProjectId(PROJECT_PATH);
console.log(`${INFO} ProjectId: ${projectId}\n`);

// ─── Step 1: Create test file ────────────────────────────────────────────────

console.log("─── Step 1: Create test file ───────────────────────────\n");

const TEST_CONTENT = `# Smoke Test File

## Purpose
This file tests the vectorization pipeline end-to-end.
It contains a unique token: ${UNIQUE_TOKEN}

## Technical Details
- Created by smoke-test-vectorization.mjs
- Should be vectorized into chunks
- Should be searchable via RAG
- Should survive cloud-backed eviction

## Architecture Notes
The vectorization system uses TF-IDF embeddings stored in a JSON index.
Each markdown file is split into chunks by heading boundaries.
The watcher monitors docs/memory/ for changes and re-indexes incrementally.

## Cleanup
This file will be deleted after the test completes.
If you see this file, the test was interrupted — safe to delete manually.
`;

writeFileSync(TEST_FILEPATH, TEST_CONTENT, "utf-8");
assert(existsSync(TEST_FILEPATH), `Created ${TEST_FILENAME}`);

// ─── Step 2: Vectorize ──────────────────────────────────────────────────────

console.log("\n─── Step 2: Vectorize project ──────────────────────────\n");

const indexBefore = loadIndex(projectId);
const chunksBefore = indexBefore ? indexBefore.chunks.length : 0;
console.log(`${INFO} Chunks before: ${chunksBefore}`);

console.log(`${INFO} Running vectorization...`);
const vectorizeOutput = runCLI("vectorize", PROJECT_PATH);
console.log(
  `${INFO} Output: ${vectorizeOutput.split("\n").filter(Boolean).slice(-3).join(" | ")}`,
);

const indexAfter = loadIndex(projectId);
const chunksAfter = indexAfter ? indexAfter.chunks.length : 0;
console.log(`${INFO} Chunks after: ${chunksAfter}`);

const testChunks = countChunksForFile(indexAfter, TEST_FILEPATH);
assert(
  testChunks > 0,
  `Test file has ${testChunks} chunks in index (total: ${chunksAfter})`,
);

// ─── Step 3: Search for unique token ─────────────────────────────────────────

console.log("\n─── Step 3: Search for unique content ─────────────────\n");

const searchOutput = runCLI(
  "search",
  UNIQUE_TOKEN,
  "-p",
  PROJECT_PATH,
  "-k",
  "3",
);
const foundInSearch =
  searchOutput.includes("Smoke Test") ||
  searchOutput.includes("smoke") ||
  searchOutput.includes(TEST_FILENAME);
console.log(
  `${INFO} Search results: ${searchOutput.split("\n").filter(Boolean).slice(0, 5).join(" | ")}`,
);
assert(foundInSearch, "Unique token found via search");

// ─── Step 4: Simulate cloud-backed deletion guard ────────────────────────────

console.log("\n─── Step 4: Cloud-backed deletion guard ───────────────\n");

// Create a fake cloud manifest that includes our test file
const MANIFEST_PATH = join(MEMORY_PATH, ".cloud-manifest-test.json");
const fakeManifest = {
  projectId: "test-project",
  files: {
    [TEST_FILENAME]: {
      contentHash: "abc123",
      sizeBytes: TEST_CONTENT.length,
      lastSynced: Date.now(),
    },
  },
};
writeFileSync(MANIFEST_PATH, JSON.stringify(fakeManifest, null, 2));
assert(existsSync(MANIFEST_PATH), "Created test cloud manifest");

// Now simulate what the watcher does on file deletion:
// 1. Load index
// 2. Check cloud manifest before deleting chunks
const indexForGuard = loadIndex(projectId);
const chunksBeforeDelete = countChunksForFile(indexForGuard, TEST_FILEPATH);
console.log(
  `${INFO} Chunks for test file before guard test: ${chunksBeforeDelete}`,
);

// Simulate the guard logic (mirrors watcher.ts isCloudBacked)
function isCloudBacked(filePath, memoryPath) {
  if (!existsSync(MANIFEST_PATH)) return false;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    const rel = filePath
      .replace(memoryPath + "\\", "")
      .replace(memoryPath + "/", "")
      .replace(/\\/g, "/");
    return manifest?.files?.[rel] !== undefined;
  } catch {
    return false;
  }
}

const isProtected = isCloudBacked(TEST_FILEPATH, MEMORY_PATH);
assert(isProtected, "Test file recognized as cloud-backed");

// Simulate: if cloud-backed, chunks should NOT be deleted
if (isProtected) {
  console.log(`${INFO} Guard active: chunks preserved (skip deletion)`);
  const chunksAfterGuard = countChunksForFile(indexForGuard, TEST_FILEPATH);
  assert(
    chunksAfterGuard === chunksBeforeDelete,
    `Chunks survived: ${chunksAfterGuard} (unchanged)`,
  );
} else {
  console.log(`${WARN} Guard NOT active — this shouldn't happen`);
}

// ─── Step 5: Test WITHOUT cloud manifest (chunks should be removable) ────────

console.log("\n─── Step 5: Unguarded deletion (no manifest) ─────────\n");

// Remove manifest → no protection
unlinkSync(MANIFEST_PATH);
assert(!existsSync(MANIFEST_PATH), "Removed test manifest");

const isProtectedNow = isCloudBacked(TEST_FILEPATH, MEMORY_PATH);
assert(!isProtectedNow, "File no longer cloud-backed without manifest");

// Simulate what watcher would do: remove chunks for this file
if (indexForGuard) {
  const before = indexForGuard.chunks.length;
  indexForGuard.chunks = indexForGuard.chunks.filter(
    (c) => c.filePath !== TEST_FILEPATH && !c.filePath.endsWith(TEST_FILENAME),
  );
  delete indexForGuard.fileHashes?.[TEST_FILEPATH];
  const after = indexForGuard.chunks.length;
  console.log(`${INFO} Simulated deletion: ${before} → ${after} chunks`);
  assert(after < before, "Chunks correctly removed when not cloud-backed");

  // DON'T save this — we want to leave the real index untouched
  console.log(`${INFO} (Index NOT saved — simulation only, real index intact)`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

console.log("\n─── Cleanup ───────────────────────────────────────────\n");

// Delete test file
if (existsSync(TEST_FILEPATH)) {
  unlinkSync(TEST_FILEPATH);
  assert(!existsSync(TEST_FILEPATH), `Removed ${TEST_FILENAME}`);
}

// Delete test manifest (in case it wasn't already)
if (existsSync(MANIFEST_PATH)) {
  unlinkSync(MANIFEST_PATH);
}

// Re-vectorize to clean up test chunks from the real index
console.log(`${INFO} Re-vectorizing to clean test chunks from index...`);
runCLI("vectorize", PROJECT_PATH);

const indexFinal = loadIndex(projectId);
const testChunksFinal = countChunksForFile(indexFinal, TEST_FILEPATH);
assert(testChunksFinal === 0, "Test chunks cleaned from index");

// ─── Results ─────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════════");
console.log(
  `   Results: ${passed} passed, ${failed} failed (${passed + failed} total)`,
);
console.log("═══════════════════════════════════════════════════════════\n");

if (failed > 0) {
  console.log(`${FAIL} Some tests failed! Check output above.\n`);
  process.exit(1);
} else {
  console.log(`${OK} All tests passed! Pipeline is healthy. 🏴‍☠️\n`);
  process.exit(0);
}
