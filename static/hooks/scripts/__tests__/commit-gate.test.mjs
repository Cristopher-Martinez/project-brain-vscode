/**
 * Tests for commit-gate.mjs — commit policy enforcement.
 * Covers state I/O, bypass toggle, file threshold, and isCodeChange filter.
 */
import { mkdirSync, rmSync } from "fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "path";

let commitGate;

const TEST_CWD = join(process.cwd(), "__test_commit_gate_tmp__");
const TEST_SESSION = "test-commit-session-001";

describe("Commit Gate", () => {
  before(async () => {
    commitGate = await import("../lib/commit-gate.mjs");
    mkdirSync(TEST_CWD, { recursive: true });
  });

  after(() => {
    try {
      rmSync(TEST_CWD, { recursive: true, force: true });
    } catch {}
  });

  // ═══════════════════════════════════════════
  // 1. EXPORT VERIFICATION
  // ═══════════════════════════════════════════

  describe("Exports", () => {
    it("exports readCommitState", () => {
      assert.equal(typeof commitGate.readCommitState, "function");
    });

    it("exports writeCommitState", () => {
      assert.equal(typeof commitGate.writeCommitState, "function");
    });

    it("exports recordCommitEdit", () => {
      assert.equal(typeof commitGate.recordCommitEdit, "function");
    });

    it("exports evaluateCommitGate", () => {
      assert.equal(typeof commitGate.evaluateCommitGate, "function");
    });

    it("exports generateCommitMessage", () => {
      assert.equal(typeof commitGate.generateCommitMessage, "function");
    });

    it("exports getGitStatus", () => {
      assert.equal(typeof commitGate.getGitStatus, "function");
    });

    it("exports getCurrentBranch", () => {
      assert.equal(typeof commitGate.getCurrentBranch, "function");
    });
  });

  // ═══════════════════════════════════════════
  // 2. STATE I/O
  // ═══════════════════════════════════════════

  describe("State I/O", () => {
    it("readCommitState returns default state for new session", () => {
      const state = commitGate.readCommitState(TEST_CWD, "nonexistent-session");
      assert.ok(state, "should return an object");
      assert.ok(Array.isArray(state.editedSinceCommit), "editedSinceCommit should be array");
      assert.equal(state.editedSinceCommit.length, 0);
    });

    it("writeCommitState + readCommitState roundtrip", () => {
      const testState = {
        editedSinceCommit: ["src/foo.ts", "src/bar.ts"],
        lastCommitTs: Date.now(),
        commitBypass: false,
      };
      commitGate.writeCommitState(TEST_CWD, TEST_SESSION, testState);
      const read = commitGate.readCommitState(TEST_CWD, TEST_SESSION);
      assert.deepEqual(read.editedSinceCommit, testState.editedSinceCommit);
      assert.equal(read.lastCommitTs, testState.lastCommitTs);
    });

    it("recordCommitEdit accumulates files without duplicates", () => {
      // Reset state
      commitGate.writeCommitState(TEST_CWD, TEST_SESSION, {
        editedSinceCommit: [],
        lastCommitTs: null,
        commitBypass: false,
      });
      commitGate.recordCommitEdit(TEST_CWD, TEST_SESSION, ["src/a.ts"]);
      commitGate.recordCommitEdit(TEST_CWD, TEST_SESSION, ["src/b.ts", "src/a.ts"]);
      const state = commitGate.readCommitState(TEST_CWD, TEST_SESSION);
      // recordCommitEdit stores basename only
      assert.equal(state.editedSinceCommit.length, 2, "should have 2 unique files");
      assert.ok(state.editedSinceCommit.includes("a.ts"));
      assert.ok(state.editedSinceCommit.includes("b.ts"));
    });
  });

  // ═══════════════════════════════════════════
  // 3. BYPASS TOGGLE
  // ═══════════════════════════════════════════

  describe("Bypass Toggle", () => {
    it("setCommitBypass + getCommitBypass roundtrip", () => {
      commitGate.setCommitBypass(TEST_CWD, TEST_SESSION, true);
      assert.equal(commitGate.getCommitBypass(TEST_CWD, TEST_SESSION), true);
      commitGate.setCommitBypass(TEST_CWD, TEST_SESSION, false);
      assert.equal(commitGate.getCommitBypass(TEST_CWD, TEST_SESSION), false);
    });

    it("evaluateCommitGate allows when bypass is enabled", () => {
      commitGate.writeCommitState(TEST_CWD, TEST_SESSION, {
        editedSinceCommit: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
        lastCommitTs: null,
        commitBypass: true,
      });
      const result = commitGate.evaluateCommitGate(TEST_CWD, TEST_SESSION);
      assert.equal(result.decision, "allow", "bypass should allow even with 6 files");
    });
  });

  // ═══════════════════════════════════════════
  // 4. recordCommitDone CLEARS STATE
  // ═══════════════════════════════════════════

  describe("recordCommitDone", () => {
    it("clears editedSinceCommit and updates lastCommitTs", () => {
      commitGate.writeCommitState(TEST_CWD, TEST_SESSION, {
        editedSinceCommit: ["src/foo.ts"],
        lastCommitTs: null,
        commitBypass: false,
      });
      commitGate.recordCommitDone(TEST_CWD, TEST_SESSION);
      const state = commitGate.readCommitState(TEST_CWD, TEST_SESSION);
      assert.equal(state.editedSinceCommit.length, 0, "should clear edits");
      assert.ok(state.lastCommitTs > 0, "should set lastCommitTs");
    });
  });
});
