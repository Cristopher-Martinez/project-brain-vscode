/**
 * Baseline tests for quality gates integration in audit-gate.mjs.
 * These tests verify that 3 new strategies are correctly integrated:
 * 1. TypeScript Compilation Gate (tsc --noEmit)
 * 2. Test Execution Gate (run tests for edited modules)
 * 3. Self-Explanation Requirement (rubber duck debugging in round 0)
 *
 * These tests are designed to FAIL until the integrations are implemented.
 */
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "path";

// Dynamic import to get audit-gate exports
let auditGate;

const TEST_CWD = join(process.cwd(), "__test_audit_quality_tmp__");
const TEST_SESSION = "test-quality-session-001";

describe("Quality Gates Integration — Baseline Tests", () => {
  before(async () => {
    auditGate = await import("../lib/audit-gate.mjs");
    // Create temp workspace
    mkdirSync(TEST_CWD, { recursive: true });
  });

  after(() => {
    try {
      rmSync(TEST_CWD, { recursive: true, force: true });
    } catch {}
  });

  // ═══════════════════════════════════════════════════════════
  // 1. TSC COMPILATION GATE
  // ═══════════════════════════════════════════════════════════

  describe("TSC Compilation Gate", () => {
    it("exports runTscCheck function", () => {
      assert.equal(
        typeof auditGate.runTscCheck,
        "function",
        "runTscCheck must be exported from audit-gate.mjs",
      );
    });

    it("runTscCheck returns { pass, output } object", () => {
      // runTscCheck should return an object with pass (boolean) and output (string)
      const result = auditGate.runTscCheck(TEST_CWD);
      assert.equal(
        typeof result,
        "object",
        "runTscCheck must return an object",
      );
      assert.equal(
        typeof result.pass,
        "boolean",
        "runTscCheck result must have 'pass' boolean",
      );
      assert.equal(
        typeof result.output,
        "string",
        "runTscCheck result must have 'output' string",
      );
    });

    it("evaluateAuditGate denies when TSC fails and round > 0", () => {
      // Use the REAL project root — it has TypeScript installed in node_modules
      // We go from __tests__ → scripts → hooks → .github → project-root
      const realRoot = join(import.meta.dirname, "..", "..", "..", "..");
      // Must be inside src/ because tsconfig.json has include: ["src/**/*"]
      const tempBadFile = join(realRoot, "src", "_test_bad_tsc_temp_.ts");
      const sessionDir = join(
        realRoot,
        ".project-brain",
        "loops",
        TEST_SESSION,
      );
      mkdirSync(sessionDir, { recursive: true });

      // Create a TypeScript file with a SYNTAX error inside src/
      // (Type errors are not reported when pre-existing syntax errors exist in other files)
      writeFileSync(tempBadFile, "const x: number = ;");

      // Write audit state with the bad file in editedFiles
      writeFileSync(
        join(sessionDir, "audit-state.json"),
        JSON.stringify({
          editedFiles: ["src/_test_bad_tsc_temp_.ts"],
          auditRound: 1,
          lastAuditTs: Date.now(),
          synthesisAttempts: 1,
          urgentMessages: [],
        }),
      );

      // Write a classification to bypass normal round logic
      writeFileSync(
        join(sessionDir, "audit-classification.json"),
        JSON.stringify({
          verdict: "no-audit",
          reason: "test baseline",
          ts: Date.now(),
        }),
      );

      try {
        const result = auditGate.evaluateAuditGate(
          realRoot,
          TEST_SESSION,
          "test synthesis",
        );

        // Should deny due to TSC failure in agent-edited file
        assert.equal(
          result.decision,
          "deny",
          "evaluateAuditGate should deny when TSC fails",
        );
        assert.ok(
          result.context.includes("TSC") ||
            result.context.includes("tsc") ||
            result.context.includes("compilación") ||
            result.context.includes("COMPILATION"),
          "deny context should mention TSC/compilation",
        );
      } finally {
        // Clean up temp files
        try {
          unlinkSync(tempBadFile);
        } catch {}
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. TEST EXECUTION GATE
  // ═══════════════════════════════════════════════════════════

  describe("Test Execution Gate", () => {
    it("exports runTestsForModules function", () => {
      assert.equal(
        typeof auditGate.runTestsForModules,
        "function",
        "runTestsForModules must be exported from audit-gate.mjs",
      );
    });

    it("runTestsForModules returns { pass, output, testsFound } object", () => {
      const result = auditGate.runTestsForModules(TEST_CWD, ["nonexistent.ts"]);
      assert.equal(typeof result, "object", "Must return an object");
      assert.equal(typeof result.pass, "boolean", "Must have 'pass' boolean");
      assert.equal(typeof result.output, "string", "Must have 'output' string");
      assert.equal(
        typeof result.testsFound,
        "boolean",
        "Must have 'testsFound' boolean",
      );
    });

    it("runTestsForModules returns pass=true and testsFound=false when no tests exist", () => {
      const result = auditGate.runTestsForModules(TEST_CWD, [
        "imaginary-module.ts",
      ]);
      // When no tests exist for the module, it should pass (no tests = no failures)
      assert.equal(result.pass, true, "Should pass when no tests found");
      assert.equal(result.testsFound, false, "Should report no tests found");
    });

    it("evaluateAuditGate context mentions test results when tests exist", () => {
      // This test verifies integration — when tests exist and are mentioned
      // in the audit gate evaluation, the context should reflect it
      const sessionDir = join(
        TEST_CWD,
        ".project-brain",
        "loops",
        TEST_SESSION,
      );
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        join(sessionDir, "audit-state.json"),
        JSON.stringify({
          editedFiles: ["some-module.ts", "some-module.test.mjs"],
          auditRound: 2,
          lastAuditTs: Date.now(),
          synthesisAttempts: 2,
          urgentMessages: [],
        }),
      );

      writeFileSync(
        join(sessionDir, "audit-classification.json"),
        JSON.stringify({
          verdict: "no-audit",
          reason: "test baseline",
          ts: Date.now(),
        }),
      );

      // Remove broken TS file from previous test
      try {
        rmSync(join(TEST_CWD, "nonexistent-file-abc123.ts"), { force: true });
        rmSync(join(TEST_CWD, "tsconfig.json"), { force: true });
      } catch {}

      const result = auditGate.evaluateAuditGate(
        TEST_CWD,
        TEST_SESSION,
        "test synthesis",
      );

      // When all quality gates pass, should allow
      // (discipline, tsc, tests should all pass when no real src files exist)
      assert.equal(
        result.decision,
        "allow",
        "Should allow when all quality gates pass",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. SELF-EXPLANATION REQUIREMENT
  // ═══════════════════════════════════════════════════════════

  describe("Self-Explanation Requirement (Rubber Duck Debugging)", () => {
    it("round 0 deny message includes self-explanation requirement", () => {
      // Setup: audit state at round 0 with edited files
      const sessionDir = join(
        TEST_CWD,
        ".project-brain",
        "loops",
        TEST_SESSION,
      );
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        join(sessionDir, "audit-state.json"),
        JSON.stringify({
          editedFiles: ["index.ts"],
          auditRound: 0,
          lastAuditTs: null,
          synthesisAttempts: 0,
          urgentMessages: [],
        }),
      );

      // Remove classification so round 0 logic triggers
      try {
        rmSync(join(sessionDir, "audit-classification.json"), { force: true });
      } catch {}

      const result = auditGate.evaluateAuditGate(
        TEST_CWD,
        TEST_SESSION,
        "test synthesis",
      );

      assert.equal(result.decision, "deny", "Round 0 should deny");

      // The deny message must require self-explanation
      const ctx = result.context.toLowerCase();
      const hasExplanation =
        ctx.includes("explicar") ||
        ctx.includes("explica") ||
        ctx.includes("explain") ||
        ctx.includes("rubber duck") ||
        ctx.includes("por qué") ||
        ctx.includes("justifica");

      assert.ok(
        hasExplanation,
        `Round 0 deny must require self-explanation of changes. Got: ${result.context.substring(0, 200)}`,
      );
    });

    it("round 0 deny mentions each edited file by name", () => {
      const sessionDir = join(
        TEST_CWD,
        ".project-brain",
        "loops",
        TEST_SESSION,
      );

      writeFileSync(
        join(sessionDir, "audit-state.json"),
        JSON.stringify({
          editedFiles: ["alpha.ts", "beta.ts"],
          auditRound: 0,
          lastAuditTs: null,
          synthesisAttempts: 0,
          urgentMessages: [],
        }),
      );

      const result = auditGate.evaluateAuditGate(
        TEST_CWD,
        TEST_SESSION,
        "test synthesis",
      );

      assert.equal(result.decision, "deny");
      assert.ok(
        result.context.includes("alpha.ts"),
        "Deny must list edited file alpha.ts",
      );
      assert.ok(
        result.context.includes("beta.ts"),
        "Deny must list edited file beta.ts",
      );
    });
  });
});
