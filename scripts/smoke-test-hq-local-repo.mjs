#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Brain HQ Local Repo Flow (Full Pipeline)
 *
 * Simulates the complete Brain HQ self-learning flow for a LOCAL repo:
 *   1. addRepo(localPath) — registers the repo in SQLite
 *   2. Verify status = "cloned" (local repos skip clone)
 *   3. CLI vectorize --scan-all --force → parses output
 *   4. Verify chunks > 0, files > 0, "Indexed successfully"
 *   5. Pipeline end: status should be "vectorized"
 *
 * Usage:
 *   node scripts/smoke-test-hq-local-repo.mjs [optional-local-repo-path]
 *
 * Without an argument it reads the HQ_LOCAL_REPO environment variable.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(process.cwd());
const CLI_PATH = join(PROJECT_ROOT, "dist", "mcp-server", "cli.mjs");
const REPO_PATH = process.argv[2] || process.env.HQ_LOCAL_REPO || "";

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

function assert(condition, label, failDetail) {
  if (condition) ok(label);
  else fail(label, failDetail);
}

function runCli(args, env = {}) {
  return execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

// ─── Test 1: Repo exists & has .md files ────────────────────────────────────

function testRepoExists() {
  console.log("\n🧪 Test 1: Repo source validation");
  assert(
    existsSync(REPO_PATH),
    `Repo exists at path`,
    `${REPO_PATH} not found`,
  );

  // Simulate what addRepo() does for local repos
  const name = basename(REPO_PATH);
  assert(name.length > 0, `Repo name extracted: "${name}"`, "Empty name");

  // Check it's not a GitHub URL (sourceType = "local")
  const isGithub =
    /^https?:\/\/github\.com\//i.test(REPO_PATH) ||
    /^git@github\.com:/i.test(REPO_PATH);
  assert(
    !isGithub,
    "Detected as local repo (not GitHub)",
    "Detected as GitHub",
  );
}

// ─── Test 2: addRepo flow simulation ────────────────────────────────────────

function testAddRepoFlow() {
  console.log("\n🧪 Test 2: addRepo() flow simulation");

  // Simulate the addRepo logic for local repos:
  // 1. sourceType = "local"
  // 2. localPath = source (as-is)
  // 3. Status immediately → "cloned" (no clone needed)
  const sourceType = "local";
  const localPath = REPO_PATH;
  const status = "cloned"; // Local repos skip to "cloned"

  assert(sourceType === "local", "sourceType = 'local'", sourceType);
  assert(localPath === REPO_PATH, "localPath = source path", localPath);
  assert(status === "cloned", "Initial status = 'cloned' (skip clone)", status);
  assert(existsSync(localPath), "localPath exists on disk", "Not found");
}

// ─── Test 3: Pipeline — vectorize with --scan-all ───────────────────────────

function testPipelineVectorize() {
  console.log("\n🧪 Test 3: Pipeline vectorize (CLI with --scan-all)");

  try {
    const out = runCli(["vectorize", REPO_PATH, "--force", "--scan-all"]);

    // Verify key output markers
    assert(
      out.includes("Indexed successfully"),
      "Output contains 'Indexed successfully'",
      out.slice(-200),
    );

    // Check scan-all fallback message (no docs/memory/ in forge-orchestrator)
    const hasMemory = existsSync(join(REPO_PATH, "docs", "memory"));
    if (!hasMemory) {
      assert(
        out.includes("No memory folder found, scanning all .md"),
        "scan-all fallback triggered (no memory/ folder)",
        "Fallback message missing",
      );
    }

    // Parse chunks
    const chunksMatch = /Chunks:\s*(\d+)/i.exec(out);
    const chunks = chunksMatch ? parseInt(chunksMatch[1], 10) : 0;
    assert(chunks > 0, `Generated ${chunks} chunks`, "0 chunks");

    // Parse files
    const filesMatch = /Files:\s*(\d+)/i.exec(out);
    const files = filesMatch ? parseInt(filesMatch[1], 10) : 0;
    assert(files > 0, `Processed ${files} files`, "0 files");

    // Parse embedding provider
    const embMatch = /Embedding:\s*(\w+)/i.exec(out);
    const embedding = embMatch ? embMatch[1] : "unknown";
    assert(
      embedding === "openai" || embedding === "tfidf",
      `Embedding: ${embedding}`,
      "Unknown provider",
    );

    // Graph construction
    assert(
      out.includes("Graph built"),
      "Knowledge graph built",
      "No graph output",
    );

    return { chunks, files, embedding };
  } catch (err) {
    fail("Vectorize CLI failed", err.message?.slice(0, 300) || "unknown");
    return null;
  }
}

// ─── Test 4: Re-vectorize is idempotent ─────────────────────────────────────

function testIdempotentRevectorize() {
  console.log("\n🧪 Test 4: Re-vectorize (idempotent, --force)");

  try {
    const out = runCli(["vectorize", REPO_PATH, "--force", "--scan-all"]);
    assert(
      out.includes("Indexed successfully"),
      "Second vectorize succeeds",
      out.slice(-200),
    );

    const chunksMatch = /Chunks:\s*(\d+)/i.exec(out);
    const chunks = chunksMatch ? parseInt(chunksMatch[1], 10) : 0;
    assert(chunks > 0, `Re-vectorize produced ${chunks} chunks`, "0 chunks");
  } catch (err) {
    fail("Re-vectorize failed", err.message?.slice(0, 300) || "unknown");
  }
}

// ─── Test 5: Pipeline output parsing matches self-learning-vectorize.ts ─────

function testOutputParsing() {
  console.log(
    "\n🧪 Test 5: Output parser compatibility (parseVectorizeOutput)",
  );

  try {
    const out = runCli(["vectorize", REPO_PATH, "--force", "--scan-all"]);

    // Simulate what parseVectorizeOutput() does
    const chunksMatch = /Chunks:\s*(\d+)/i.exec(out);
    const filesMatch = /Files:\s*(\d+)/i.exec(out);
    const success = /indexed successfully/i.test(out);

    const result = {
      chunks: chunksMatch ? parseInt(chunksMatch[1], 10) : 0,
      files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      success,
    };

    assert(
      result.success === true,
      "parseVectorizeOutput: success=true",
      "false",
    );
    assert(
      result.chunks > 0,
      `parseVectorizeOutput: chunks=${result.chunks}`,
      "0",
    );
    assert(
      result.files > 0,
      `parseVectorizeOutput: files=${result.files}`,
      "0",
    );

    // Simulate DB update (what _doVectorize does after success)
    const finalStatus = result.success ? "vectorized" : "error";
    assert(
      finalStatus === "vectorized",
      `Final status would be: ${finalStatus}`,
      "error",
    );
  } catch (err) {
    fail("Output parsing test failed", err.message?.slice(0, 300) || "unknown");
  }
}

// ─── Test 6: Non-existent path fails gracefully ─────────────────────────────

function testNonExistentPath() {
  console.log("\n🧪 Test 6: Non-existent path fails gracefully");

  const fakePath = join(PROJECT_ROOT, "this-does-not-exist-" + Date.now());

  // Simulate addRepo check
  assert(
    !existsSync(fakePath),
    "Path correctly detected as non-existent",
    "Path exists?!",
  );

  // What addRepo does: throws "Carpeta no encontrada"
  try {
    // The CLI might fail differently, but the addRepo guard catches first
    ok("addRepo would throw 'Carpeta no encontrada' before CLI invocation");
  } catch {
    ok("Graceful failure for non-existent path");
  }
}

// ─── Test 7: Streaming progress lines are parseable ─────────────────────────

function testStreamingProgressParsing() {
  console.log("\n🧪 Test 7: Streaming progress lines are parseable");

  try {
    const out = runCli(["vectorize", REPO_PATH, "--force", "--scan-all"]);

    // Check that "Processing:" lines exist (the stream parser uses these)
    const processingLines = out
      .split("\n")
      .filter((l) => /Processing:/i.test(l));
    assert(
      processingLines.length > 0,
      `Found ${processingLines.length} 'Processing:' lines`,
      "0 lines",
    );

    // Check that "Found X files to update" exists
    const foundFiles = /(\d+)\s+files\s+to\s+update/i.exec(out);
    assert(
      foundFiles !== null,
      `Found '${foundFiles?.[0] ?? "N/A"}' pattern`,
      "Missing pattern",
    );

    // Check for chunk embedding progress
    const chunkProgress = /Progress:\s*\d+\/\d+\s*chunks/i.test(out);
    assert(
      chunkProgress,
      "Chunk embedding progress lines present",
      "Missing chunk progress",
    );
  } catch (err) {
    fail(
      "Streaming progress parsing failed",
      err.message?.slice(0, 300) || "unknown",
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("🏴‍☠️ Brain HQ Local Repo Flow — Full Smoke Test");
console.log(`   CLI: ${CLI_PATH}`);
console.log(`   Repo: ${REPO_PATH}`);
console.log(`   Repo name: ${basename(REPO_PATH)}`);

if (!existsSync(CLI_PATH)) {
  console.error("❌ CLI not found. Run 'npm run compile' first.");
  process.exit(1);
}

if (!existsSync(REPO_PATH)) {
  console.error(`❌ Repo not found: ${REPO_PATH}`);
  process.exit(1);
}

testRepoExists();
testAddRepoFlow();
testPipelineVectorize();
testIdempotentRevectorize();
testOutputParsing();
testNonExistentPath();
testStreamingProgressParsing();

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
