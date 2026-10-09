#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Fork-Based Branch Isolation
 *
 * Tests the COMPLETE fork isolation flow end-to-end:
 *   1. Create a temp git repo (simulates user's workspace)
 *   2. Clone into .brain-forks/<forkId>/ (simulates createFork)
 *   3. Verify fork is an independent repo with correct branch
 *   4. Create a file in the fork — verify it's NOT in source repo
 *   5. Auto-commit in fork (simulates autoCommitFork)
 *   6. Absorb fork into source via fetch+merge (simulates absorbFork)
 *   7. Verify merged file appears in source repo
 *   8. Test discard flow: clone, discard, verify cleanup
 *   9. Test node_modules linking (junction/symlink)
 *  10. Test fork hardening (pushurl blocked, brain.fork=true)
 *  11. Clean up temp directories
 *
 * Usage:
 *   node scripts/smoke-test-fork-isolation.mjs
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const TEMP_ROOT = join(tmpdir(), `brain-fork-test-${Date.now()}`);
const FORK_BASE_DIR = ".brain-forks";
const SESSION_ID = "test-fork-session-abc123";
const FORK_ID = createHash("sha256")
  .update(SESSION_ID)
  .digest("hex")
  .slice(0, 8);
const BRANCH_PREFIX = "brain/loop-";
const BRANCH_NAME = `${BRANCH_PREFIX}smoke-${SESSION_ID.slice(0, 8)}`;
const UNIQUE_CONTENT = `FORK_TEST_${Date.now()}`;

let passed = 0;
let failed = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n🏴‍☠️ ${title}`);
  console.log("─".repeat(60));
}

// ─── Setup ───────────────────────────────────────────────────────────────────

section("Setup: Creating temp git repo (simulates user workspace)");

mkdirSync(TEMP_ROOT, { recursive: true });
git(TEMP_ROOT, ["init"]);
git(TEMP_ROOT, ["config", "user.email", "test@brain.dev"]);
git(TEMP_ROOT, ["config", "user.name", "Brain Test"]);

writeFileSync(join(TEMP_ROOT, "README.md"), "# Test Repo\n");
mkdirSync(join(TEMP_ROOT, "src"), { recursive: true });
writeFileSync(join(TEMP_ROOT, "src", "index.ts"), "export const x = 1;\n");
git(TEMP_ROOT, ["add", "."]);
git(TEMP_ROOT, ["commit", "-m", "Initial commit"]);

// Create a fake node_modules dir to test linking
mkdirSync(join(TEMP_ROOT, "node_modules", ".package-lock.json"), {
  recursive: true,
});
writeFileSync(
  join(TEMP_ROOT, "node_modules", "marker.txt"),
  "node_modules_marker",
);

const originalBranch = git(TEMP_ROOT, ["branch", "--show-current"]);
console.log(`  Repo: ${TEMP_ROOT}`);
console.log(`  Branch: ${originalBranch}`);
console.log(`  Fork ID: ${FORK_ID}`);
assert(existsSync(join(TEMP_ROOT, ".git")), "Source git repo created");

// ─── Test 1: Clone into fork directory (--shared) ────────────────────────────

section("Test 1: Create fork via git clone --shared");

const forkPath = join(TEMP_ROOT, FORK_BASE_DIR, FORK_ID);
mkdirSync(join(TEMP_ROOT, FORK_BASE_DIR), { recursive: true });

try {
  git(TEMP_ROOT, ["clone", "--shared", TEMP_ROOT, forkPath]);
  assert(existsSync(forkPath), "Fork directory created");
  assert(
    existsSync(join(forkPath, ".git")),
    "Fork has its own .git (independent repo)",
  );

  // Verify fork has the source content
  assert(
    existsSync(join(forkPath, "README.md")),
    "Fork contains README.md from source",
  );

  // Verify source repo unchanged
  const srcBranch = git(TEMP_ROOT, ["branch", "--show-current"]);
  assert(
    srcBranch === originalBranch,
    `Source still on ${originalBranch} (got: ${srcBranch})`,
  );
} catch (err) {
  console.error(`  ❌ Clone failed: ${err.message}`);
  failed++;
}

// ─── Test 2: Fork hardening ──────────────────────────────────────────────────

section("Test 2: Fork hardening (pushurl block + brain.fork marker)");

try {
  git(forkPath, ["config", "remote.origin.pushurl", "FORK_NO_PUSH"]);
  git(forkPath, ["config", "brain.fork", "true"]);
  git(forkPath, ["config", "gc.auto", "0"]);

  const pushUrl = git(forkPath, ["config", "--get", "remote.origin.pushurl"]);
  assert(pushUrl === "FORK_NO_PUSH", "Push URL blocked");

  const isFork = git(forkPath, ["config", "--get", "brain.fork"]);
  assert(isFork === "true", "brain.fork marker set");

  const gcAuto = git(forkPath, ["config", "--get", "gc.auto"]);
  assert(gcAuto === "0", "gc.auto disabled");
} catch (err) {
  console.error(`  ❌ Hardening failed: ${err.message}`);
  failed++;
}

// ─── Test 3: Create branch inside fork ───────────────────────────────────────

section("Test 3: Create and checkout branch inside fork");

try {
  git(forkPath, ["checkout", "-b", BRANCH_NAME]);
  const forkBranch = git(forkPath, ["branch", "--show-current"]);
  assert(forkBranch === BRANCH_NAME, `Fork on correct branch: ${forkBranch}`);

  // Source repo should NOT have this branch
  const srcBranches = git(TEMP_ROOT, ["branch", "--list"]);
  assert(
    !srcBranches.includes(BRANCH_NAME),
    "Branch does NOT exist in source repo (isolated!)",
  );
} catch (err) {
  console.error(`  ❌ Branch creation failed: ${err.message}`);
  failed++;
}

// ─── Test 4: File isolation ──────────────────────────────────────────────────

section("Test 4: File isolation between fork and source");

const testFile = "fork-isolation-test.txt";
try {
  writeFileSync(join(forkPath, testFile), UNIQUE_CONTENT);
  assert(existsSync(join(forkPath, testFile)), "File exists in fork");
  assert(
    !existsSync(join(TEMP_ROOT, testFile)),
    "File does NOT exist in source (isolated!)",
  );
} catch (err) {
  console.error(`  ❌ File isolation failed: ${err.message}`);
  failed++;
}

// ─── Test 5: Auto-commit in fork ─────────────────────────────────────────────

section("Test 5: Auto-commit in fork");

try {
  const statusBefore = git(forkPath, ["status", "--porcelain"]);
  assert(statusBefore.length > 0, "Fork has uncommitted changes");

  git(forkPath, ["add", "-A"]);
  git(forkPath, ["commit", "-m", `[Project Brain] Auto-commit smoke test`]);
  git(forkPath, ["config", "user.email", "test@brain.dev"]);
  git(forkPath, ["config", "user.name", "Brain Test"]);

  const statusAfter = git(forkPath, ["status", "--porcelain"]);
  assert(statusAfter === "", "Fork clean after auto-commit");
} catch (err) {
  console.error(`  ❌ Auto-commit failed: ${err.message}`);
  failed++;
}

// ─── Test 6: Absorb fork (fetch + merge) ─────────────────────────────────────

section("Test 6: Absorb fork into source (fetch + merge)");

try {
  // Fetch the fork's branch into source repo
  git(TEMP_ROOT, ["fetch", forkPath, BRANCH_NAME]);

  // Merge FETCH_HEAD into current branch
  git(TEMP_ROOT, [
    "merge",
    "FETCH_HEAD",
    "--no-ff",
    "-m",
    `Merge fork '${BRANCH_NAME}' (smoke test)`,
  ]);

  // Verify the file now exists in source
  assert(
    existsSync(join(TEMP_ROOT, testFile)),
    "Merged file appears in source repo!",
  );

  const content = readFileSync(join(TEMP_ROOT, testFile), "utf-8");
  assert(content === UNIQUE_CONTENT, "Merged file has correct content");

  // Source stayed on original branch the whole time
  const srcBranch = git(TEMP_ROOT, ["branch", "--show-current"]);
  assert(
    srcBranch === originalBranch,
    `Source still on ${originalBranch} after merge`,
  );
} catch (err) {
  console.error(`  ❌ Absorb failed: ${err.message}`);
  failed++;
}

// ─── Test 7: Fork disposal ───────────────────────────────────────────────────

section("Test 7: Fork disposal (rimraf-style cleanup)");

try {
  rmSync(forkPath, { recursive: true, force: true });
  assert(!existsSync(forkPath), "Fork directory removed");

  // Source repo still intact
  assert(
    existsSync(join(TEMP_ROOT, ".git")),
    "Source .git still intact after fork disposal",
  );
  assert(
    existsSync(join(TEMP_ROOT, testFile)),
    "Merged file still in source after fork disposal",
  );
} catch (err) {
  console.error(`  ❌ Disposal failed: ${err.message}`);
  failed++;
}

// ─── Test 8: Discard flow ────────────────────────────────────────────────────

section("Test 8: Discard flow (create fork → discard without merging)");

const discardForkId = "deadbeef";
const discardForkPath = join(TEMP_ROOT, FORK_BASE_DIR, discardForkId);
const discardBranch = `${BRANCH_PREFIX}discard-test`;
const discardFile = "should-not-survive.txt";

try {
  git(TEMP_ROOT, ["clone", "--shared", TEMP_ROOT, discardForkPath]);
  git(discardForkPath, ["config", "user.email", "test@brain.dev"]);
  git(discardForkPath, ["config", "user.name", "Brain Test"]);
  git(discardForkPath, ["checkout", "-b", discardBranch]);

  writeFileSync(join(discardForkPath, discardFile), "throwaway");
  git(discardForkPath, ["add", "-A"]);
  git(discardForkPath, ["commit", "-m", "Discard test commit"]);

  assert(
    existsSync(join(discardForkPath, discardFile)),
    "Discard file exists in fork",
  );

  // Now discard (delete without merging)
  rmSync(discardForkPath, { recursive: true, force: true });
  assert(!existsSync(discardForkPath), "Fork directory removed");
  assert(
    !existsSync(join(TEMP_ROOT, discardFile)),
    "Discard file NOT in source (never merged)",
  );
} catch (err) {
  console.error(`  ❌ Discard flow failed: ${err.message}`);
  failed++;
}

// ─── Test 9: Node modules linking ────────────────────────────────────────────

section("Test 9: Node modules junction/symlink");

const linkTestForkPath = join(TEMP_ROOT, FORK_BASE_DIR, "link-test");

try {
  git(TEMP_ROOT, ["clone", "--shared", TEMP_ROOT, linkTestForkPath]);

  const source = join(TEMP_ROOT, "node_modules");
  const target = join(linkTestForkPath, "node_modules");

  // Remove cloned node_modules if it exists
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  // Create junction (Windows) or symlink (Unix)
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(source, target, linkType);

  assert(existsSync(target), "node_modules link created");
  const stat = lstatSync(target);
  assert(stat.isSymbolicLink(), `node_modules is a symlink/junction`);

  // Verify linked content is accessible
  const marker = readFileSync(join(target, "marker.txt"), "utf-8");
  assert(
    marker === "node_modules_marker",
    "Linked node_modules content accessible",
  );

  rmSync(linkTestForkPath, { recursive: true, force: true });
} catch (err) {
  console.error(`  ❌ Node modules linking failed: ${err.message}`);
  failed++;
}

// ─── Test 10: --local clone strategy (fallback) ──────────────────────────────

section("Test 10: Clone with --local strategy (fallback)");

const localForkPath = join(TEMP_ROOT, FORK_BASE_DIR, "local-test");

try {
  git(TEMP_ROOT, ["clone", "--local", TEMP_ROOT, localForkPath]);
  assert(existsSync(localForkPath), "Local clone created");

  const localBranch = git(localForkPath, ["branch", "--show-current"]);
  assert(localBranch === originalBranch, "Local clone on correct branch");

  // Local clone should have its own objects (not alternates)
  const objectsDir = join(localForkPath, ".git", "objects");
  assert(existsSync(objectsDir), "Local clone has own objects dir");

  rmSync(localForkPath, { recursive: true, force: true });
} catch (err) {
  console.error(`  ❌ Local clone failed: ${err.message}`);
  failed++;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

section("Cleanup");

try {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  assert(!existsSync(TEMP_ROOT), "Temp directory cleaned up");
} catch (err) {
  console.error(`  ⚠️ Cleanup failed (non-fatal): ${err.message}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`🏴‍☠️ Fork Isolation Smoke Test: ${passed} passed, ${failed} failed`);
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
