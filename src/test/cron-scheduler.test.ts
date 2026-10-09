/**
 * Tests for CronSchedulerCore (pure logic, no VS Code).
 */

import * as assert from "assert";
import { CronSchedulerCore } from "../cron-scheduler-core";

suite("CronSchedulerCore", () => {
  test("starts and stops", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    assert.strictEqual(core.isRunning, false);
    core.start();
    assert.strictEqual(core.isRunning, true);
    core.stop();
    assert.strictEqual(core.isRunning, false);
    core.dispose();
  });

  test("start is idempotent", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    core.start();
    core.start(); // should not throw or create 2 timers
    assert.strictEqual(core.isRunning, true);
    core.dispose();
  });

  test("stop is idempotent", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    core.stop(); // should not throw
    core.start();
    core.stop();
    core.stop(); // should not throw
    assert.strictEqual(core.isRunning, false);
  });

  test("triggerNow evaluates and fires callback", async () => {
    let evaluated = false;
    let alertText = "";

    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => {
        evaluated = true;
        return "⚠️ Alert!";
      },
      onAlerts: (alerts) => {
        alertText = alerts;
      },
      log: () => {},
    });

    await core.triggerNow();
    assert.strictEqual(evaluated, true);
    assert.strictEqual(alertText, "⚠️ Alert!");
    core.dispose();
  });

  test("triggerNow does not fire callback for empty alerts", async () => {
    let callbackCalled = false;

    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "   ",
      onAlerts: () => {
        callbackCalled = true;
      },
      log: () => {},
    });

    await core.triggerNow();
    assert.strictEqual(callbackCalled, false);
    core.dispose();
  });

  test("mutex prevents concurrent evaluation", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Simulate slow evaluation
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;
        return "alert";
      },
      onAlerts: () => {},
      log: () => {},
    });

    // Fire 3 concurrent triggers — only 1 should evaluate
    const p1 = core.triggerNow();
    const p2 = core.triggerNow();
    const p3 = core.triggerNow();
    await Promise.all([p1, p2, p3]);

    assert.strictEqual(maxConcurrent, 1, "should never have >1 concurrent evaluation");
    core.dispose();
  });

  test("evaluation errors are caught and logged", async () => {
    const logs: string[] = [];

    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => {
        throw new Error("boom");
      },
      onAlerts: () => {},
      log: (msg) => logs.push(msg),
    });

    await core.triggerNow(); // should not throw
    assert.ok(logs.some((l) => l.includes("evaluation error")));
    core.dispose();
  });

  test("setInterval updates interval and restarts timer", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    core.start();
    core.setInterval(200_000);
    assert.strictEqual(core.isRunning, true);
    core.dispose();
  });

  test("setInterval on stopped core does not start it", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    core.setInterval(200_000);
    assert.strictEqual(core.isRunning, false);
    core.dispose();
  });

  test("timer fires evaluation periodically", async () => {
    let evalCount = 0;

    const core = new CronSchedulerCore({
      intervalMs: 30, // 30ms for testing
      evaluate: async () => {
        evalCount++;
        return "";
      },
      onAlerts: () => {},
      log: () => {},
    });

    core.start();
    await new Promise((r) => setTimeout(r, 100));
    core.stop();

    assert.ok(evalCount >= 2, `expected ≥2 evals, got ${evalCount}`);
    core.dispose();
  });

  test("dispose stops the timer", () => {
    const core = new CronSchedulerCore({
      intervalMs: 100_000,
      evaluate: async () => "",
      onAlerts: () => {},
      log: () => {},
    });

    core.start();
    core.dispose();
    assert.strictEqual(core.isRunning, false);
  });
});
