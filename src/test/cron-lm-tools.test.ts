/**
 * Tests for cron reminder LM tools — specifically buildTriggerFromParams.
 * The actual tool classes depend on VS Code API and can't be unit-tested,
 * but the trigger builder is pure logic.
 */

import * as assert from "assert";
import { buildTriggerFromParams } from "../cron-engine";

suite("buildTriggerFromParams", () => {
  // ─── date-after ──────────────────────────────────────────────────────

  test("date-after with ISO date", () => {
    const trigger = buildTriggerFromParams("date-after", {
      date: "2026-03-01T00:00:00.000Z",
    });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "date-after");
    if (trigger.type === "date-after") {
      assert.strictEqual(trigger.date, "2026-03-01T00:00:00.000Z");
    }
  });

  test("date-after with days-from-now", () => {
    const trigger = buildTriggerFromParams("date-after", { days: 5 });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "date-after");
    if (trigger.type === "date-after") {
      const futureDate = new Date(trigger.date);
      const diff = futureDate.getTime() - Date.now();
      // Should be roughly 5 days (±1 minute tolerance)
      assert.ok(diff > 4.99 * 24 * 60 * 60 * 1000);
      assert.ok(diff < 5.01 * 24 * 60 * 60 * 1000);
    }
  });

  test("date-after returns null without date or days", () => {
    const trigger = buildTriggerFromParams("date-after", {});
    assert.strictEqual(trigger, null);
  });

  test("date-after returns null with days <= 0", () => {
    assert.strictEqual(buildTriggerFromParams("date-after", { days: 0 }), null);
    assert.strictEqual(buildTriggerFromParams("date-after", { days: -1 }), null);
  });

  // ─── interval ────────────────────────────────────────────────────────

  test("interval with valid hours", () => {
    const trigger = buildTriggerFromParams("interval", { hours: 24 });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "interval");
    if (trigger.type === "interval") {
      assert.strictEqual(trigger.hours, 24);
    }
  });

  test("interval with minimum hours (0.5)", () => {
    const trigger = buildTriggerFromParams("interval", { hours: 0.5 });
    assert.ok(trigger);
  });

  test("interval returns null for hours < 0.5", () => {
    assert.strictEqual(buildTriggerFromParams("interval", { hours: 0.4 }), null);
    assert.strictEqual(buildTriggerFromParams("interval", { hours: 0 }), null);
  });

  test("interval returns null without hours", () => {
    assert.strictEqual(buildTriggerFromParams("interval", {}), null);
  });

  // ─── file-lines ──────────────────────────────────────────────────────

  test("file-lines with path and threshold", () => {
    const trigger = buildTriggerFromParams("file-lines", {
      path: "src/big.ts",
      threshold: 500,
    });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "file-lines");
    if (trigger.type === "file-lines") {
      assert.strictEqual(trigger.path, "src/big.ts");
      assert.strictEqual(trigger.threshold, 500);
    }
  });

  test("file-lines returns null without path", () => {
    assert.strictEqual(buildTriggerFromParams("file-lines", { threshold: 100 }), null);
  });

  test("file-lines returns null without threshold", () => {
    assert.strictEqual(buildTriggerFromParams("file-lines", { path: "x.ts" }), null);
  });

  // ─── content-match ───────────────────────────────────────────────────

  test("content-match with path and substring", () => {
    const trigger = buildTriggerFromParams("content-match", {
      path: "src/config.ts",
      substring: "TODO",
    });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "content-match");
    if (trigger.type === "content-match") {
      assert.strictEqual(trigger.path, "src/config.ts");
      assert.strictEqual(trigger.substring, "TODO");
    }
  });

  test("content-match returns null without substring", () => {
    assert.strictEqual(buildTriggerFromParams("content-match", { path: "x.ts" }), null);
  });

  // ─── days-since ──────────────────────────────────────────────────────

  test("days-since with referenceFile and days", () => {
    const trigger = buildTriggerFromParams("days-since", {
      referenceFile: "docs/memory/14_OPINIONS.md",
      days: 7,
    });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "days-since");
    if (trigger.type === "days-since") {
      assert.strictEqual(trigger.referenceFile, "docs/memory/14_OPINIONS.md");
      assert.strictEqual(trigger.days, 7);
    }
  });

  test("days-since returns null without referenceFile", () => {
    assert.strictEqual(buildTriggerFromParams("days-since", { days: 7 }), null);
  });

  // ─── git-uncommitted ─────────────────────────────────────────────────

  test("git-uncommitted with threshold", () => {
    const trigger = buildTriggerFromParams("git-uncommitted", { threshold: 20 });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "git-uncommitted");
    if (trigger.type === "git-uncommitted") {
      assert.strictEqual(trigger.threshold, 20);
    }
  });

  test("git-uncommitted returns null with threshold 0", () => {
    assert.strictEqual(buildTriggerFromParams("git-uncommitted", { threshold: 0 }), null);
  });

  // ─── always ──────────────────────────────────────────────────────────

  test("always trigger ignores params", () => {
    const trigger = buildTriggerFromParams("always", { foo: "bar" });
    assert.ok(trigger);
    assert.strictEqual(trigger.type, "always");
  });

  // ─── unknown ─────────────────────────────────────────────────────────

  test("unknown type returns null", () => {
    assert.strictEqual(buildTriggerFromParams("unknown-type", {}), null);
  });
});
