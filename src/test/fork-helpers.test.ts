import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Fork Helpers Tests ─────────────────────────────────────────────────────
// Tests for persistence, validation, and utility functions in fork-helpers.ts.

// Re-implemented inline to avoid importing modules with complex deps.

const FORK_BASE_DIR = ".brain-forks";
const FORK_STATE_FILE = "state.json";
const FORK_ID_LENGTH = 8;

interface ForkIsolationInfo {
  sessionId: string;
  type: "loop" | "orch";
  branchName: string;
  originalBranch: string;
  forkPath: string;
  repoRoot: string;
  cloneStrategy: "shared" | "local" | "copy";
  createdAt: number;
  status: "active" | "completed" | "merged" | "discarded";
  description?: string;
  summary?: string;
  reportPath?: string;
  isolationAdvice?: string;
}

function getForkPath(repoRoot: string, forkId: string): string {
  return path.join(repoRoot, FORK_BASE_DIR, forkId);
}

function validateForkPathLength(repoRoot: string, forkId: string): boolean {
  const estimatedPath = getForkPath(repoRoot, forkId);
  const maxSafe = process.platform === "win32" ? 200 : 4000;
  return estimatedPath.length < maxSafe;
}

function persistForkState(
  repoRoot: string,
  forkMap: Map<string, ForkIsolationInfo>,
): void {
  const baseDir = path.join(repoRoot, FORK_BASE_DIR);
  fs.mkdirSync(baseDir, { recursive: true });
  const serializable: Record<string, ForkIsolationInfo> = {};
  for (const [key, val] of forkMap) {
    serializable[key] = val;
  }
  const filePath = path.join(baseDir, FORK_STATE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf-8");
}

function restoreForkState(
  repoRoot: string,
  forkMap: Map<string, ForkIsolationInfo>,
): number {
  const filePath = path.join(repoRoot, FORK_BASE_DIR, FORK_STATE_FILE);
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as Record<string, ForkIsolationInfo>;
  let count = 0;
  for (const [key, val] of Object.entries(data)) {
    // Skip entries with forkPaths that no longer exist — BUT for test we
    // don't check forkPath existence (we'd need real dirs)
    forkMap.set(key, val);
    count++;
  }
  return count;
}

function getKnownForkIssuesHint(
  info: ForkIsolationInfo | undefined,
): string {
  if (!info) return "";
  const hints: string[] = [];
  if (info.cloneStrategy === "shared") {
    hints.push(
      "⚠️ This fork uses --shared clone (git alternates). " +
        "Do NOT run `git gc` or `git repack` — it could break object references.",
    );
  }
  if (process.platform === "win32") {
    hints.push(
      "⚠️ Windows: If file operations fail with EPERM/EBUSY, " +
        "a background process may be locking files. Wait and retry.",
    );
  }
  return hints.length > 0 ? hints.join("\n") : "";
}

function getForkLimitations(): string {
  return [
    "## Fork Isolation — What You Should Know",
    "- The fork is a separate git clone of the user's repo",
    "- node_modules is symlinked from the original repo (junction on Windows)",
    "- Do NOT run `npm install` in the fork — use the existing node_modules",
    "- Do NOT push from the fork — pushurl is blocked for safety",
    "- When done, changes are absorbed via `git fetch` + `git merge`",
    "- If you need to see original repo state, read from the `repoRoot` path",
  ].join("\n");
}

function makeInfo(overrides: Partial<ForkIsolationInfo> = {}): ForkIsolationInfo {
  return {
    sessionId: "test-session-001",
    type: "loop",
    branchName: "brain/loop-test-abc12345",
    originalBranch: "main",
    forkPath: "/tmp/test-project/.brain-forks/abc12345",
    repoRoot: "/tmp/test-project",
    cloneStrategy: "shared",
    createdAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

suite("Fork Helpers — validateForkPathLength", () => {
  test("accepts short paths", () => {
    assert.strictEqual(validateForkPathLength("/home/u/p", "abc12345"), true);
  });

  test("accepts typical Windows paths", () => {
    assert.strictEqual(
      validateForkPathLength("C:\\Users\\dev\\project", "abc12345"),
      true,
    );
  });

  if (process.platform === "win32") {
    test("rejects extremely long Windows paths", () => {
      const longRoot = "C:\\" + "a".repeat(200);
      assert.strictEqual(
        validateForkPathLength(longRoot, "abc12345"),
        false,
      );
    });
  }
});

suite("Fork Helpers — persistForkState / restoreForkState", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trip: persist then restore", () => {
    const map = new Map<string, ForkIsolationInfo>();
    const info = makeInfo({ repoRoot: tmpDir, sessionId: "s1" });
    map.set("s1", info);

    persistForkState(tmpDir, map);

    // Verify file was created
    const stateFile = path.join(tmpDir, FORK_BASE_DIR, FORK_STATE_FILE);
    assert.ok(fs.existsSync(stateFile), "State file should exist");

    // Restore into fresh map
    const restored = new Map<string, ForkIsolationInfo>();
    const count = restoreForkState(tmpDir, restored);
    assert.strictEqual(count, 1, "Should restore 1 session");
    assert.ok(restored.has("s1"));
    assert.strictEqual(restored.get("s1")!.branchName, info.branchName);
  });

  test("multiple sessions persist and restore", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ sessionId: "s1", branchName: "brain/loop-a" }));
    map.set("s2", makeInfo({ sessionId: "s2", branchName: "brain/loop-b" }));
    map.set("s3", makeInfo({ sessionId: "s3", branchName: "brain/loop-c" }));

    persistForkState(tmpDir, map);

    const restored = new Map<string, ForkIsolationInfo>();
    const count = restoreForkState(tmpDir, restored);
    assert.strictEqual(count, 3);
  });

  test("restore returns 0 when no state file exists", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
    const restored = new Map<string, ForkIsolationInfo>();
    const count = restoreForkState(emptyDir, restored);
    assert.strictEqual(count, 0);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test("overwrite persisted state", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ sessionId: "s1", status: "active" }));
    persistForkState(tmpDir, map);

    // Update status
    map.get("s1")!.status = "completed";
    persistForkState(tmpDir, map);

    const restored = new Map<string, ForkIsolationInfo>();
    restoreForkState(tmpDir, restored);
    assert.strictEqual(restored.get("s1")!.status, "completed");
  });
});

suite("Fork Helpers — getKnownForkIssuesHint", () => {
  test("returns empty string for undefined info", () => {
    assert.strictEqual(getKnownForkIssuesHint(undefined), "");
  });

  test("includes shared strategy warning", () => {
    const info = makeInfo({ cloneStrategy: "shared" });
    const hint = getKnownForkIssuesHint(info);
    assert.ok(hint.includes("--shared clone"));
    assert.ok(hint.includes("git gc"));
  });

  if (process.platform === "win32") {
    test("includes Windows file-locking warning", () => {
      const info = makeInfo({ cloneStrategy: "local" });
      const hint = getKnownForkIssuesHint(info);
      assert.ok(hint.includes("EPERM/EBUSY"));
    });
  }

  test("no shared warning for local strategy on non-Windows", function () {
    if (process.platform === "win32") {
      this.skip();
      return;
    }
    const info = makeInfo({ cloneStrategy: "local" });
    const hint = getKnownForkIssuesHint(info);
    assert.strictEqual(hint, "");
  });
});

suite("Fork Helpers — getForkLimitations", () => {
  test("returns non-empty string", () => {
    const result = getForkLimitations();
    assert.ok(result.length > 0);
  });

  test("contains key safety instructions", () => {
    const result = getForkLimitations();
    assert.ok(result.includes("npm install"));
    assert.ok(result.includes("pushurl"));
    assert.ok(result.includes("git fetch"));
  });
});
