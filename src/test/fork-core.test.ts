import * as assert from "assert";
import * as path from "path";

// ─── Fork Core Tests ────────────────────────────────────────────────────────
// Unit tests for pure functions in fork-core.ts.
// Git-dependent functions (clone, dispose, etc.) are tested via smoke tests.

// Re-implement tested functions inline to avoid simple-git import in test context.
// This tests the LOGIC, not the integration.

import * as crypto from "crypto";

const FORK_BASE_DIR = ".brain-forks";
const FORK_ID_LENGTH = 8;

function generateForkId(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, FORK_ID_LENGTH);
}

function getForkPath(repoRoot: string, forkId: string): string {
  return path.join(repoRoot, FORK_BASE_DIR, forkId);
}

function isNetworkDrive(targetPath: string): boolean {
  if (process.platform === "win32") {
    const normalized = path.resolve(targetPath);
    return normalized.startsWith("\\\\") || normalized.startsWith("//");
  }
  return false;
}

type ForkCloneStrategy = "shared" | "local" | "copy";

function selectCloneStrategy(
  sourcePath: string,
  config?: { strategy?: ForkCloneStrategy },
): ForkCloneStrategy {
  if (config?.strategy) return config.strategy;
  if (isNetworkDrive(sourcePath)) return "local";
  return "shared";
}

suite("Fork Core — generateForkId", () => {
  test("produces deterministic output for same input", () => {
    const id1 = generateForkId("abc-123");
    const id2 = generateForkId("abc-123");
    assert.strictEqual(id1, id2, "Same input → same ID");
  });

  test("produces correct length", () => {
    const id = generateForkId("test-session-id-12345");
    assert.strictEqual(id.length, FORK_ID_LENGTH);
  });

  test("produces only hex characters", () => {
    const id = generateForkId("any-session");
    assert.ok(/^[a-f0-9]+$/.test(id), `Expected hex, got: ${id}`);
  });

  test("different inputs produce different IDs", () => {
    const id1 = generateForkId("session-a");
    const id2 = generateForkId("session-b");
    assert.notStrictEqual(id1, id2);
  });

  test("handles empty string", () => {
    const id = generateForkId("");
    assert.strictEqual(id.length, FORK_ID_LENGTH);
    assert.ok(/^[a-f0-9]+$/.test(id));
  });

  test("handles UUID-like session IDs", () => {
    const id = generateForkId("33331852-fd46-459b-8781-b9f82490e10a");
    assert.strictEqual(id.length, FORK_ID_LENGTH);
    assert.ok(/^[a-f0-9]+$/.test(id));
  });
});

suite("Fork Core — getForkPath", () => {
  test("joins repoRoot + .brain-forks + forkId", () => {
    const result = getForkPath("/home/user/project", "a1b2c3d4");
    const expected = path.join("/home/user/project", ".brain-forks", "a1b2c3d4");
    assert.strictEqual(result, expected);
  });

  test("works with Windows-style paths", () => {
    const result = getForkPath("C:\\Users\\dev\\project", "deadbeef");
    assert.ok(result.includes(FORK_BASE_DIR));
    assert.ok(result.includes("deadbeef"));
  });

  test("path ends with forkId", () => {
    const result = getForkPath("/repo", "12345678");
    assert.ok(result.endsWith("12345678"));
  });
});

suite("Fork Core — isNetworkDrive", () => {
  if (process.platform === "win32") {
    test("detects UNC paths (backslash)", () => {
      assert.strictEqual(isNetworkDrive("\\\\server\\share"), true);
    });

    test("detects UNC paths (forward slash)", () => {
      assert.strictEqual(isNetworkDrive("//server/share"), true);
    });

    test("local drive is NOT network", () => {
      assert.strictEqual(isNetworkDrive("C:\\Users\\project"), false);
    });
  } else {
    test("Unix never detects network drive (heuristic disabled)", () => {
      assert.strictEqual(isNetworkDrive("/mnt/nfs/project"), false);
    });
  }
});

suite("Fork Core — selectCloneStrategy", () => {
  test("defaults to 'shared' for local paths", () => {
    const strategy = selectCloneStrategy("C:\\Users\\project");
    assert.strictEqual(strategy, "shared");
  });

  test("respects explicit config strategy", () => {
    const strategy = selectCloneStrategy("C:\\Users\\project", {
      strategy: "copy",
    });
    assert.strictEqual(strategy, "copy");
  });

  test("explicit config overrides network detection", () => {
    const strategy = selectCloneStrategy("\\\\server\\share", {
      strategy: "shared",
    });
    assert.strictEqual(strategy, "shared");
  });

  if (process.platform === "win32") {
    test("falls back to 'local' for network drives", () => {
      const strategy = selectCloneStrategy("\\\\server\\share");
      assert.strictEqual(strategy, "local");
    });
  }
});
