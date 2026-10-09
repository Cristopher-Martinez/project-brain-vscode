import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addCronJob,
  completeCronJob,
  evaluateCronJobs,
  listCronJobs,
  removeCronJob,
  snoozeCronJob,
  type CronFile,
  type CronJob,
} from "../cron-engine";

// ─── Test helpers ──────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
}

function writeCronJson(dir: string, data: CronFile): string {
  const cronPath = path.join(dir, "cron.json");
  fs.writeFileSync(cronPath, JSON.stringify(data, null, 2), "utf-8");
  return cronPath;
}

function readCronJson(dir: string): CronFile {
  return JSON.parse(fs.readFileSync(path.join(dir, "cron.json"), "utf-8"));
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "test-job",
    description: overrides.description ?? "Test job",
    trigger: overrides.trigger ?? { type: "always" },
    message: overrides.message ?? "Test alert",
    priority: overrides.priority ?? "info",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastTriggered: overrides.lastTriggered ?? null,
    cooldownDays: overrides.cooldownDays ?? 0,
    cooldownMinutes: overrides.cooldownMinutes,
    snoozeUntil: overrides.snoozeUntil ?? null,
    recurring: overrides.recurring,
  };
}

const noop = () => {};
const logs: string[] = [];
const testLog = (msg: string) => {
  logs.push(msg);
};

suite("Cron Engine Tests", () => {
  let memoryDir: string;
  let workspaceDir: string;

  setup(() => {
    memoryDir = tmpDir();
    workspaceDir = tmpDir();
    logs.length = 0;
  });

  teardown(() => {
    // Cleanup temp dirs
    try {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
  });

  // ─── evaluateCronJobs ──────────────────────────────────────────────

  suite("evaluateCronJobs", () => {
    test("returns empty string when cron.json does not exist", async () => {
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("returns empty string with malformed JSON", async () => {
      fs.writeFileSync(path.join(memoryDir, "cron.json"), "not json", "utf-8");
      const result = await evaluateCronJobs(memoryDir, workspaceDir, testLog);
      assert.strictEqual(result, "");
      assert.ok(logs.some((l) => l.includes("malformed")));
    });

    test("returns empty string when jobs array is missing", async () => {
      writeCronJson(memoryDir, { jobs: null as any });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, testLog);
      assert.strictEqual(result, "");
    });

    test("fires 'always' trigger", async () => {
      writeCronJson(memoryDir, {
        jobs: [makeJob({ trigger: { type: "always" } })],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
      assert.ok(result.includes("🔔"));
    });

    test("skips inactive jobs", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ status: "snoozed" })] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("skips done jobs", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ status: "done" })] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("respects cooldown period", async () => {
      const job = makeJob({
        cooldownDays: 7,
        lastTriggered: new Date().toISOString(), // Just triggered
      });
      writeCronJson(memoryDir, { jobs: [job] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("fires after cooldown expires", async () => {
      const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const job = makeJob({
        cooldownDays: 7,
        lastTriggered: past.toISOString(),
      });
      writeCronJson(memoryDir, { jobs: [job] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });

    test("updates lastTriggered in cron.json after firing", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob()] });
      await evaluateCronJobs(memoryDir, workspaceDir, noop);
      const updated = readCronJson(memoryDir);
      assert.ok(updated.jobs[0].lastTriggered !== null);
    });

    test("caps output at MAX_ALERTS (5)", async () => {
      const jobs = Array.from({ length: 8 }, (_, i) =>
        makeJob({ id: `job-${i}`, message: `Alert ${i}` }),
      );
      writeCronJson(memoryDir, { jobs });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      // Should show 5 alerts + overflow message
      const alertLines = result.split("\n").filter((l) => l.startsWith("📌"));
      assert.strictEqual(alertLines.length, 5);
      assert.ok(result.includes("3 más"));
    });

    test("sorts by priority (critical > warning > info)", async () => {
      const jobs = [
        makeJob({ id: "info-1", priority: "info", message: "Info msg" }),
        makeJob({
          id: "crit-1",
          priority: "critical",
          message: "Critical msg",
        }),
        makeJob({ id: "warn-1", priority: "warning", message: "Warning msg" }),
      ];
      writeCronJson(memoryDir, { jobs });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      const critIdx = result.indexOf("🚨");
      const warnIdx = result.indexOf("⚠️");
      const infoIdx = result.indexOf("📌");
      assert.ok(critIdx < warnIdx, "critical should appear before warning");
      assert.ok(warnIdx < infoIdx, "warning should appear before info");
    });

    test("skips jobs with missing required fields", async () => {
      const jobs = [
        { id: "no-trigger", message: "test", status: "active" } as any,
        {
          trigger: { type: "always" },
          message: "test",
          status: "active",
        } as any,
        makeJob({ id: "valid" }),
      ];
      writeCronJson(memoryDir, { jobs });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      // Only the valid job should fire
      const lines = result.split("\n").filter((l) => l.startsWith("📌"));
      assert.strictEqual(lines.length, 1);
    });

    test("auto-reactivates expired snoozed jobs", async () => {
      const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
      const job = makeJob({
        status: "snoozed",
        snoozeUntil: past.toISOString(),
        cooldownDays: 0,
      });
      writeCronJson(memoryDir, { jobs: [job] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      // Should have reactivated and fired
      assert.ok(result.includes("Test alert"));
      const updated = readCronJson(memoryDir);
      assert.strictEqual(updated.jobs[0].status, "active");
    });

    test("does not reactivate unexpired snooze", async () => {
      const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days from now
      const job = makeJob({
        status: "snoozed",
        snoozeUntil: future.toISOString(),
      });
      writeCronJson(memoryDir, { jobs: [job] });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("one broken trigger does not block others", async () => {
      const jobs = [
        makeJob({
          id: "bad",
          trigger: {
            type: "file-lines",
            path: "/nonexistent/path",
            threshold: 1,
          },
        }),
        makeJob({ id: "good", trigger: { type: "always" } }),
      ];
      writeCronJson(memoryDir, { jobs });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });
  });

  // ─── Trigger: file-lines ──────────────────────────────────────────

  suite("trigger: file-lines", () => {
    test("fires when line count exceeds threshold", async () => {
      const filePath = path.join(workspaceDir, "test.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\n");
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "file-lines", path: "test.txt", threshold: 3 },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });

    test("does not fire when below threshold", async () => {
      const filePath = path.join(workspaceDir, "test.txt");
      fs.writeFileSync(filePath, "line1\nline2\n");
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "file-lines", path: "test.txt", threshold: 10 },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("returns false for nonexistent file", async () => {
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "file-lines", path: "ghost.txt", threshold: 1 },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });
  });

  // ─── Trigger: date-after ──────────────────────────────────────────

  suite("trigger: date-after", () => {
    test("fires when date is in the past", async () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      writeCronJson(memoryDir, {
        jobs: [makeJob({ trigger: { type: "date-after", date: past } })],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });

    test("does not fire when date is in the future", async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      writeCronJson(memoryDir, {
        jobs: [makeJob({ trigger: { type: "date-after", date: future } })],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });
  });

  // ─── Trigger: content-match (NEW) ────────────────────────────────

  suite("trigger: content-match", () => {
    test("fires when substring is found in file", async () => {
      const filePath = path.join(workspaceDir, "readme.md");
      fs.writeFileSync(filePath, "# Title\nTODO: fix the bug\nMore content");
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: {
              type: "content-match",
              path: "readme.md",
              substring: "TODO: fix",
            },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });

    test("does not fire when substring is absent", async () => {
      const filePath = path.join(workspaceDir, "readme.md");
      fs.writeFileSync(filePath, "# Title\nAll good here");
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: {
              type: "content-match",
              path: "readme.md",
              substring: "BUG",
            },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("returns false for nonexistent file", async () => {
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: {
              type: "content-match",
              path: "ghost.md",
              substring: "x",
            },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("skips files larger than 1MB", async () => {
      const filePath = path.join(workspaceDir, "big.txt");
      // Create file > 1MB
      fs.writeFileSync(filePath, "x".repeat(1024 * 1024 + 100) + "FINDME");
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: {
              type: "content-match",
              path: "big.txt",
              substring: "FINDME",
            },
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, testLog);
      assert.strictEqual(result, "");
      assert.ok(logs.some((l) => l.includes("too large")));
    });
  });

  // ─── Trigger: interval (NEW) ─────────────────────────────────────

  suite("trigger: interval", () => {
    test("fires when interval has elapsed since lastTriggered", async () => {
      const past = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "interval", hours: 4 },
            lastTriggered: past.toISOString(),
            cooldownDays: 0,
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });

    test("does not fire before interval elapses", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "interval", hours: 4 },
            lastTriggered: recent.toISOString(),
            cooldownDays: 0,
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.strictEqual(result, "");
    });

    test("falls back to createdAt when never triggered", async () => {
      const past = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10 hours ago
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            trigger: { type: "interval", hours: 4 },
            lastTriggered: null,
            createdAt: past.toISOString(),
            cooldownDays: 0,
          }),
        ],
      });
      const result = await evaluateCronJobs(memoryDir, workspaceDir, noop);
      assert.ok(result.includes("Test alert"));
    });
  });

  // ─── CRUD helpers ────────────────────────────────────────────────

  suite("addCronJob", () => {
    test("creates cron.json if it does not exist", async () => {
      const job = makeJob({ id: "new-job" });
      await addCronJob(memoryDir, job, noop);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs.length, 1);
      assert.strictEqual(data.jobs[0].id, "new-job");
    });

    test("appends to existing jobs", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ id: "existing" })] });
      await addCronJob(memoryDir, makeJob({ id: "new-job" }), noop);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs.length, 2);
    });

    test("rejects duplicate IDs", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ id: "dup" })] });
      await assert.rejects(
        () => addCronJob(memoryDir, makeJob({ id: "dup" }), noop),
        /already exists/,
      );
    });
  });

  suite("removeCronJob", () => {
    test("removes job by ID", async () => {
      writeCronJson(memoryDir, {
        jobs: [makeJob({ id: "keep" }), makeJob({ id: "remove" })],
      });
      const removed = await removeCronJob(memoryDir, "remove", noop);
      assert.ok(removed);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs.length, 1);
      assert.strictEqual(data.jobs[0].id, "keep");
    });

    test("returns false for nonexistent ID", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob()] });
      const removed = await removeCronJob(memoryDir, "ghost", noop);
      assert.strictEqual(removed, false);
    });
  });

  suite("listCronJobs", () => {
    test("returns all jobs", async () => {
      writeCronJson(memoryDir, {
        jobs: [makeJob({ id: "a" }), makeJob({ id: "b" })],
      });
      const jobs = await listCronJobs(memoryDir, noop);
      assert.strictEqual(jobs.length, 2);
    });

    test("returns empty array when no cron.json", async () => {
      const jobs = await listCronJobs(memoryDir, noop);
      assert.strictEqual(jobs.length, 0);
    });
  });

  suite("snoozeCronJob", () => {
    test("sets status to snoozed with snoozeUntil", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ id: "snz" })] });
      const result = await snoozeCronJob(memoryDir, "snz", 3, noop);
      assert.ok(result);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs[0].status, "snoozed");
      assert.ok(data.jobs[0].snoozeUntil);
      // Verify snoozeUntil is roughly 3 days from now
      const until = new Date(data.jobs[0].snoozeUntil!).getTime();
      const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
      assert.ok(Math.abs(until - expected) < 60000); // Within 1 minute
    });

    test("returns false for nonexistent job", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob()] });
      const result = await snoozeCronJob(memoryDir, "ghost", 1, noop);
      assert.strictEqual(result, false);
    });
  });

  suite("completeCronJob", () => {
    test("sets status to done", async () => {
      writeCronJson(memoryDir, { jobs: [makeJob({ id: "done-me" })] });
      const result = await completeCronJob(memoryDir, "done-me", noop);
      assert.ok(result);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs[0].status, "done");
    });

    test("recurring job gets snoozed instead of done", async () => {
      writeCronJson(memoryDir, {
        jobs: [
          makeJob({
            id: "rec-job",
            recurring: true,
            cooldownDays: 0,
            cooldownMinutes: 30,
          }),
        ],
      });
      const result = await completeCronJob(memoryDir, "rec-job", noop);
      assert.ok(result);
      const data = readCronJson(memoryDir);
      assert.strictEqual(data.jobs[0].status, "snoozed");
      assert.ok(data.jobs[0].snoozeUntil, "snoozeUntil should be set");

      const snoozeUntil = new Date(String(data.jobs[0].snoozeUntil));
      const now = new Date();
      assert.ok(
        snoozeUntil.getTime() > now.getTime(),
        "snoozeUntil should be in the future",
      );
    });
  });
});
