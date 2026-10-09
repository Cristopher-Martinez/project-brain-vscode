import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContentHashCache, computeContentHash } from "../content-hash-cache";

suite("ContentHashCache", () => {
  // ─── Core cache operations ──────────────────────────────────

  suite("Basic get/set", () => {
    test("get() returns undefined when key not cached", () => {
      const cache = new ContentHashCache<string>(100);
      assert.strictEqual(cache.get("unknown", "abc"), undefined);
    });

    test("set() + get() with same hash returns cached value", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("myKey", "hash1", "value1");
      assert.strictEqual(cache.get("myKey", "hash1"), "value1");
    });

    test("get() with different hash returns undefined (invalidation)", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("myKey", "hash1", "value1");
      assert.strictEqual(cache.get("myKey", "hash2"), undefined);
    });

    test("set() with new hash replaces old cached value", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("myKey", "hash1", "value1");
      cache.set("myKey", "hash2", "value2");
      assert.strictEqual(cache.get("myKey", "hash1"), undefined);
      assert.strictEqual(cache.get("myKey", "hash2"), "value2");
    });
  });

  // ─── computeContentHash ──────────────────────────────────────

  suite("computeContentHash", () => {
    test("produces 16-char hex string", () => {
      const hash = computeContentHash("hello world");
      assert.strictEqual(hash.length, 16);
      assert.match(hash, /^[0-9a-f]{16}$/);
    });

    test("same content produces same hash", () => {
      const h1 = computeContentHash("test content");
      const h2 = computeContentHash("test content");
      assert.strictEqual(h1, h2);
    });

    test("different content produces different hash", () => {
      const h1 = computeContentHash("content A");
      const h2 = computeContentHash("content B");
      assert.notStrictEqual(h1, h2);
    });

    test("empty string produces valid hash", () => {
      const hash = computeContentHash("");
      assert.strictEqual(hash.length, 16);
      assert.match(hash, /^[0-9a-f]{16}$/);
    });
  });

  // ─── mtime pre-check ────────────────────────────────────────

  suite("mtime check", () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hashcache-test-"));
    });

    teardown(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("needsRecheck returns true on first call (no mtime cached)", () => {
      const cache = new ContentHashCache<string>(100);
      const filePath = path.join(tmpDir, "test.md");
      fs.writeFileSync(filePath, "initial content");
      assert.strictEqual(cache.needsRecheck(filePath), true);
    });

    test("needsRecheck returns false when mtime unchanged", () => {
      const cache = new ContentHashCache<string>(100);
      const filePath = path.join(tmpDir, "test.md");
      fs.writeFileSync(filePath, "initial content");

      cache.needsRecheck(filePath); // first call → caches mtime
      assert.strictEqual(cache.needsRecheck(filePath), false);
    });

    test("needsRecheck returns true when file is modified", (done) => {
      const cache = new ContentHashCache<string>(100);
      const filePath = path.join(tmpDir, "test.md");
      fs.writeFileSync(filePath, "initial content");

      cache.needsRecheck(filePath); // caches mtime

      // Need a small delay so mtime changes (filesystem resolution is ~1ms on modern OS)
      setTimeout(() => {
        fs.writeFileSync(filePath, "modified content");
        assert.strictEqual(cache.needsRecheck(filePath), true);
        done();
      }, 50);
    });

    test("needsRecheck returns false for nonexistent file (graceful)", () => {
      const cache = new ContentHashCache<string>(100);
      assert.strictEqual(cache.needsRecheck("/nonexistent/file.md"), false);
    });
  });

  // ─── LRU eviction ──────────────────────────────────────────

  suite("LRU eviction", () => {
    test("evicts oldest entry when exceeding maxEntries", () => {
      const cache = new ContentHashCache<string>(3);
      cache.set("a", "h1", "val-a");
      cache.set("b", "h2", "val-b");
      cache.set("c", "h3", "val-c");
      cache.set("d", "h4", "val-d"); // should evict "a"
      assert.strictEqual(cache.get("a", "h1"), undefined);
      assert.strictEqual(cache.get("b", "h2"), "val-b");
      assert.strictEqual(cache.get("d", "h4"), "val-d");
    });

    test("size never exceeds maxEntries", () => {
      const cache = new ContentHashCache<string>(2);
      cache.set("x", "h1", "v1");
      cache.set("y", "h2", "v2");
      cache.set("z", "h3", "v3");
      assert.strictEqual(cache.size, 2);
    });
  });

  // ─── getOrCompute (sync convenience) ────────────────────────

  suite("getOrCompute", () => {
    test("calls loader on cache miss and caches result", () => {
      const cache = new ContentHashCache<string>(100);
      let loadCount = 0;
      const result = cache.getOrCompute("key1", "hash1", () => {
        loadCount++;
        return "computed-value";
      });
      assert.strictEqual(result, "computed-value");
      assert.strictEqual(loadCount, 1);
      // Second call with same hash → cache hit, no loader call
      const result2 = cache.getOrCompute("key1", "hash1", () => {
        loadCount++;
        return "should-not-load";
      });
      assert.strictEqual(result2, "computed-value");
      assert.strictEqual(loadCount, 1);
    });

    test("calls loader again when hash changes", () => {
      const cache = new ContentHashCache<string>(100);
      cache.getOrCompute("key1", "hash1", () => "v1");
      const result = cache.getOrCompute("key1", "hash2", () => "v2");
      assert.strictEqual(result, "v2");
    });

    test("correctly caches null/undefined values without re-calling loader", () => {
      const cache = new ContentHashCache<null>(100);
      let loadCount = 0;
      cache.getOrCompute("key1", "hash1", () => {
        loadCount++;
        return null;
      });
      cache.getOrCompute("key1", "hash1", () => {
        loadCount++;
        return null;
      });
      assert.strictEqual(loadCount, 1);
    });
  });

  // ─── clear / stats ──────────────────────────────────────────

  suite("clear and stats", () => {
    test("clear() empties all entries", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("a", "h1", "v1");
      cache.set("b", "h2", "v2");
      cache.clear();
      assert.strictEqual(cache.size, 0);
      assert.strictEqual(cache.get("a", "h1"), undefined);
    });

    test("delete() removes a specific key", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("a", "h1", "v1");
      cache.set("b", "h2", "v2");
      cache.delete("a");
      assert.strictEqual(cache.size, 1);
      assert.strictEqual(cache.get("a", "h1"), undefined);
      assert.strictEqual(cache.get("b", "h2"), "v2");
    });

    test("has() returns correct boolean", () => {
      const cache = new ContentHashCache<string>(100);
      assert.strictEqual(cache.has("x"), false);
      cache.set("x", "h1", "v1");
      assert.strictEqual(cache.has("x"), true);
    });

    test("getCurrent() returns value regardless of hash", () => {
      const cache = new ContentHashCache<string>(100);
      assert.strictEqual(cache.getCurrent("x"), undefined);
      cache.set("x", "h1", "v1");
      assert.strictEqual(cache.getCurrent("x"), "v1");
      // Even after hash "changes", getCurrent still returns the stored value
      cache.set("x", "h2", "v2");
      assert.strictEqual(cache.getCurrent("x"), "v2");
    });

    test("keys() returns all cached keys", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("alpha", "h1", "v1");
      cache.set("beta", "h2", "v2");
      const keys = cache.keys();
      assert.deepStrictEqual(keys.sort(), ["alpha", "beta"]);
    });
  });

  // ─── Filesystem integration ─────────────────────────────────

  suite("Filesystem integration", () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hashcache-fs-"));
    });

    teardown(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("full workflow: read → cache → modify → re-read", (done) => {
      const cache = new ContentHashCache<string>(100);
      const filePath = path.join(tmpDir, "skill.md");
      fs.writeFileSync(filePath, "# Skill v1\nOriginal content");

      // First read: cache miss
      const content1 = fs.readFileSync(filePath, "utf-8");
      const hash1 = computeContentHash(content1);
      cache.set(filePath, hash1, content1);
      assert.strictEqual(cache.get(filePath, hash1), content1);

      // Modify file
      setTimeout(() => {
        fs.writeFileSync(filePath, "# Skill v2\nModified content");
        assert.strictEqual(cache.needsRecheck(filePath), true);

        const content2 = fs.readFileSync(filePath, "utf-8");
        const hash2 = computeContentHash(content2);
        assert.notStrictEqual(hash1, hash2);

        // New hash → miss (cache still has old hash)
        assert.strictEqual(cache.get(filePath, hash2), undefined);

        // Old hash still technically matches the stale entry
        assert.strictEqual(cache.get(filePath, hash1), content1);

        // Update cache with new content
        cache.set(filePath, hash2, content2);
        assert.strictEqual(cache.get(filePath, hash2), content2);
        // Old hash now → miss (entry replaced)
        assert.strictEqual(cache.get(filePath, hash1), undefined);
        done();
      }, 50);
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────

  suite("Edge cases", () => {
    test("works with complex generic types", () => {
      interface Parsed {
        title: string;
        lines: number;
      }
      const cache = new ContentHashCache<Parsed>(100);
      cache.set("doc", "h1", { title: "Test", lines: 42 });
      const result = cache.get("doc", "h1");
      assert.deepStrictEqual(result, { title: "Test", lines: 42 });
    });

    test("maxEntries=1 keeps only latest entry", () => {
      const cache = new ContentHashCache<string>(1);
      cache.set("first", "h1", "v1");
      cache.set("second", "h2", "v2");
      assert.strictEqual(cache.size, 1);
      assert.strictEqual(cache.get("second", "h2"), "v2");
    });

    test("set same key multiple times doesn't increase size", () => {
      const cache = new ContentHashCache<string>(100);
      cache.set("key", "h1", "v1");
      cache.set("key", "h2", "v2");
      cache.set("key", "h3", "v3");
      assert.strictEqual(cache.size, 1);
    });
  });
});
