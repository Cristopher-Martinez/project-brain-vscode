// quality-gate/__tests__/secret-gate.test.mjs
// Secret-exposure gate tests: pattern detection (parity), evaluateContent
// combining (detection x level), path skipping, and anti-drift pin.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkSecretExposure,
  SECRET_PATTERNS,
  evaluateContent,
} from "../index.mjs";

// Fake secrets built so they MATCH the patterns but are obviously synthetic.
const GH_PAT = "ghp_" + "A".repeat(40);
const CF_TOKEN = "CLOUDFLARE_API_TOKEN=" + "x".repeat(40);
const CLEAN = "export const greeting = 'hello world';";

test("checkSecretExposure: GitHub PAT => deny", () => {
  const v = checkSecretExposure(`const t = "${GH_PAT}";`, "src/config.ts");
  assert.equal(v.decision, "deny");
  assert.equal(v.gate, "secret-exposure");
  assert.equal(v.matched, "GitHub PAT");
});

test("checkSecretExposure: Cloudflare token => deny", () => {
  const v = checkSecretExposure(CF_TOKEN, ".env");
  assert.equal(v.decision, "deny");
  assert.equal(v.matched, "Cloudflare token");
});

test("checkSecretExposure: clean content => allow", () => {
  const v = checkSecretExposure(CLEAN, "src/index.ts");
  assert.equal(v.decision, "allow");
});

test("checkSecretExposure: empty content => allow", () => {
  assert.equal(checkSecretExposure("", "src/x.ts").decision, "allow");
  assert.equal(checkSecretExposure(undefined, "src/x.ts").decision, "allow");
});

test("checkSecretExposure: test/fixture paths are skipped", () => {
  assert.equal(checkSecretExposure(GH_PAT, "src/foo.test.ts").decision, "allow");
  assert.equal(checkSecretExposure(GH_PAT, "fixtures/creds.txt").decision, "allow");
  assert.equal(checkSecretExposure(GH_PAT, "a/__tests__/b.ts").decision, "allow");
});

test("evaluateContent: secret + default deny level => blocked", () => {
  const r = evaluateContent(`token = "${GH_PAT}"`, { filePath: "src/a.ts" });
  assert.equal(r.decision, "deny");
  assert.equal(r.blocked, true);
  assert.equal(r.verdicts[0].decision, "deny");
  assert.equal(r.verdicts[0].level, "deny");
});

test("evaluateContent: secret + warn level => NOT blocked, still surfaced", () => {
  const config = { gates: { "secret-exposure": "warn" } };
  const r = evaluateContent(`token = "${GH_PAT}"`, {
    filePath: "src/a.ts",
    config,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.decision, "allow");
  assert.equal(r.verdicts[0].decision, "deny");
  assert.equal(r.verdicts[0].level, "warn");
});

test("evaluateContent: secret + off level => skipped entirely", () => {
  const config = { gates: { "secret-exposure": "off" } };
  const r = evaluateContent(`token = "${GH_PAT}"`, {
    filePath: "src/a.ts",
    config,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.verdicts.length, 0);
});

test("evaluateContent: clean content => allow, no block", () => {
  const r = evaluateContent(CLEAN, { filePath: "src/index.ts" });
  assert.equal(r.decision, "allow");
  assert.equal(r.blocked, false);
});

test("anti-drift: SECRET_PATTERNS catalog size is pinned", () => {
  // If you intentionally add/remove a secret pattern, update this number.
  assert.equal(SECRET_PATTERNS.length, 6);
});
