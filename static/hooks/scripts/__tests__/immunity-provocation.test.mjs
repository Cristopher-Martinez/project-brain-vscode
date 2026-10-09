/**
 * immunity-provocation.test.mjs — End-to-end provocation tests.
 * Runs all 5 immunity rules through the REAL pre-tool-security.mjs pipeline.
 *
 * Run: node --test .github/hooks/scripts/__tests__/immunity-provocation.test.mjs
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempWorkspace, runHook, assertValidHookOutput } from "./test-helper.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const HOOK = "pre-tool-security.mjs";
const REAL_INDEX = resolve(__dirname, "..", "lib", "core-error-index.json");

let tmpDir;
let cleanup;

describe("immunity-provocation (full pipeline)", () => {
  before(() => {
    ({ tmpDir, cleanup } = createTempWorkspace());

    // Copy real core-error-index.json into temp workspace
    const libDir = join(tmpDir, ".github", "hooks", "scripts", "lib");
    mkdirSync(libDir, { recursive: true });
    cpSync(REAL_INDEX, join(libDir, "core-error-index.json"));

    // Create immunity metrics directory
    const metricsDir = join(tmpDir, "docs", "memory", "immunity");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "immunity-metrics.json"),
      JSON.stringify({
        totalActivations: 0,
        deniesIssued: 0,
        asksIssued: 0,
        rulesTriggered: {},
        lastEvaluation: null,
      }),
    );
  });

  after(() => {
    cleanup?.();
  });

  // ══════════════════════════════════════════════════════════════
  // PROVOCATION 1: E-DEPLOY-01 — Copy dist/ without package.json
  // ══════════════════════════════════════════════════════════════

  it("PROVOCATION E-DEPLOY-01: Copy-Item dist/ → DENY", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "run_in_terminal",
      tool_input: {
        command: "Copy-Item -Path dist/* -Destination C:\\Users\\ext\\project-brain\\",
      },
    });
    assertValidHookOutput(output, HOOK);
    // Immunity deny sets continue:false — pipeline terminates
    assert.equal(output.continue, false, "Deny should set continue:false");
    assert.equal(
      output.hookSpecificOutput?.permissionDecision,
      "deny",
      "E-DEPLOY-01 should deny",
    );
    assert.ok(
      output.hookSpecificOutput?.permissionDecisionReason?.includes("E-DEPLOY-01"),
      "Reason should mention E-DEPLOY-01",
    );
  });

  // ══════════════════════════════════════════════════════════════
  // PROVOCATION 2: E-CONFIG-01 — New tool class without enum
  // ══════════════════════════════════════════════════════════════

  it("PROVOCATION E-CONFIG-01: new Tool class in lm-tools → ASK", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "create_file",
      tool_input: {
        filePath: "src/lm-tools-new-experiment.ts",
        content: `import * as vscode from 'vscode';
export class ExperimentTool extends vscode.LanguageModelTool<{}> {
  async invoke() { return {}; }
}`,
      },
    });
    assertValidHookOutput(output, HOOK);
    assert.equal(output.continue, true);
    assert.equal(
      output.hookSpecificOutput?.permissionDecision,
      "ask",
      "E-CONFIG-01 should ask",
    );
    assert.ok(
      output.hookSpecificOutput?.permissionDecisionReason?.includes("E-CONFIG-01"),
      "Reason should mention E-CONFIG-01",
    );
  });

  // ══════════════════════════════════════════════════════════════
  // PROVOCATION 3: E-CONFIG-02 — languageModelTools edit
  // ══════════════════════════════════════════════════════════════

  it("PROVOCATION E-CONFIG-02: languageModelTools edit → ASK", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "replace_string_in_file",
      tool_input: {
        filePath: "package.json",
        oldString: '"languageModelTools": [',
        newString: '"languageModelTools": [\n  { "name": "projectBrain_newTool" },',
      },
    });
    assertValidHookOutput(output, HOOK);
    assert.equal(output.continue, true);
    assert.equal(
      output.hookSpecificOutput?.permissionDecision,
      "ask",
      "E-CONFIG-02 should ask",
    );
  });


  // ══════════════════════════════════════════════════════════════
  // NEGATIVE: Safe operations should pass through
  // ══════════════════════════════════════════════════════════════

  it("NEGATIVE: npm run compile → ALLOW (no immunity trigger)", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "run_in_terminal",
      tool_input: { command: "npm run compile" },
    });
    assertValidHookOutput(output, HOOK);
    assert.equal(output.continue, true);
    // No permissionDecision = allowed through
    const decision = output.hookSpecificOutput?.permissionDecision;
    assert.ok(!decision || decision === "allow", "Safe command should pass");
  });

  it("NEGATIVE: npm run deploy → ALLOW (proper deploy)", async () => {
    const { output } = await runHook(HOOK, {
      cwd: tmpDir,
      tool_name: "run_in_terminal",
      tool_input: { command: "npm run deploy" },
    });
    assertValidHookOutput(output, HOOK);
    assert.equal(output.continue, true);
    const decision = output.hookSpecificOutput?.permissionDecision;
    assert.ok(!decision || decision === "allow", "npm run deploy should pass");
  });

  // ══════════════════════════════════════════════════════════════
  // METRICS: Verify activations were recorded
  // ══════════════════════════════════════════════════════════════

  it("METRICS: activations recorded correctly", () => {
    const metricsPath = join(tmpDir, "docs", "memory", "immunity", "immunity-metrics.json");
    assert.ok(existsSync(metricsPath), "Metrics file should exist");

    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    // 3 rules remain: E-DEPLOY-01, E-CONFIG-01, E-CONFIG-02.
    assert.ok(metrics.totalActivations >= 3, `Expected \u22653 activations, got ${metrics.totalActivations}`);
    assert.ok(metrics.deniesIssued >= 1, `Expected \u22651 deny (E-DEPLOY-01), got ${metrics.deniesIssued}`);
    assert.ok(metrics.asksIssued >= 2, `Expected \u22652 asks, got ${metrics.asksIssued}`);
    assert.ok(metrics.rulesTriggered["E-DEPLOY-01"] >= 1, "E-DEPLOY-01 should be triggered");
    assert.ok(metrics.rulesTriggered["E-CONFIG-01"] >= 1, "E-CONFIG-01 should be triggered");
    assert.ok(metrics.rulesTriggered["E-CONFIG-02"] >= 1, "E-CONFIG-02 should be triggered");
    assert.ok(metrics.lastEvaluation, "lastEvaluation should be set");
  });
});
