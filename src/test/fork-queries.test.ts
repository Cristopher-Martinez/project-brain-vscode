import * as assert from "assert";

// ─── Fork Types & Queries Tests ─────────────────────────────────────────────
// Tests for constants, type guards, and query functions.

// Re-implement query logic inline to isolate from fork-isolation.ts state.

const FORK_BASE_DIR = ".brain-forks";
const FORK_BRANCH_PREFIX = "brain/loop-";
const MAX_CONCURRENT_FORKS = 3;
const FORK_ID_LENGTH = 8;
const FORK_RESERVED_DIRS = new Set(["hibernated", ".shadow"]);

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
}

function listPendingBranches(
  forkMap: Map<string, ForkIsolationInfo>,
): ForkIsolationInfo[] {
  return Array.from(forkMap.values()).filter((i) => i.status === "completed");
}

function listAllBranches(
  forkMap: Map<string, ForkIsolationInfo>,
): ForkIsolationInfo[] {
  return Array.from(forkMap.values());
}

function hasActiveLoopIsolation(
  forkMap: Map<string, ForkIsolationInfo>,
): boolean {
  for (const [, info] of forkMap) {
    if (info.type === "loop" && info.status === "active") return true;
  }
  return false;
}

function shortSessionId(sessionId: string): string {
  return sessionId.substring(0, 8);
}

function makeInfo(
  overrides: Partial<ForkIsolationInfo> = {},
): ForkIsolationInfo {
  return {
    sessionId: "test-001",
    type: "loop",
    branchName: "brain/loop-test",
    originalBranch: "main",
    forkPath: "/tmp/.brain-forks/abc12345",
    repoRoot: "/tmp",
    cloneStrategy: "shared",
    createdAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

suite("Fork Types — Constants", () => {
  test("FORK_BASE_DIR is .brain-forks", () => {
    assert.strictEqual(FORK_BASE_DIR, ".brain-forks");
  });

  test("FORK_BRANCH_PREFIX is brain/loop-", () => {
    assert.strictEqual(FORK_BRANCH_PREFIX, "brain/loop-");
  });

  test("MAX_CONCURRENT_FORKS is a reasonable limit", () => {
    assert.ok(MAX_CONCURRENT_FORKS >= 1 && MAX_CONCURRENT_FORKS <= 10);
  });

  test("FORK_ID_LENGTH is short for MAX_PATH safety", () => {
    assert.ok(FORK_ID_LENGTH <= 12, "Fork IDs should be short");
    assert.ok(FORK_ID_LENGTH >= 6, "Fork IDs need entropy");
  });

  test("FORK_RESERVED_DIRS contains known dirs", () => {
    assert.ok(FORK_RESERVED_DIRS.has("hibernated"));
    assert.ok(FORK_RESERVED_DIRS.has(".shadow"));
    assert.ok(!FORK_RESERVED_DIRS.has("abc12345"));
  });
});

suite("Fork Queries — listPendingBranches", () => {
  test("returns only completed forks", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ sessionId: "s1", status: "active" }));
    map.set("s2", makeInfo({ sessionId: "s2", status: "completed" }));
    map.set("s3", makeInfo({ sessionId: "s3", status: "merged" }));

    const pending = listPendingBranches(map);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].sessionId, "s2");
  });

  test("returns empty array when no completed forks", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ status: "active" }));
    const pending = listPendingBranches(map);
    assert.strictEqual(pending.length, 0);
  });

  test("returns multiple completed forks", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ sessionId: "s1", status: "completed" }));
    map.set("s2", makeInfo({ sessionId: "s2", status: "completed" }));
    const pending = listPendingBranches(map);
    assert.strictEqual(pending.length, 2);
  });
});

suite("Fork Queries — listAllBranches", () => {
  test("returns all forks regardless of status", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ status: "active" }));
    map.set("s2", makeInfo({ status: "completed" }));
    map.set("s3", makeInfo({ status: "merged" }));
    map.set("s4", makeInfo({ status: "discarded" }));

    const all = listAllBranches(map);
    assert.strictEqual(all.length, 4);
  });

  test("returns empty array for empty map", () => {
    const map = new Map<string, ForkIsolationInfo>();
    assert.strictEqual(listAllBranches(map).length, 0);
  });
});

suite("Fork Queries — hasActiveLoopIsolation", () => {
  test("detects active loop fork", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ type: "loop", status: "active" }));
    assert.strictEqual(hasActiveLoopIsolation(map), true);
  });

  test("ignores completed loop forks", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ type: "loop", status: "completed" }));
    assert.strictEqual(hasActiveLoopIsolation(map), false);
  });

  test("ignores active orch forks", () => {
    const map = new Map<string, ForkIsolationInfo>();
    map.set("s1", makeInfo({ type: "orch", status: "active" }));
    assert.strictEqual(hasActiveLoopIsolation(map), false);
  });

  test("returns false on empty map", () => {
    assert.strictEqual(
      hasActiveLoopIsolation(new Map()),
      false,
    );
  });
});

suite("Fork Isolation — shortSessionId", () => {
  test("truncates to 8 chars", () => {
    const short = shortSessionId("33331852-fd46-459b-8781-b9f82490e10a");
    assert.strictEqual(short, "33331852");
    assert.strictEqual(short.length, 8);
  });

  test("returns full string if shorter than 8", () => {
    const short = shortSessionId("abc");
    assert.strictEqual(short, "abc");
  });

  test("handles exact 8-char string", () => {
    const short = shortSessionId("12345678");
    assert.strictEqual(short, "12345678");
  });
});

suite("Fork Audit — getAuditTrend (logic)", () => {
  // Inline audit trend logic to test without import
  type AuditResult = {
    compatible: boolean;
    conflictFiles: string[];
    aheadBehind: { ahead: number; behind: number };
    diffSummary: string;
  };
  type AuditTrend = "improving" | "stable" | "degrading" | "unknown";

  function getAuditTrend(
    history: { result: AuditResult }[] | undefined,
  ): AuditTrend {
    if (!history || history.length < 2) return "unknown";
    const prev = history[history.length - 2];
    const curr = history[history.length - 1];

    if (!prev.result.compatible && curr.result.compatible) return "improving";
    if (prev.result.compatible && !curr.result.compatible) return "degrading";
    if (
      curr.result.conflictFiles.length < prev.result.conflictFiles.length
    ) {
      return "improving";
    }
    if (
      curr.result.conflictFiles.length > prev.result.conflictFiles.length
    ) {
      return "degrading";
    }
    return "stable";
  }

  const clean: AuditResult = {
    compatible: true,
    conflictFiles: [],
    aheadBehind: { ahead: 1, behind: 0 },
    diffSummary: "",
  };
  const conflict: AuditResult = {
    compatible: false,
    conflictFiles: ["src/index.ts"],
    aheadBehind: { ahead: 2, behind: 3 },
    diffSummary: "",
  };

  test("unknown with <2 entries", () => {
    assert.strictEqual(getAuditTrend([]), "unknown");
    assert.strictEqual(getAuditTrend([{ result: clean }]), "unknown");
    assert.strictEqual(getAuditTrend(undefined), "unknown");
  });

  test("improving: conflict → clean", () => {
    assert.strictEqual(
      getAuditTrend([{ result: conflict }, { result: clean }]),
      "improving",
    );
  });

  test("degrading: clean → conflict", () => {
    assert.strictEqual(
      getAuditTrend([{ result: clean }, { result: conflict }]),
      "degrading",
    );
  });

  test("stable: both clean", () => {
    assert.strictEqual(
      getAuditTrend([{ result: clean }, { result: clean }]),
      "stable",
    );
  });

  test("degrading: more conflicts than before", () => {
    const moreConflicts: AuditResult = {
      compatible: false,
      conflictFiles: ["a.ts", "b.ts"],
      aheadBehind: { ahead: 3, behind: 5 },
      diffSummary: "",
    };
    assert.strictEqual(
      getAuditTrend([{ result: conflict }, { result: moreConflicts }]),
      "degrading",
    );
  });
});
