/**
 * Tests for Code Discipline v2 checks:
 *  1. Import Existence Guard
 *  2. Dependency Direction Guard
 *  3. Stale Comment Detection
 *  4. Test-Edit Correlation
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  analyzeForDiscipline,
  checkTestEditCorrelation,
} from "../lib/code-discipline.mjs";

const TMP = join(import.meta.dirname, "__tmp_disc_v2__");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "src"), { recursive: true });
  mkdirSync(join(TMP, ".github", "hooks", "scripts", "__tests__"), {
    recursive: true,
  });
  mkdirSync(join(TMP, ".github", "hooks", "scripts", "lib"), {
    recursive: true,
  });
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// 1. IMPORT EXISTENCE GUARD
// ═══════════════════════════════════════════════════════════════════
describe("Import Existence Guard", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("warns on non-existent relative import", () => {
    const fp = join(TMP, "src", "consumer.ts");
    writeFileSync(fp, "import { foo } from './nonexistent-module';\n");
    const code = "import { foo } from './nonexistent-module';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const importWarn = warnings.find((w) => w.includes("IMPORT NOT FOUND"));
    assert.ok(importWarn, "Should warn about nonexistent import");
  });

  it("does NOT warn on existing relative import", () => {
    const target = join(TMP, "src", "helper.ts");
    writeFileSync(target, "export const x = 1;\n");
    const fp = join(TMP, "src", "consumer.ts");
    writeFileSync(fp, "import { x } from './helper';\n");
    const code = "import { x } from './helper';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const importWarn = warnings.find((w) => w.includes("IMPORT NOT FOUND"));
    assert.equal(importWarn, undefined, "Should NOT warn for existing import");
  });

  it("skips package imports (non-relative)", () => {
    const fp = join(TMP, "src", "consumer.ts");
    writeFileSync(fp, "import fs from 'fs';\n");
    const code = "import fs from 'fs';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const importWarn = warnings.find((w) => w.includes("IMPORT NOT FOUND"));
    assert.equal(
      importWarn,
      undefined,
      "Should NOT warn for package imports",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. DEPENDENCY DIRECTION GUARD
// ═══════════════════════════════════════════════════════════════════
describe("Dependency Direction Guard", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("warns when core imports from tools layer", () => {
    const fp = join(TMP, "src", "logger.ts");
    writeFileSync(fp, "import { x } from './lm-tools-memory';\n");
    const code = "import { x } from './lm-tools-memory';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const depWarn = warnings.find((w) => w.includes("DEPENDENCY VIOLATION"));
    assert.ok(depWarn, "Should warn about upward import (core → tools)");
  });

  it("allows tools importing from shared", () => {
    const sharedFile = join(TMP, "src", "lm-tools-shared.ts");
    writeFileSync(sharedFile, "export const x = 1;\n");
    const fp = join(TMP, "src", "lm-tools-memory.ts");
    writeFileSync(fp, "import { x } from './lm-tools-shared';\n");
    const code = "import { x } from './lm-tools-shared';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const depWarn = warnings.find((w) => w.includes("DEPENDENCY VIOLATION"));
    assert.equal(
      depWarn,
      undefined,
      "Tools importing shared = OK (same or lower level)",
    );
  });

  it("skips non-src files", () => {
    const fp = join(TMP, ".github", "hooks", "scripts", "lib", "hook.mjs");
    writeFileSync(fp, "import { x } from './lm-tools-memory.mjs';\n");
    const code = "import { x } from './lm-tools-memory.mjs';\n";
    const warnings = analyzeForDiscipline("", code, fp);
    const depWarn = warnings.find((w) => w.includes("DEPENDENCY VIOLATION"));
    assert.equal(depWarn, undefined, "Non-src files should skip dep check");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. STALE COMMENT DETECTION
// ═══════════════════════════════════════════════════════════════════
describe("Stale Comment Detection", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("warns when function signature changed but JSDoc unchanged", () => {
    const fp = join(TMP, "src", "module.ts");
    const oldContent = `/**
 * Does something.
 * @param a - first param
 */
function doSomething(a: string) {
  return a;
}`;
    const newCode = `function doSomething(a: string, b: number) {`;
    writeFileSync(fp, oldContent);
    const warnings = analyzeForDiscipline(oldContent, newCode, fp);
    const staleWarn = warnings.find((w) => w.includes("STALE COMMENT"));
    assert.ok(staleWarn, "Should warn about potentially stale JSDoc");
  });

  it("does NOT warn when signature is unchanged", () => {
    const fp = join(TMP, "src", "module.ts");
    const content = `/**
 * Does something.
 */
function doSomething(a: string) {
  return a;
}`;
    const newCode = `function doSomething(a: string) {`;
    writeFileSync(fp, content);
    const warnings = analyzeForDiscipline(content, newCode, fp);
    const staleWarn = warnings.find((w) => w.includes("STALE COMMENT"));
    assert.equal(
      staleWarn,
      undefined,
      "Same signature should NOT trigger stale warning",
    );
  });

  it("does NOT warn for new functions (no old match)", () => {
    const fp = join(TMP, "src", "module.ts");
    const content = "const x = 1;\n";
    const newCode = `function brandNew(a: string) {`;
    writeFileSync(fp, content);
    const warnings = analyzeForDiscipline(content, newCode, fp);
    const staleWarn = warnings.find((w) => w.includes("STALE COMMENT"));
    assert.equal(
      staleWarn,
      undefined,
      "New functions should NOT trigger stale warning",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. TEST-EDIT CORRELATION
// ═══════════════════════════════════════════════════════════════════
describe("Test-Edit Correlation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("warns when source edited without test (no test exists)", () => {
    const warnings = checkTestEditCorrelation(["scanner.ts"], TMP);
    const missing = warnings.find((w) => w.includes("TEST MISSING"));
    assert.ok(missing, "Should report TEST MISSING for untested source");
  });

  it("warns when source edited without test update (test EXISTS)", () => {
    // Create an existing test file
    writeFileSync(
      join(TMP, ".github", "hooks", "scripts", "__tests__", "hook.test.mjs"),
      "test",
    );
    const warnings = checkTestEditCorrelation(["hook.mjs"], TMP);
    const drift = warnings.find((w) => w.includes("TEST DRIFT"));
    assert.ok(drift, "Should report TEST DRIFT when test exists but not edited");
  });

  it("does NOT warn when both source and test edited", () => {
    const warnings = checkTestEditCorrelation(
      ["hook.mjs", "hook.test.mjs"],
      TMP,
    );
    const any = warnings.find(
      (w) => w.includes("TEST DRIFT") || w.includes("TEST MISSING"),
    );
    assert.equal(any, undefined, "No warning when test also edited");
  });

  it("skips config/type files", () => {
    const warnings = checkTestEditCorrelation(
      ["tsconfig.json", "types.ts", "constants.ts", "index.ts"],
      TMP,
    );
    assert.equal(warnings.length, 0, "Config/type files should be exempt");
  });

  it("skips test files themselves", () => {
    const warnings = checkTestEditCorrelation(
      ["scanner.test.ts", "hook.test.mjs"],
      TMP,
    );
    assert.equal(warnings.length, 0, "Test files should not warn about tests");
  });
});
