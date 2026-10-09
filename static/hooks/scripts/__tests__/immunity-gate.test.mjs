/**
 * immunity-gate.test.mjs — Unit tests for the immunity gate.
 * Tests binary matching logic, decision routing, and edge cases.
 *
 * Run: node --test .github/hooks/scripts/__tests__/immunity-gate.test.mjs
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {string} */
let tempDir;
/** @type {string} */
let libDir;
/** @type {string} */
let metricsDir;

// We'll dynamically import the module to set cwd correctly
/** @type {typeof import('../lib/immunity-gate.mjs').evaluateImmunityGate} */
let evaluateImmunityGate;

/**
 * Create a minimal error index for testing.
 * @param {string} dir - lib directory
 * @param {Array<Object>} [errors] - custom errors (uses defaults if not provided)
 */
function writeTestIndex(dir, errors) {
  const defaultErrors = [
    {
      id: "E-DEPLOY-01",
      title: "Deploy sin package.json",
      zone: "deploy",
      severity: "critical",
      decision: "deny",
      triggerTools: ["run_in_terminal"],
      triggerPaths: ["dist/", "dist\\\\"],
      triggerPatterns: ["Copy-Item.*dist", "copy.*dist"],
      negativePatterns: ["package\\.json"],
      message: "IMMUNITY E-DEPLOY-01: Deploy sin package.json detectado.",
    },
    {
      id: "E-CONFIG-01",
      title: "Tool registrada sin package.json enum",
      zone: "config",
      severity: "high",
      decision: "ask",
      triggerTools: ["create_file", "replace_string_in_file"],
      triggerPaths: ["src/lm-tools-*.ts"],
      triggerPatterns: ["class\\s+\\w+Tool\\s+extends"],
      negativePatterns: [],
      message: "IMMUNITY E-CONFIG-01: Posible tool nueva detectada.",
    },
    {
      id: "E-CONFIG-02",
      title: "Tool en package.json pero no en .agent.md",
      zone: "config",
      severity: "high",
      decision: "ask",
      triggerTools: ["create_file", "replace_string_in_file", "multi_replace_string_in_file"],
      triggerPaths: ["package.json"],
      triggerPatterns: ["languageModelTools"],
      negativePatterns: [],
      message: "IMMUNITY E-CONFIG-02: Cambio en languageModelTools detectado.",
    },
  ];

  const index = {
    "$schema": "Core Error Index — Test",
    version: "1.0.0",
    errors: errors || defaultErrors,
  };

  writeFileSync(join(dir, "core-error-index.json"), JSON.stringify(index, null, 2));
}

describe("immunity-gate", () => {
  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "immunity-test-"));
    libDir = join(tempDir, ".github", "hooks", "scripts", "lib");
    metricsDir = join(tempDir, "docs", "memory", "immunity");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(metricsDir, { recursive: true });
    writeTestIndex(libDir);

    // Dynamic import
    const mod = await import("../lib/immunity-gate.mjs");
    evaluateImmunityGate = mod.evaluateImmunityGate;
  });

  after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
  });

  // ═══ E-DEPLOY-01: Copy-Item dist/ without package.json ═══

  it("E-DEPLOY-01: detects Copy-Item dist/ without package.json → deny", () => {
    const result = evaluateImmunityGate({
      toolName: "run_in_terminal",
      toolInput: { command: "Copy-Item -Path dist/* -Destination C:\\ext\\project-brain\\" },
      cwd: tempDir,
    });
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "E-DEPLOY-01");
  });

  it("E-DEPLOY-01: allows deploy when package.json is included", () => {
    const result = evaluateImmunityGate({
      toolName: "run_in_terminal",
      toolInput: { command: "Copy-Item -Path dist/*,package.json -Destination C:\\ext\\" },
      cwd: tempDir,
    });
    assert.equal(result.decision, "allow");
  });

  // ═══ E-CONFIG-01: Tool class without package.json enum ═══

  it("E-CONFIG-01: detects new tool class in lm-tools-*.ts → ask", () => {
    const result = evaluateImmunityGate({
      toolName: "create_file",
      toolInput: {
        filePath: "src/lm-tools-new-feature.ts",
        content: "export class NewFeatureTool extends vscode.LanguageModelTool {}",
      },
      cwd: tempDir,
    });
    assert.equal(result.decision, "ask");
    assert.equal(result.ruleId, "E-CONFIG-01");
  });

  it("E-CONFIG-01: no trigger on regular .ts file", () => {
    const result = evaluateImmunityGate({
      toolName: "create_file",
      toolInput: {
        filePath: "src/utils.ts",
        content: "export function helper() { return 42; }",
      },
      cwd: tempDir,
    });
    assert.equal(result.decision, "allow");
  });

  // ═══ E-CONFIG-02: package.json languageModelTools edit ═══

  it("E-CONFIG-02: detects languageModelTools edit in package.json → ask", () => {
    const result = evaluateImmunityGate({
      toolName: "replace_string_in_file",
      toolInput: {
        filePath: "package.json",
        oldString: '"languageModelTools": [',
        newString: '"languageModelTools": [\n  { "name": "newTool" },',
      },
      cwd: tempDir,
    });
    assert.equal(result.decision, "ask");
    assert.equal(result.ruleId, "E-CONFIG-02");
  });

  // ═══ No false positives ═══

  it("no false positive: editing normal .ts file outside trigger zones", () => {
    const result = evaluateImmunityGate({
      toolName: "replace_string_in_file",
      toolInput: {
        filePath: "src/extension.ts",
        oldString: "const x = 1;",
        newString: "const x = 2;",
      },
      cwd: tempDir,
    });
    assert.equal(result.decision, "allow");
  });

  it("no false positive: terminal command unrelated to deploy", () => {
    const result = evaluateImmunityGate({
      toolName: "run_in_terminal",
      toolInput: { command: "npm run compile" },
      cwd: tempDir,
    });
    assert.equal(result.decision, "allow");
  });

  // ═══ Edge cases ═══

  it("graceful fallback: missing core-error-index.json → allow", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "immunity-empty-"));
    try {
      const result = evaluateImmunityGate({
        toolName: "run_in_terminal",
        toolInput: { command: "Copy-Item dist/ somewhere" },
        cwd: emptyDir,
      });
      assert.equal(result.decision, "allow");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("max 1 activation: returns first matching rule only", () => {
    // E-CONFIG-01 matches: create_file on src/lm-tools-*.ts with class pattern.
    // Verifies that only one rule fires even if multiple could match.
    const result = evaluateImmunityGate({
      toolName: "create_file",
      toolInput: {
        filePath: "src/lm-tools-new.ts",
        content: 'class NewTool extends BaseTool { invoke() { return "ok"; } }',
      },
      cwd: tempDir,
    });
    assert.equal(result.decision, "ask");
    assert.equal(result.ruleId, "E-CONFIG-01");
  });

  // ═══ Metrics recording ═══

  it("records activation in immunity-metrics.json", () => {
    // Reset metrics
    const metricsPath = join(tempDir, "docs", "memory", "immunity", "immunity-metrics.json");
    writeFileSync(metricsPath, JSON.stringify({ totalActivations: 0, deniesIssued: 0, asksIssued: 0, rulesTriggered: {}, lastEvaluation: null }));

    evaluateImmunityGate({
      toolName: "run_in_terminal",
      toolInput: { command: "Copy-Item dist/ C:\\somewhere\\" },
      cwd: tempDir,
    });

    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    assert.equal(metrics.totalActivations, 1);
    assert.equal(metrics.deniesIssued, 1);
    assert.equal(metrics.rulesTriggered["E-DEPLOY-01"], 1);
    assert.ok(metrics.lastEvaluation);
  });
});
