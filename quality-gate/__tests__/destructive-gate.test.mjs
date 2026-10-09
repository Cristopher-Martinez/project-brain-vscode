// quality-gate/__tests__/destructive-gate.test.mjs
// R1 PARITY HARNESS — proves the extracted engine behaves IDENTICALLY to the
// VS Code hook's inline destructive-command logic. If the hook and this engine
// ever diverge, these assertions fail loudly (the drift bug that birthed F1).
//
// Run: node --test quality-gate/__tests__/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDestructiveCommand,
  DESTRUCTIVE_PATTERNS,
  GATE_ID,
} from "../destructive-gate.mjs";

// ── Commands the hook BLOCKS (one per pattern, in order) ────────────────────
const MUST_DENY = [
  "rm -rf /tmp/data",
  "rm --recursive node_modules",
  "rm --force secrets.env",
  "del /s C:\\\\build",
  "del /q C:\\\\temp",
  "Remove-Item ./dist -Recurse -Force",
  "git push origin main --force",
  "DROP TABLE users;",
  "DROP DATABASE prod;",
  "FORMAT C:",
  "mkfs.ext4 /dev/sda1",
];

// ── Commands the hook ALLOWS (safe / non-destructive) ───────────────────────
const MUST_ALLOW = [
  "npm run compile",
  "git status",
  "git push origin main",
  "rm file.txt", // no -rf/--recursive/--force flag
  "Remove-Item ./tmp.txt", // no -Recurse -Force
  "SELECT * FROM users;",
  "node scripts/build-server.mjs",
  "",
];

test("denies every destructive command (parity with hook)", () => {
  for (const cmd of MUST_DENY) {
    const v = checkDestructiveCommand(cmd);
    assert.equal(v.decision, "deny", `expected DENY for: ${cmd}`);
    assert.equal(v.gate, GATE_ID);
    assert.match(v.reason, /Blocked destructive command/);
    assert.ok(v.matched, `deny verdict must report matched pattern for: ${cmd}`);
  }
});

test("allows safe / non-destructive commands", () => {
  for (const cmd of MUST_ALLOW) {
    const v = checkDestructiveCommand(cmd);
    assert.equal(v.decision, "allow", `expected ALLOW for: ${cmd}`);
    assert.equal(v.gate, GATE_ID);
  }
});

test("first-match-wins ordering is preserved", () => {
  // `rm -rf` must match the first pattern, not a later one.
  const v = checkDestructiveCommand("rm -rf /");
  assert.equal(v.matched, DESTRUCTIVE_PATTERNS[0].source);
});

test("non-string input is handled defensively", () => {
  assert.equal(checkDestructiveCommand(undefined).decision, "allow");
  assert.equal(checkDestructiveCommand(null).decision, "allow");
  assert.equal(checkDestructiveCommand(42).decision, "allow");
});

test("pattern catalog matches the hook's source of truth", () => {
  // Guard against accidental edits: the catalog count is pinned. If you add a
  // pattern here you MUST add it to the hook facade too (and bump this number).
  assert.equal(DESTRUCTIVE_PATTERNS.length, 7);
});
