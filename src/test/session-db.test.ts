import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── SessionDB tests ───────────────────────────────────────────────────
// TDD: Written BEFORE implementation.
// Covers: CRUD, backup (Contra #2), migration, search, debounced save.
// ────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-db-test-"));
}

const logs: string[] = [];
const testLog = (msg: string) => {
  logs.push(msg);
};

// ─── Helper: create sample summary .md files ───────────────────────────

function writeSampleSummary(
  sessionsDir: string,
  date: string,
  branch = "master",
): void {
  const content = [
    `# Session Summary — ${date}`,
    "",
    `**Branch**: \`${branch}\``,
    `**Commit**: \`abc123\``,
    `**Summarized by**: Copilot (vscode.lm)`,
    "",
    "---",
    "",
    "## Learnings",
    `- Learned something on ${date}`,
    "",
    "## Decisions Made",
    `- Decided something on ${date}`,
    "",
  ].join("\n");
  fs.writeFileSync(
    path.join(sessionsDir, `${date}-summary.md`),
    content,
    "utf-8",
  );
}

suite("SessionDB — Core CRUD", () => {
  let memDir: string;
  let sessionsDir: string;

  setup(() => {
    memDir = tmpDir();
    sessionsDir = path.join(memDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    logs.length = 0;
  });

  teardown(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("init creates database and tables", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    assert.ok(
      fs.existsSync(path.join(sessionsDir, "sessions.sqlite")),
      "sessions.sqlite should exist after init",
    );
    db.dispose();
  });

  test("saveSummary inserts a row and it can be retrieved", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    await db.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "abc123",
      summaryMarkdown: "# Test summary\n\nSome content",
      learnings: "Learned X",
      decisions: "Decided Y",
    });

    const results = await db.listSummaries(10);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].branch, "master");
    assert.strictEqual(results[0].lastCommit, "abc123");
    assert.ok(results[0].summaryMarkdown.includes("Test summary"));
    db.dispose();
  });

  test("listSummaries returns newest first with pagination", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    for (let i = 1; i <= 5; i++) {
      await db.saveSummary({
        date: `2026-02-${String(i).padStart(2, "0")}T12:00:00.000Z`,
        branch: "master",
        lastCommit: `commit-${i}`,
        summaryMarkdown: `Summary ${i}`,
      });
    }

    const page1 = await db.listSummaries(3);
    assert.strictEqual(page1.length, 3);
    assert.ok(page1[0].date > page1[1].date, "Should be newest first");

    const page2 = await db.listSummaries(3, 3);
    assert.strictEqual(page2.length, 2);
    db.dispose();
  });

  test("getRecentSummaries returns only summaries within N days", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    await db.saveSummary({
      date: today.toISOString(),
      branch: "master",
      lastCommit: "today",
      summaryMarkdown: "Today summary",
    });
    await db.saveSummary({
      date: yesterday.toISOString(),
      branch: "master",
      lastCommit: "yesterday",
      summaryMarkdown: "Yesterday summary",
    });
    await db.saveSummary({
      date: weekAgo.toISOString(),
      branch: "master",
      lastCommit: "old",
      summaryMarkdown: "Old summary",
    });

    const recent = await db.getRecentSummaries(2);
    assert.strictEqual(recent.length, 2);
    assert.ok(
      recent.every((s: { lastCommit: string }) => s.lastCommit !== "old"),
      "Old summary should be excluded",
    );
    db.dispose();
  });

  test("searchSummaries finds by text content (LIKE)", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    await db.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "abc",
      summaryMarkdown: "Implemented the cron scheduler refactor",
    });
    await db.saveSummary({
      date: "2026-02-17T12:00:00.000Z",
      branch: "feat/auth",
      lastCommit: "def",
      summaryMarkdown: "Fixed authentication token refresh",
    });

    const found = await db.searchSummaries("cron");
    assert.strictEqual(found.length, 1);
    assert.ok(found[0].summaryMarkdown.includes("cron"));

    const nothing = await db.searchSummaries("nonexistent-xyz-123");
    assert.strictEqual(nothing.length, 0);
    db.dispose();
  });

  test("dispose saves and closes cleanly", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    await db.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "abc",
      summaryMarkdown: "Disposable",
    });
    db.dispose();

    // Re-open and verify data persisted
    const db2 = new SessionDB(memDir, testLog);
    await db2.init();
    const results = await db2.listSummaries(10);
    assert.strictEqual(
      results.length,
      1,
      "Data should persist across dispose/re-open",
    );
    db2.dispose();
  });
});

suite("SessionDB — Backup & Integrity (Contra #2 mitigation)", () => {
  let memDir: string;
  let sessionsDir: string;

  setup(() => {
    memDir = tmpDir();
    sessionsDir = path.join(memDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    logs.length = 0;
  });

  teardown(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("init creates backup of existing db before opening", async () => {
    const { SessionDB } = require("../session-db");

    // First: create a DB with data
    const db1 = new SessionDB(memDir, testLog);
    await db1.init();
    await db1.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "abc",
      summaryMarkdown: "Backup test",
    });
    db1.dispose();

    // Set file mtime to >24h ago to trigger backup
    const dbPath = path.join(sessionsDir, "sessions.sqlite");
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(dbPath, oldTime, oldTime);

    // Re-open — should create backup
    const db2 = new SessionDB(memDir, testLog);
    await db2.init();

    const bakPath = path.join(sessionsDir, "sessions.sqlite.bak");
    assert.ok(
      fs.existsSync(bakPath),
      ".bak file should be created for DBs older than 24h",
    );
    db2.dispose();
  });

  test("init handles corrupted database by recreating", async () => {
    const { SessionDB } = require("../session-db");
    const dbPath = path.join(sessionsDir, "sessions.sqlite");

    // Write garbage to simulate corruption
    fs.writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE", "utf-8");

    // Should not throw — should recreate
    const db = new SessionDB(memDir, testLog);
    await db.init();

    // Should work with fresh DB
    await db.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "fresh",
      summaryMarkdown: "After recovery",
    });
    const results = await db.listSummaries(10);
    assert.strictEqual(results.length, 1);
    db.dispose();
  });

  test("init restores from backup when main db is corrupted", async () => {
    const { SessionDB } = require("../session-db");
    const dbPath = path.join(sessionsDir, "sessions.sqlite");
    const bakPath = path.join(sessionsDir, "sessions.sqlite.bak");

    // Create a valid DB first
    const db1 = new SessionDB(memDir, testLog);
    await db1.init();
    await db1.saveSummary({
      date: "2026-02-18T12:00:00.000Z",
      branch: "master",
      lastCommit: "good",
      summaryMarkdown: "Good data in backup",
    });
    db1.dispose();

    // Copy to .bak, then corrupt main
    fs.copyFileSync(dbPath, bakPath);
    fs.writeFileSync(dbPath, "CORRUPTED", "utf-8");

    // Re-open — should restore from backup
    const db2 = new SessionDB(memDir, testLog);
    await db2.init();
    const results = await db2.listSummaries(10);
    assert.strictEqual(results.length, 1, "Should restore data from backup");
    assert.strictEqual(results[0].lastCommit, "good");
    db2.dispose();
  });
});

suite("SessionDB — Migration from .md files", () => {
  let memDir: string;
  let sessionsDir: string;

  setup(() => {
    memDir = tmpDir();
    sessionsDir = path.join(memDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    logs.length = 0;
  });

  teardown(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("importFromMarkdown migrates all *-summary.md files", async () => {
    const { SessionDB } = require("../session-db");

    // Create sample .md files
    writeSampleSummary(sessionsDir, "2026-02-15_11-30");
    writeSampleSummary(sessionsDir, "2026-02-16_09-00", "feat/auth");
    writeSampleSummary(sessionsDir, "2026-02-17_14-20");

    // Also write a non-summary file (should be ignored)
    fs.writeFileSync(
      path.join(sessionsDir, "subagent-analytics.md"),
      "# Not a summary",
      "utf-8",
    );

    const db = new SessionDB(memDir, testLog);
    await db.init();
    const count = await db.importFromMarkdown();

    assert.strictEqual(count, 3, "Should import exactly 3 summary files");

    const results = await db.listSummaries(10);
    assert.strictEqual(results.length, 3);
    db.dispose();
  });

  test("importFromMarkdown is idempotent (no duplicates on re-run)", async () => {
    const { SessionDB } = require("../session-db");

    writeSampleSummary(sessionsDir, "2026-02-15_11-30");

    const db = new SessionDB(memDir, testLog);
    await db.init();
    await db.importFromMarkdown();
    await db.importFromMarkdown(); // Second run

    const results = await db.listSummaries(10);
    assert.strictEqual(results.length, 1, "Should not duplicate on re-import");
    db.dispose();
  });

  test("importFromMarkdown parses branch and commit from header", async () => {
    const { SessionDB } = require("../session-db");

    writeSampleSummary(sessionsDir, "2026-02-15_11-30", "feat/sqlite");

    const db = new SessionDB(memDir, testLog);
    await db.init();
    await db.importFromMarkdown();

    const results = await db.listSummaries(10);
    assert.strictEqual(results[0].branch, "feat/sqlite");
    assert.strictEqual(results[0].lastCommit, "abc123");
    db.dispose();
  });

  test("importFromMarkdown skips non-summary .md files", async () => {
    const { SessionDB } = require("../session-db");

    // These should all be SKIPPED
    fs.writeFileSync(
      path.join(sessionsDir, "subagent-analytics.md"),
      "# nope",
      "utf-8",
    );
    fs.writeFileSync(path.join(sessionsDir, "notes.md"), "# nope", "utf-8");
    // This one should be imported
    writeSampleSummary(sessionsDir, "2026-02-15_11-30");

    const db = new SessionDB(memDir, testLog);
    await db.init();
    const count = await db.importFromMarkdown();

    assert.strictEqual(
      count,
      1,
      "Should only import files matching *-summary.md pattern",
    );
    db.dispose();
  });
});

suite("SessionDB — Empty/edge cases", () => {
  let memDir: string;

  setup(() => {
    memDir = tmpDir();
    fs.mkdirSync(path.join(memDir, "sessions"), { recursive: true });
    logs.length = 0;
  });

  teardown(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("listSummaries returns empty array when no data", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    const results = await db.listSummaries(10);
    assert.deepStrictEqual(results, []);
    db.dispose();
  });

  test("getRecentSummaries returns empty when no data", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    const results = await db.getRecentSummaries(2);
    assert.deepStrictEqual(results, []);
    db.dispose();
  });

  test("searchSummaries returns empty when no match", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    const results = await db.searchSummaries("nonexistent");
    assert.deepStrictEqual(results, []);
    db.dispose();
  });

  test("importFromMarkdown returns 0 when no .md files exist", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    const count = await db.importFromMarkdown();
    assert.strictEqual(count, 0);
    db.dispose();
  });
});

suite("SessionDB — Reconciliation (fallback recovery)", () => {
  let memDir: string;
  let sessionsDir: string;

  setup(() => {
    memDir = tmpDir();
    sessionsDir = path.join(memDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    logs.length = 0;
  });

  teardown(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("reconcile imports .md files written AFTER initial importFromMarkdown", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    // Initial state: no .md files → nothing to import
    const initial = await db.importFromMarkdown();
    assert.strictEqual(initial, 0);

    // Simulate fallback: a .md was written because SQLite was down mid-session
    writeSampleSummary(sessionsDir, "2026-02-18_15-00", "master");

    // reconcile picks up the orphan
    const reconciled = await db.reconcile();
    assert.strictEqual(reconciled, 1, "Should import 1 orphaned .md file");

    const results = await db.listSummaries(10);
    assert.strictEqual(results.length, 1);
    db.dispose();
  });

  test("reconcile is idempotent — second call returns 0", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    writeSampleSummary(sessionsDir, "2026-02-18_15-00");
    await db.reconcile();
    const second = await db.reconcile();
    assert.strictEqual(second, 0, "Second reconcile should find nothing new");
    db.dispose();
  });

  test("reconcile ignores .md files already in DB (from saveSummary)", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();

    // Save a summary via SQLite (normal path)
    await db.saveSummary({
      date: "2026-02-18T15:00:00.000Z",
      branch: "master",
      lastCommit: "abc123",
      summaryMarkdown: "# Test\n\nContent",
    });

    // Also write a DIFFERENT .md that is a genuine orphan
    writeSampleSummary(sessionsDir, "2026-02-18_16-00", "feat/new");

    const reconciled = await db.reconcile();
    assert.strictEqual(
      reconciled,
      1,
      "Should only import the orphan, not the DB-saved one",
    );

    const results = await db.listSummaries(10);
    assert.strictEqual(
      results.length,
      2,
      "Should have both: DB-saved + reconciled",
    );
    db.dispose();
  });

  test("reconcile handles empty sessions dir", async () => {
    const { SessionDB } = require("../session-db");
    const db = new SessionDB(memDir, testLog);
    await db.init();
    const reconciled = await db.reconcile();
    assert.strictEqual(reconciled, 0);
    db.dispose();
  });
});
