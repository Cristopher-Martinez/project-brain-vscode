// quality-gate/__tests__/config-levels.test.mjs
// Severity-contract tests: getGateLevel resolution + evaluateCommand combining
// (detection x level) into deny/warn/off behavior.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getGateLevel,
  loadGateConfig,
  evaluateCommand,
  FALLBACK_LEVEL,
} from "../index.mjs";

const RM = "rm -rf /tmp/data";
const SAFE = "npm run compile";

test("getGateLevel: destructive-command defaults to deny", () => {
  assert.equal(getGateLevel("destructive-command"), "deny");
});

test("getGateLevel: unknown gate falls back to warn", () => {
  assert.equal(getGateLevel("some-future-heuristic"), FALLBACK_LEVEL);
  assert.equal(FALLBACK_LEVEL, "warn");
});

test("getGateLevel: config override wins over default", () => {
  const cfg = { gates: { "destructive-command": "warn" } };
  assert.equal(getGateLevel("destructive-command", cfg), "warn");
});

test("getGateLevel: invalid override is ignored (falls back to default)", () => {
  const cfg = { gates: { "destructive-command": "nonsense" } };
  assert.equal(getGateLevel("destructive-command", cfg), "deny");
});

test("loadGateConfig: missing file yields empty config (no throw)", () => {
  const cfg = loadGateConfig("/path/that/does/not/exist");
  assert.deepEqual(cfg, { gates: {} });
});

test("loadGateConfig: nullish root yields empty config", () => {
  assert.deepEqual(loadGateConfig(undefined), { gates: {} });
  assert.deepEqual(loadGateConfig(""), { gates: {} });
});

test("evaluateCommand: destructive + deny level => blocked", () => {
  const r = evaluateCommand(RM);
  assert.equal(r.decision, "deny");
  assert.equal(r.blocked, true);
  assert.equal(r.verdicts[0].decision, "deny");
  assert.equal(r.verdicts[0].level, "deny");
});

test("evaluateCommand: destructive + warn level => NOT blocked, still surfaced", () => {
  const config = { gates: { "destructive-command": "warn" } };
  const r = evaluateCommand(RM, { config });
  assert.equal(r.blocked, false);
  assert.equal(r.decision, "allow");
  assert.equal(r.verdicts[0].decision, "deny");
  assert.equal(r.verdicts[0].level, "warn");
});

test("evaluateCommand: off level => gate skipped entirely", () => {
  const config = { gates: { "destructive-command": "off" } };
  const r = evaluateCommand(RM, { config });
  assert.equal(r.blocked, false);
  assert.equal(r.decision, "allow");
  assert.equal(r.verdicts.length, 0);
});

test("evaluateCommand: safe command => clean allow", () => {
  const r = evaluateCommand(SAFE);
  assert.equal(r.decision, "allow");
  assert.equal(r.blocked, false);
  assert.equal(r.verdicts[0].decision, "allow");
});

test("evaluateCommand: gates filter limits which gates run", () => {
  const r = evaluateCommand(RM, { gates: ["nonexistent-gate"] });
  assert.equal(r.verdicts.length, 0);
  assert.equal(r.blocked, false);
});
