#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Branch Isolation + Worktree
 *
 * Tests the complete loop isolation flow:
 *   1. Create a temp git repo
 *   2. Create loop branch + worktree (simulates createLoopBranch)
 *   3. Verify worktree is on the correct branch
 *   4. Create a file in the worktree — verify it's NOT in main repo
 *   5. Auto-commit in worktree (simulates autoCommitWorktree)
 *   6. Remove worktree (simulates removeWorktree)
 *   7. Verify branch still has the committed changes
 *   8. Merge branch into main (simulates mergeBranch)
 *   9. Verify merged file appears in main
 *  10. Test discard flow: create new branch + worktree, discard it
 *  11. Verify branch is deleted and worktree is gone
 *  12. Clean up temp directory
 *
 * Usage:
 *   node scripts/smoke-test-isolation.mjs
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Config ──────────────────────────────────────────────────────────────────

const TEMP_ROOT = join(tmpdir(), `brain-isolation-test-${Date.now()}`);
const WORKTREE_BASE = ".brain-loops";
const SESSION_ID = "test-session-abc123";
const BRANCH_NAME = `brain/loop/smoke-${SESSION_ID.slice(0, 8)}`;
const UNIQUE_CONTENT = `ISOLATION_TEST_${Date.now()}`;

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

section("Setup: Creating temp git repo");

mkdirSync(TEMP_ROOT, { recursive: true });
git(TEMP_ROOT, ["init"]);
git(TEMP_ROOT, ["config", "user.email", "test@brain.dev"]);
git(TEMP_ROOT, ["config", "user.name", "Brain Test"]);

// Create initial commit so we have a valid HEAD
writeFileSync(join(TEMP_ROOT, "README.md"), "# Test Repo\n");
git(TEMP_ROOT, ["add", "."]);
git(TEMP_ROOT, ["commit", "-m", "Initial commit"]);

const originalBranch = git(TEMP_ROOT, ["branch", "--show-current"]);
console.log(`  Repo: ${TEMP_ROOT}`);
console.log(`  Branch: ${originalBranch}`);
assert(existsSync(join(TEMP_ROOT, ".git")), "Git repo created");

// ─── Test 1: Create loop branch + worktree ───────────────────────────────────

section("Test 1: Create loop branch + worktree");

try {
  // Simulate createLoopBranch
  git(TEMP_ROOT, ["branch", BRANCH_NAME]);
  const worktreePath = join(TEMP_ROOT, WORKTREE_BASE, SESSION_ID);
  mkdirSync(join(TEMP_ROOT, WORKTREE_BASE), { recursive: true });
  git(TEMP_ROOT, ["worktree", "add", worktreePath, BRANCH_NAME]);

  assert(existsSync(worktreePath), "Worktree directory created");

  const worktreeBranch = git(worktreePath, ["branch", "--show-current"]);
  assert(
    worktreeBranch === BRANCH_NAME,
    `Worktree on correct branch (${worktreeBranch})`,
  );

  const mainBranch = git(TEMP_ROOT, ["branch", "--show-current"]);
  assert(
    mainBranch === originalBranch,
    `Main repo still on original branch (${mainBranch})`,
  );

  // ─── Test 2: File isolation ────────────────────────────────────────────────

  section("Test 2: File isolation");

  const testFile = "isolation-test.txt";
  writeFileSync(join(worktreePath, testFile), UNIQUE_CONTENT);
  assert(
    existsSync(join(worktreePath, testFile)),
    "File exists in worktree",
  );
  assert(
    !existsSync(join(TEMP_ROOT, testFile)),
    "File does NOT exist in main repo (isolated!)",
  );

  // ─── Test 3: Auto-commit in worktree ───────────────────────────────────────

  section("Test 3: Auto-commit in worktree");

  const statusBefore = git(worktreePath, ["status", "--porcelain"]);
  assert(statusBefore.length > 0, "Worktree has uncommitted changes");

  git(worktreePath, ["add", "-A"]);
  git(worktreePath, [
    "commit",
    "-m",
    `[brain] Auto-commit loop ${SESSION_ID}`,
  ]);

  const statusAfter = git(worktreePath, ["status", "--porcelain"]);
  assert(statusAfter.length === 0, "Worktree clean after auto-commit");

  const commitLog = git(worktreePath, ["log", "--oneline", "-1"]);
  assert(
    commitLog.includes("[brain] Auto-commit"),
    `Commit message correct: ${commitLog}`,
  );

  // ─── Test 4: Remove worktree ───────────────────────────────────────────────

  section("Test 4: Remove worktree");

  git(TEMP_ROOT, ["worktree", "remove", worktreePath, "--force"]);
  assert(!existsSync(worktreePath), "Worktree directory removed");

  // Verify branch still exists with the commit
  const branchCommit = git(TEMP_ROOT, [
    "log",
    BRANCH_NAME,
    "--oneline",
    "-1",
  ]);
  assert(
    branchCommit.includes("[brain] Auto-commit"),
    `Branch retains commit: ${branchCommit}`,
  );

  // ─── Test 5: Merge branch ─────────────────────────────────────────────────

  section("Test 5: Merge branch into main");

  git(TEMP_ROOT, ["merge", BRANCH_NAME, "--no-ff", "-m", "Merge loop"]);
  assert(
    existsSync(join(TEMP_ROOT, testFile)),
    "Merged file now exists in main repo",
  );

  const mergedContent = readFileSync(
    join(TEMP_ROOT, testFile),
    "utf-8",
  );
  assert(
    mergedContent === UNIQUE_CONTENT,
    "Merged file has correct content",
  );

  // Clean up merged branch
  git(TEMP_ROOT, ["branch", "-d", BRANCH_NAME]);
  const branches = git(TEMP_ROOT, ["branch", "--list", BRANCH_NAME]);
  assert(
    branches.trim().length === 0,
    "Branch deleted after merge",
  );
} catch (err) {
  console.error(`  💀 Test 1-5 failed with error: ${err.message}`);
  failed++;
}

// ─── Test 6: Discard flow ────────────────────────────────────────────────────

section("Test 6: Discard branch + worktree");

const DISCARD_SESSION = "test-discard-xyz";
const DISCARD_BRANCH = `brain/loop/discard-${DISCARD_SESSION.slice(0, 8)}`;

try {
  // Create branch + worktree
  git(TEMP_ROOT, ["branch", DISCARD_BRANCH]);
  const discardWorktree = join(TEMP_ROOT, WORKTREE_BASE, DISCARD_SESSION);
  git(TEMP_ROOT, ["worktree", "add", discardWorktree, DISCARD_BRANCH]);

  // Make a change in the worktree
  writeFileSync(join(discardWorktree, "discard-me.txt"), "this will be lost");
  git(discardWorktree, ["add", "-A"]);
  git(discardWorktree, ["commit", "-m", "doomed commit"]);

  assert(existsSync(discardWorktree), "Discard worktree exists");

  // Simulate discardBranch: remove worktree FIRST, then delete branch
  git(TEMP_ROOT, ["worktree", "remove", discardWorktree, "--force"]);
  assert(!existsSync(discardWorktree), "Discard worktree removed");

  git(TEMP_ROOT, ["branch", "-D", DISCARD_BRANCH]);
  const discardBranches = git(TEMP_ROOT, [
    "branch",
    "--list",
    DISCARD_BRANCH,
  ]);
  assert(
    discardBranches.trim().length === 0,
    "Discarded branch deleted",
  );
  assert(
    !existsSync(join(TEMP_ROOT, "discard-me.txt")),
    "Discarded file does NOT exist in main repo",
  );
} catch (err) {
  console.error(`  💀 Test 6 failed with error: ${err.message}`);
  failed++;
}

// ─── Test 7: Gatekeeper static rules ─────────────────────────────────────────

section("Test 7: Gatekeeper pattern matching (static)");

// Simulate the regex patterns from command-gatekeeper.ts
const CHECKOUT_PATTERNS = [
  /git[_-]?checkout/i,
  /git[_-]?switch/i,
  /checkout[_-]?branch/i,
  /switch[_-]?branch/i,
];

const COMMAND_EXEC_PATTERNS = [
  /execute[_-]?command/i,
  /run[_-]?command/i,
  /run[_-]?in[_-]?terminal/i,
  /shell[_-]?exec/i,
  /run[_-]?code/i,
];

function isCheckoutTool(name) {
  return CHECKOUT_PATTERNS.some((p) => p.test(name));
}

function isCommandExecTool(name) {
  return COMMAND_EXEC_PATTERNS.some((p) => p.test(name));
}

// Checkout tool detection
assert(isCheckoutTool("mcp_gitkraken_git_checkout"), "Catches gitkraken checkout");
assert(isCheckoutTool("mcp_some_git-checkout"), "Catches generic git-checkout");
assert(isCheckoutTool("mcp_tool_git_switch"), "Catches git_switch");
assert(isCheckoutTool("checkout_branch"), "Catches checkout_branch");
assert(isCheckoutTool("switch_branch"), "Catches switch_branch");
assert(!isCheckoutTool("mcp_gitkraken_git_push"), "Does NOT catch git_push");
assert(!isCheckoutTool("mcp_gitkraken_git_status"), "Does NOT catch git_status");
assert(!isCheckoutTool("mcp_gitkraken_git_log_or_diff"), "Does NOT catch git_log");

// Command exec detection
assert(isCommandExecTool("mcp_tool_execute_command"), "Catches execute_command");
assert(isCommandExecTool("run_in_terminal"), "Catches run_in_terminal");
assert(isCommandExecTool("mcp_tool_shell_exec"), "Catches shell_exec");
assert(isCommandExecTool("mcp_tool_run_code"), "Catches run_code");
assert(!isCommandExecTool("mcp_tool_read_file"), "Does NOT catch read_file");

// Static command evaluation
const BRANCH_REGEX = /\bgit\s+(checkout|switch)\b/i;
const CHECKOUT_CREATE_REGEX = /\bgit\s+checkout\s+-[bB]\b/i;

function evalStatic(cmd) {
  if (CHECKOUT_CREATE_REGEX.test(cmd)) return "allow"; // creating branch
  if (BRANCH_REGEX.test(cmd)) return "deny"; // switching branch
  return null; // unknown
}

assert(evalStatic("git checkout main") === "deny", "Blocks 'git checkout main'");
assert(evalStatic("git switch develop") === "deny", "Blocks 'git switch develop'");
assert(evalStatic("git checkout -b new-feature") === "allow", "Allows 'git checkout -b new-feature'");
assert(evalStatic("git checkout -B hotfix") === "allow", "Allows 'git checkout -B hotfix'");
assert(evalStatic("echo hello") === null, "Ignores unrelated commands");
assert(evalStatic("git push origin main") === null, "Ignores git push");

// ─── Cleanup ─────────────────────────────────────────────────────────────────

section("Cleanup");

try {
  // Prune any remaining worktrees
  git(TEMP_ROOT, ["worktree", "prune"]);
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  assert(!existsSync(TEMP_ROOT), "Temp directory cleaned up");
} catch (err) {
  console.error(`  ⚠️ Cleanup warning: ${err.message}`);
}

// ─── Results ─────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`🏴‍☠️ RESULTS: ${passed} passed, ${failed} failed`);
console.log("═".repeat(60));

if (failed > 0) {
  console.error("\n💀 Some tests failed! Check the output above.");
  process.exit(1);
} else {
  console.log("\n🏴‍☠️ ¡Tierra a la vista! All isolation tests passed.");
  process.exit(0);
}
