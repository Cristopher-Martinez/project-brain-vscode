/**
 * T5-EL Orchestrator + Integrity Tests
 * Covers: FIX 5 (policyApplied, blockingReason, recoveredFromDirtyState), FIX 7 (recovery)
 */
import * as assert from "assert";
import { runT5EvolutionLayer, verifyIntegrity } from "../test-gate-mutation-el";
import type { T5ELConfig, T5ELDeps } from "../test-gate-mutation-el-types";
import { DEFAULT_T5EL_CONFIG } from "../test-gate-mutation-el-types";
import type {
  ModuleScore,
  MutantResult,
  T5Result,
} from "../test-gate-mutation-types";

function makeT5Result(overrides: Partial<T5Result> = {}): T5Result {
  return {
    name: "mutation-testing" as const,
    passed: true,
    blocking: false,
    skipped: false,
    rawGlobalScore: 75,
    globalScore: 72,
    equivalentExcluded: 3,
    criticalSurvivors: [] as MutantResult[],
    capped: false,
    mutantsSkippedDueToCap: 0,
    invalid: 1,
    hashVerified: true,
    mode: "enforce" as const,
    moduleScores: [] as ModuleScore[],
    highSurvivors: [] as MutantResult[],
    complexityAdjusted: true,
    executionTimeMs: 100,
    mutantReports: [] as MutantResult[],
    totalMutants: 50,
    killed: 30,
    survived: 15,
    timeout: 2,
    filesAnalyzed: 5,
    ready_for_T6: true,
    ...overrides,
  } as T5Result;
}

function makeDeps(
  files: Record<string, string> = {},
): T5ELDeps & { written: Record<string, string>; deleted: string[] } {
  const written: Record<string, string> = {};
  const deleted: string[] = [];
  return {
    written,
    deleted,
    readFile: async (p: string) => {
      if (p in written) {
        return written[p];
      }
      return files[p] ?? null;
    },
    writeFile: async (p: string, c: string) => {
      written[p] = c;
    },
    listDir: async (d: string) => {
      const all = { ...files };
      for (const [k, v] of Object.entries(written)) {
        all[k] = v;
      }
      return Object.keys(all)
        .filter((k) => k.startsWith(d + "/"))
        .map((k) => k.split("/").pop()!);
    },
    getCommitHash: async () => "abc123",
    getBranch: async () => "main",
    getT4PassStreak: async () => 5,
    restoreFile: async () => false,
    deleteFile: async (p: string) => {
      deleted.push(p);
    },
    log: () => {},
  };
}

function makeConfig(overrides: Partial<T5ELConfig> = {}): T5ELConfig {
  return { ...DEFAULT_T5EL_CONFIG, ...overrides };
}

suite("T5-EL Orchestrator", () => {
  test("produces valid FinalT5Result with new fields (FIX 5)", async () => {
    const deps = makeDeps();
    const result = await runT5EvolutionLayer(
      makeT5Result(),
      [],
      deps,
      makeConfig({ mode: "report" }),
    );
    assert.strictEqual(result.mode, "report");
    assert.strictEqual(result.policyApplied, "report");
    assert.strictEqual(result.blocking, false);
    assert.strictEqual(result.blockingReason, null);
    assert.strictEqual(result.recoveredFromDirtyState, false);
    assert.strictEqual(typeof result.rawScore, "number");
    assert.ok("maturityLevel" in result);
    // FIX 10/12/13 new fields
    assert.strictEqual(typeof result.baselineDrifted, "boolean");
    assert.strictEqual(typeof result.volumeDriftSuspicious, "boolean");
    assert.strictEqual(typeof result.policyConsistent, "boolean");
    assert.ok(
      result.historyIntegrity === "healthy" ||
        result.historyIntegrity === "degraded",
    );
  });

  test("returns skipped result when engine skipped", async () => {
    const deps = makeDeps();
    const result = await runT5EvolutionLayer(
      makeT5Result({ skipped: true }),
      [],
      deps,
      makeConfig(),
    );
    assert.strictEqual(result.rawScore, null);
    assert.strictEqual(result.blocking, false);
    assert.strictEqual(result.blockingReason, null);
    assert.strictEqual(result.recoveredFromDirtyState, false);
    // Skipped result has default safe values for new fields
    assert.strictEqual(result.baselineDrifted, false);
    assert.strictEqual(result.volumeDriftSuspicious, false);
    assert.strictEqual(result.policyConsistent, true);
    assert.strictEqual(result.historyIntegrity, "healthy");
  });

  test("persists artifact", async () => {
    const deps = makeDeps();
    await runT5EvolutionLayer(makeT5Result(), [], deps, makeConfig());
    assert.ok(deps.written[".mutation-history/abc123.json"]);
  });

  test("computes trend with history", async () => {
    const prev = {
      commit: "prev",
      timestamp: "2025-01-01T00:00:00Z",
      rawScore: 60,
      adjustedScore: 58,
      moduleScores: {},
      totalMutants: 50,
      killed: 30,
      survived: 15,
      timeout: 3,
      equivalent: 2,
      invalid: 0,
      criticalSurvivors: [],
      capped: false,
      mutantsSkippedDueToCap: 0,
    };
    const deps = makeDeps({
      ".mutation-history/prev.json": JSON.stringify(prev),
    });
    const result = await runT5EvolutionLayer(
      makeT5Result({ globalScore: 72 }),
      [],
      deps,
      makeConfig({ mode: "report" }),
    );
    assert.ok(result.trend !== null || result.deltaScore !== null);
  });

  test("blocks in enforce mode with low score (FIX 5: blockingReason)", async () => {
    const deps = makeDeps();
    const result = await runT5EvolutionLayer(
      makeT5Result({ globalScore: 40, rawGlobalScore: 42 }),
      [],
      deps,
      makeConfig({ mode: "enforce" }),
    );
    assert.strictEqual(result.blocking, true);
    assert.strictEqual(result.blockingReason, "global-threshold");
    assert.strictEqual(result.policyApplied, "enforce");
  });

  test("FIX 8: SHA-1 mutantId is 12-char hex", () => {
    const { computeMutantId } = require("../test-gate-mutation-el-types");
    const id = computeMutantId("src/a.ts", 10, ">=→>");
    assert.strictEqual(id.length, 12);
    assert.ok(/^[0-9a-f]{12}$/.test(id), `Expected hex, got: ${id}`);
    // Deterministic
    const id2 = computeMutantId("src/a.ts", 10, ">=→>");
    assert.strictEqual(id, id2);
    // Different inputs produce different IDs
    const id3 = computeMutantId("src/b.ts", 10, ">=→>");
    assert.notStrictEqual(id, id3);
  });
});

suite("T5-EL verifyIntegrity", () => {
  test("clean when hashes match", async () => {
    const content = "hello world";
    const deps = makeDeps({ "src/a.ts": content });
    // compute expected hash (same algorithm as simpleHash)
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    const expectedHash = `${content.length}:${hash}`;
    const hashes = new Map([["src/a.ts", expectedHash]]);
    const result = await verifyIntegrity(["src/a.ts"], hashes, deps);
    assert.strictEqual(result.clean, true);
    assert.strictEqual(result.corrupted.length, 0);
    assert.strictEqual(result.recovered.length, 0);
  });

  test("detects corrupted file and attempts recovery (FIX 7)", async () => {
    const deps = makeDeps({ "src/a.ts": "modified content" });
    const hashes = new Map([["src/a.ts", "5:999"]]);
    const result = await verifyIntegrity(["src/a.ts"], hashes, deps);
    assert.strictEqual(result.clean, false);
    assert.ok(result.corrupted.includes("src/a.ts"));
  });

  test("recovers dirty file via restoreFile (FIX 7)", async () => {
    const original = "original content";
    let hashVal = 0;
    for (let i = 0; i < original.length; i++) {
      hashVal = (hashVal << 5) - hashVal + original.charCodeAt(i);
      hashVal |= 0;
    }
    const expectedHash = `${original.length}:${hashVal}`;
    let currentContent = "dirty content";
    const deps: T5ELDeps = {
      readFile: async () => currentContent,
      writeFile: async () => {},
      listDir: async () => [],
      getCommitHash: async () => "abc",
      getBranch: async () => "main",
      getT4PassStreak: async () => 5,
      restoreFile: async () => {
        currentContent = original; // simulate git checkout
        return true;
      },
      deleteFile: async () => {},
      log: () => {},
    };
    const hashes = new Map([["src/a.ts", expectedHash]]);
    const result = await verifyIntegrity(["src/a.ts"], hashes, deps);
    assert.strictEqual(result.clean, true);
    assert.strictEqual(result.corrupted.length, 0);
    assert.ok(result.recovered.includes("src/a.ts"));
  });

  test("skips files without expected hash", async () => {
    const deps = makeDeps({ "src/a.ts": "content" });
    const result = await verifyIntegrity(["src/a.ts"], new Map(), deps);
    assert.strictEqual(result.clean, true);
  });

  test("skips files that dont exist", async () => {
    const deps = makeDeps();
    const hashes = new Map([["src/missing.ts", "5:999"]]);
    const result = await verifyIntegrity(["src/missing.ts"], hashes, deps);
    assert.strictEqual(result.clean, true);
  });
});
