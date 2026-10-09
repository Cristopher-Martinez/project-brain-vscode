import * as assert from "assert";
import { createHash } from "crypto";

// ─── Scan Cache Tests ────────────────────────────────────────────────────────
// Test cache hashing, change detection, and state management logic

suite("Scan Cache Tests", () => {
  const CACHE_VERSION = 1;

  function hashContent(content: string): string {
    return createHash("md5")
      .update(Buffer.from(content, "utf-8"))
      .digest("hex");
  }

  test("MD5 hash should be deterministic", () => {
    const content = "const foo = 42;\nexport default foo;\n";
    const hash1 = hashContent(content);
    const hash2 = hashContent(content);

    assert.strictEqual(hash1, hash2, "Same content should produce same hash");
    assert.strictEqual(hash1.length, 32, "MD5 hash should be 32 hex chars");
  });

  test("Different content should produce different hashes", () => {
    const hash1 = hashContent("const foo = 42;");
    const hash2 = hashContent("const foo = 43;");

    assert.notStrictEqual(
      hash1,
      hash2,
      "Different content should produce different hash",
    );
  });

  test("Empty content should still produce valid hash", () => {
    const hash = hashContent("");
    assert.strictEqual(hash.length, 32);
    assert.ok(/^[a-f0-9]+$/.test(hash), "Hash should be hex string");
  });

  test("Cache structure should conform to schema", () => {
    const cache = {
      version: CACHE_VERSION,
      projectRoot: "/home/user/project",
      files: {} as Record<
        string,
        { hash: string; lastModified: number; lineCount: number }
      >,
      lastFullScan: Date.now(),
    };

    assert.strictEqual(cache.version, 1);
    assert.ok(typeof cache.projectRoot === "string");
    assert.ok(typeof cache.files === "object");
    assert.ok(typeof cache.lastFullScan === "number");
  });

  test("Change detection — unchanged file (same mtime)", () => {
    const cache: Record<string, { hash: string; lastModified: number }> = {
      "src/index.ts": { hash: "abc123", lastModified: 1000 },
    };

    const currentMtime = 1000; // same as cached

    const cachedEntry = cache["src/index.ts"];
    const isChanged = currentMtime > cachedEntry.lastModified;

    assert.strictEqual(
      isChanged,
      false,
      "File should be unchanged when mtime matches",
    );
  });

  test("Change detection — modified file (newer mtime)", () => {
    const cache: Record<string, { hash: string; lastModified: number }> = {
      "src/index.ts": { hash: "abc123", lastModified: 1000 },
    };

    const currentMtime = 2000; // newer than cached

    const cachedEntry = cache["src/index.ts"];
    const isChanged = currentMtime > cachedEntry.lastModified;

    assert.strictEqual(
      isChanged,
      true,
      "File should be detected as changed with newer mtime",
    );
  });

  test("Change detection — touched file (new mtime, same hash)", () => {
    const originalHash = hashContent("const foo = 42;");
    const cache: Record<string, { hash: string; lastModified: number }> = {
      "src/index.ts": { hash: originalHash, lastModified: 1000 },
    };

    // File was touched (mtime changed) but content is the same
    const currentContent = "const foo = 42;";
    const currentHash = hashContent(currentContent);
    const currentMtime = 2000;

    const cachedEntry = cache["src/index.ts"];
    const mtimeChanged = currentMtime > cachedEntry.lastModified;
    const contentChanged = currentHash !== cachedEntry.hash;

    assert.strictEqual(mtimeChanged, true, "mtime should differ");
    assert.strictEqual(
      contentChanged,
      false,
      "Content hash should match (file only touched)",
    );
  });

  test("Detect new files (not in cache)", () => {
    const cache: Record<string, { hash: string }> = {
      "src/index.ts": { hash: "abc" },
      "src/utils.ts": { hash: "def" },
    };

    const currentFiles = ["src/index.ts", "src/utils.ts", "src/new-file.ts"];
    const added = currentFiles.filter((f) => !(f in cache));

    assert.deepStrictEqual(added, ["src/new-file.ts"]);
  });

  test("Detect deleted files (in cache but not current)", () => {
    const cache: Record<string, { hash: string }> = {
      "src/index.ts": { hash: "abc" },
      "src/utils.ts": { hash: "def" },
      "src/old-file.ts": { hash: "ghi" },
    };

    const currentFiles = new Set(["src/index.ts", "src/utils.ts"]);
    const deleted = Object.keys(cache).filter((f) => !currentFiles.has(f));

    assert.deepStrictEqual(deleted, ["src/old-file.ts"]);
  });

  test("Cache version mismatch should invalidate", () => {
    const oldCache = {
      version: 0,
      projectRoot: "/test",
      files: {},
      lastFullScan: 0,
    };
    const isValid = oldCache.version === CACHE_VERSION;

    assert.strictEqual(isValid, false, "Old version cache should be invalid");
  });

  test("Stats computation from cache", () => {
    const cache = {
      version: CACHE_VERSION,
      projectRoot: "/test",
      files: {
        "a.ts": { hash: "h1", lastModified: 1000, lineCount: 50 },
        "b.ts": { hash: "h2", lastModified: 2000, lineCount: 100 },
        "c.ts": { hash: "h3", lastModified: 3000, lineCount: 25 },
      },
      lastFullScan: 5000,
    };

    const totalFiles = Object.keys(cache.files).length;
    assert.strictEqual(totalFiles, 3);
    assert.strictEqual(cache.lastFullScan, 5000);

    const totalLines = Object.values(cache.files).reduce(
      (sum, f) => sum + f.lineCount,
      0,
    );
    assert.strictEqual(totalLines, 175);
  });

  test("Path normalization (Windows backslashes to forward slashes)", () => {
    const winPath = "src\\utils\\helpers.ts";
    const normalized = winPath.replace(/\\/g, "/");

    assert.strictEqual(normalized, "src/utils/helpers.ts");
    assert.ok(!normalized.includes("\\"), "Should have no backslashes");
  });
});
