import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── sql-provider tests ────────────────────────────────────────────────
// TDD: These tests are written BEFORE the implementation.
// Tests the singleton WASM pattern that mitigates Contra #5 (WASM footprint).
// ────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sql-provider-test-"));
}

const noop = () => {};

suite("SQL Provider — Singleton WASM", () => {
  test("getSqlJs returns a SQL module with Database constructor", async () => {
    const { getSqlJs } = require("../sql-provider");
    const SQL = await getSqlJs();
    assert.ok(SQL, "getSqlJs() should return a SQL module");
    assert.ok(SQL.Database, "SQL module should have a Database constructor");
  });

  test("getSqlJs returns the same instance on repeated calls (singleton)", async () => {
    const { getSqlJs } = require("../sql-provider");
    const sql1 = await getSqlJs();
    const sql2 = await getSqlJs();
    assert.strictEqual(sql1, sql2, "Should return the exact same instance");
  });

  test("createDatabase creates a new empty database", async () => {
    const { createDatabase } = require("../sql-provider");
    const dir = tmpDir();
    const dbPath = path.join(dir, "test.sqlite");
    const db = await createDatabase(dbPath);
    assert.ok(db, "Should return a database instance");
    // Can execute a simple query
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO test (name) VALUES (?)", ["hello"]);
    const result = db.exec("SELECT name FROM test");
    assert.strictEqual(result[0].values[0][0], "hello");
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("createDatabase loads existing database from disk", async () => {
    const { createDatabase, saveDatabase } = require("../sql-provider");
    const dir = tmpDir();
    const dbPath = path.join(dir, "persist.sqlite");

    // Create and populate
    const db1 = await createDatabase(dbPath);
    db1.run("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
    db1.run("INSERT INTO items (value) VALUES (?)", ["persisted"]);
    saveDatabase(db1, dbPath);
    db1.close();

    // Reload
    const db2 = await createDatabase(dbPath);
    const result = db2.exec("SELECT value FROM items");
    assert.strictEqual(result[0].values[0][0], "persisted");
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("saveDatabase persists to disk atomically", async () => {
    const { createDatabase, saveDatabase } = require("../sql-provider");
    const dir = tmpDir();
    const dbPath = path.join(dir, "atomic.sqlite");

    const db = await createDatabase(dbPath);
    db.run("CREATE TABLE t (x INTEGER)");
    db.run("INSERT INTO t (x) VALUES (42)");
    saveDatabase(db, dbPath);

    // Verify file exists and is non-empty
    assert.ok(fs.existsSync(dbPath), "DB file should exist after save");
    const stat = fs.statSync(dbPath);
    assert.ok(stat.size > 0, "DB file should be non-empty");

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
