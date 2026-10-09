/**
 * T5-EL Persistence Tests (types helpers + persistence + pruneHistory)
 * Covers: FIX 1 (Baseline Guard), FIX 4 (mutantId), FIX 6 (pruneHistory)
 */
import * as assert from "assert";
import {
  autoCreateBaseline,
  buildArtifact,
  computeBaselineChecksum,
  isValidArtifact,
  loadBaseline,
  loadHistory,
  loadRecentHistory,
  pruneHistory,
  saveArtifact,
  saveBaseline,
} from "../test-gate-mutation-el-persistence";
import type {
  MutantDetail,
  MutationBaseline,
  MutationRun,
  T5ELDeps,
} from "../test-gate-mutation-el-types";
import {
  computeMutantId,
  toModuleScoreMap,
  toMutantDetails,
} from "../test-gate-mutation-el-types";
import type {
  ModuleScore,
  MutantResult,
  MutantStatus,
  T5Result,
} from "../test-gate-mutation-types";

// ——— Factories ———
function makeMutantResult(overrides: Partial<MutantResult> = {}): MutantResult {
  return {
    mutant: {
      id: "m1",
      file: "src/a.ts",
      line: 10,
      column: 5,
      pos: 100,
      end: 110,
      originalText: ">=",
      mutatedText: ">",
      lineContent: "if (x >= 5)",
      operator: {
        original: ">=",
        mutated: ">",
        tier: 1 as const,
        description: "boundary",
      },
      functionName: "check",
      isExported: true,
      hasInvariant: false,
      astNodeKind: "BinaryExpression" as const,
    },
    status: "survived" as MutantStatus,
    executionTimeMs: 10,
    ...(overrides as Record<string, unknown>),
  } as unknown as MutantResult;
}

function makeRun(overrides: Partial<MutationRun> = {}): MutationRun {
  return {
    commit: "abc123",
    timestamp: "2025-01-01T00:00:00Z",
    rawScore: 60,
    adjustedScore: 58,
    moduleScores: { "src/a.ts": 70 },
    totalMutants: 50,
    killed: 30,
    survived: 15,
    timeout: 3,
    equivalent: 2,
    invalid: 0,
    criticalSurvivors: [],
    capped: false,
    mutantsSkippedDueToCap: 0,
    ...overrides,
  };
}

function makeDeps(
  files: Record<string, string> = {},
): T5ELDeps & { written: Record<string, string>; deleted: string[] } {
  const written: Record<string, string> = {};
  const deleted: string[] = [];
  return {
    written,
    deleted,
    readFile: async (p: string) => files[p] ?? null,
    writeFile: async (p: string, c: string) => {
      written[p] = c;
    },
    listDir: async (d: string) => {
      return Object.keys(files)
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

suite("T5-EL Types Helpers", () => {
  test("toMutantDetails filters survived and maps fields with mutantId", () => {
    const survived = makeMutantResult();
    const killed = makeMutantResult({ status: "killed" as MutantStatus });
    const result = toMutantDetails([survived, killed]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file, "src/a.ts");
    assert.strictEqual(result[0].operator, ">=→>");
    assert.ok(result[0].mutantId, "mutantId should exist");
    assert.strictEqual(typeof result[0].mutantId, "string");
  });

  test("toMutantDetails returns empty for no survivors", () => {
    const result = toMutantDetails([
      makeMutantResult({ status: "killed" as MutantStatus }),
    ]);
    assert.strictEqual(result.length, 0);
  });

  test("computeMutantId is deterministic", () => {
    const id1 = computeMutantId("src/a.ts", 10, ">=→>");
    const id2 = computeMutantId("src/a.ts", 10, ">=→>");
    assert.strictEqual(id1, id2);
  });

  test("computeMutantId differs for different inputs", () => {
    const id1 = computeMutantId("src/a.ts", 10, ">=→>");
    const id2 = computeMutantId("src/b.ts", 10, ">=→>");
    assert.notStrictEqual(id1, id2);
  });

  test("toModuleScoreMap maps file to adjustedScore", () => {
    const scores: ModuleScore[] = [
      {
        file: "a.ts",
        rawScore: 80,
        complexity: 5,
        penalty: 2,
        adjustedScore: 78,
        killed: 10,
        survived: 2,
        timeout: 0,
        equivalentExcluded: 0,
        invalid: 0,
        totalMutants: 12,
      },
    ];
    const map = toModuleScoreMap(scores);
    assert.strictEqual(map["a.ts"], 78);
  });

  test("toModuleScoreMap returns {} for empty", () => {
    assert.deepStrictEqual(toModuleScoreMap([]), {});
  });
});

suite("T5-EL Persistence", () => {
  test("buildArtifact maps T5Result correctly", () => {
    const t5 = {
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
    } as T5Result;
    const artifact = buildArtifact(t5, "abc", "main");
    assert.strictEqual(artifact.rawScore, 75);
    assert.strictEqual(artifact.adjustedScore, 72);
    assert.strictEqual(artifact.equivalent, 3);
    assert.strictEqual(artifact.commit, "abc");
  });

  test("saveArtifact writes JSON to correct path", async () => {
    const deps = makeDeps();
    const run = makeRun({ commit: "x1" });
    await saveArtifact(run, ".history", deps);
    assert.ok(deps.written[".history/x1.json"]);
  });

  test("loadHistory sorts newest first", async () => {
    const deps = makeDeps({
      ".h/a.json": JSON.stringify(
        makeRun({ commit: "a", timestamp: "2025-01-01T00:00:00Z" }),
      ),
      ".h/b.json": JSON.stringify(
        makeRun({ commit: "b", timestamp: "2025-06-01T00:00:00Z" }),
      ),
    });
    const { runs } = await loadHistory(".h", deps);
    assert.strictEqual(runs[0].commit, "b");
  });

  test("loadHistory skips corrupt JSON", async () => {
    const deps = makeDeps({ ".h/bad.json": "{invalid" });
    const { runs } = await loadHistory(".h", deps);
    assert.strictEqual(runs.length, 0);
  });

  test("loadHistory returns [] on empty dir", async () => {
    const deps = makeDeps();
    const { runs } = await loadHistory(".h", deps);
    assert.strictEqual(runs.length, 0);
  });

  test("loadRecentHistory limits count", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const ts = new Date(2025, 0, i + 1).toISOString();
      files[`.h/${i}.json`] = JSON.stringify(
        makeRun({ commit: `${i}`, timestamp: ts }),
      );
    }
    const deps = makeDeps(files);
    const { runs } = await loadRecentHistory(".h", deps, 3);
    assert.strictEqual(runs.length, 3);
  });

  test("loadBaseline returns null when not found", async () => {
    const deps = makeDeps();
    const b = await loadBaseline(".baseline.json", deps);
    assert.strictEqual(b, null);
  });

  test("loadBaseline parses valid JSON", async () => {
    const bl: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 2,
      baselineMutantIds: ["id1"],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const deps = makeDeps({ ".b.json": JSON.stringify(bl) });
    const b = await loadBaseline(".b.json", deps);
    assert.strictEqual(b?.baselineScore, 60);
    assert.deepStrictEqual(b?.baselineMutantIds, ["id1"]);
  });

  test("loadBaseline returns null on corrupt", async () => {
    const deps = makeDeps({ ".b.json": "not json" });
    const b = await loadBaseline(".b.json", deps);
    assert.strictEqual(b, null);
  });

  test("saveBaseline writes JSON", async () => {
    const deps = makeDeps();
    const bl: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    await saveBaseline(bl, ".b.json", deps);
    assert.ok(deps.written[".b.json"]);
  });

  test("autoCreateBaseline creates when score < threshold (FIX 1)", async () => {
    const deps = makeDeps();
    const detail: MutantDetail = {
      mutantId: "id1",
      file: "a.ts",
      line: 1,
      column: 1,
      operator: ">=→>",
      functionName: "f",
      astNodeKind: "BinaryExpression",
    };
    const artifact = makeRun({ rawScore: 48, criticalSurvivors: [detail] });
    const result = await autoCreateBaseline(artifact, 65, ".b.json", deps);
    assert.ok(result.baseline);
    assert.strictEqual(result.baselineLockActivated, true);
    assert.strictEqual(result.baseline!.baselineScore, 48);
    assert.deepStrictEqual(result.baseline!.baselineMutantIds, ["id1"]);
  });

  test("autoCreateBaseline returns existing when found (FIX 1)", async () => {
    const existing: MutationBaseline = {
      baselineScore: 50,
      baselineCritical: 0,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const deps = makeDeps({ ".b.json": JSON.stringify(existing) });
    const result = await autoCreateBaseline(makeRun(), 65, ".b.json", deps);
    assert.strictEqual(result.baseline!.baselineScore, 50);
    assert.strictEqual(result.baselineLockActivated, false);
  });

  test("autoCreateBaseline returns null when score >= threshold (FIX 1)", async () => {
    const deps = makeDeps();
    const artifact = makeRun({ rawScore: 72 });
    const result = await autoCreateBaseline(artifact, 65, ".b.json", deps);
    assert.strictEqual(result.baseline, null);
    assert.strictEqual(result.baselineLockActivated, false);
  });

  test("pruneHistory deletes oldest beyond maxEntries (FIX 6)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const ts = new Date(2025, 0, i + 1).toISOString();
      files[`.h/${i}.json`] = JSON.stringify(
        makeRun({ commit: `${i}`, timestamp: ts }),
      );
    }
    const deps = makeDeps(files);
    const deleted = await pruneHistory(".h", 3, deps);
    assert.strictEqual(deleted, 2);
    assert.strictEqual(deps.deleted.length, 2);
  });

  test("pruneHistory does nothing when within limit (FIX 6)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      files[`.h/${i}.json`] = JSON.stringify(
        makeRun({
          commit: `${i}`,
          timestamp: new Date(2025, 0, i + 1).toISOString(),
        }),
      );
    }
    const deps = makeDeps(files);
    const deleted = await pruneHistory(".h", 5, deps);
    assert.strictEqual(deleted, 0);
  });
});

// ——— FIX 9: History Integrity Guard ———
suite("T5-EL isValidArtifact (FIX 9)", () => {
  test("accepts valid artifact", () => {
    const a: MutationRun = {
      commit: "abc",
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
    assert.strictEqual(isValidArtifact(a), true);
  });

  test("rejects null/undefined", () => {
    assert.strictEqual(isValidArtifact(null), false);
    assert.strictEqual(isValidArtifact(undefined), false);
  });

  test("rejects missing commit", () => {
    assert.strictEqual(
      isValidArtifact({
        timestamp: "x",
        rawScore: 0,
        adjustedScore: 0,
        totalMutants: 0,
        killed: 0,
        survived: 0,
        criticalSurvivors: [],
      }),
      false,
    );
  });

  test("rejects NaN rawScore", () => {
    assert.strictEqual(
      isValidArtifact({
        commit: "a",
        timestamp: "x",
        rawScore: NaN,
        adjustedScore: 0,
        totalMutants: 0,
        killed: 0,
        survived: 0,
        criticalSurvivors: [],
      }),
      false,
    );
  });

  test("rejects negative totalMutants", () => {
    assert.strictEqual(
      isValidArtifact({
        commit: "a",
        timestamp: "x",
        rawScore: 0,
        adjustedScore: 0,
        totalMutants: -1,
        killed: 0,
        survived: 0,
        criticalSurvivors: [],
      }),
      false,
    );
  });

  test("loadHistory skips invalid artifacts", async () => {
    const invalid = JSON.stringify({ commit: "", rawScore: NaN });
    const valid = JSON.stringify({
      commit: "abc",
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
    });
    const files = { ".h/bad.json": invalid, ".h/good.json": valid };
    const deps = makeDeps(files);
    const { runs } = await loadHistory(".h", deps);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].commit, "abc");
  });
});

// ——— History Integrity Assessment ———
suite("T5-EL historyIntegrity", () => {
  test("healthy when all artifacts valid", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`.h/${i}.json`] = JSON.stringify(
        makeRun({
          commit: `c${i}`,
          timestamp: new Date(2025, 0, i + 1).toISOString(),
        }),
      );
    }
    const deps = makeDeps(files);
    const result = await loadHistory(".h", deps);
    assert.strictEqual(result.integrity, "healthy");
    assert.strictEqual(result.invalidCount, 0);
    assert.strictEqual(result.totalFiles, 5);
  });

  test("degraded when >20% artifacts invalid", async () => {
    const valid = JSON.stringify(
      makeRun({ commit: "v1", timestamp: "2025-01-01T00:00:00Z" }),
    );
    const files: Record<string, string> = {
      ".h/v1.json": valid,
      ".h/v2.json": JSON.stringify(
        makeRun({ commit: "v2", timestamp: "2025-01-02T00:00:00Z" }),
      ),
      ".h/v3.json": JSON.stringify(
        makeRun({ commit: "v3", timestamp: "2025-01-03T00:00:00Z" }),
      ),
      ".h/bad1.json": "{corrupt",
      ".h/bad2.json": JSON.stringify({ timestamp: "x" }), // missing required fields
    };
    const deps = makeDeps(files);
    const result = await loadHistory(".h", deps);
    // 2/5 = 40% invalid → degraded
    assert.strictEqual(result.integrity, "degraded");
    assert.strictEqual(result.invalidCount, 2);
    assert.strictEqual(result.runs.length, 3);
  });

  test("healthy at exactly 20% invalid (boundary)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) {
      files[`.h/v${i}.json`] = JSON.stringify(
        makeRun({
          commit: `v${i}`,
          timestamp: new Date(2025, 0, i + 1).toISOString(),
        }),
      );
    }
    files[".h/bad.json"] = "{corrupt";
    const deps = makeDeps(files);
    const result = await loadHistory(".h", deps);
    // 1/5 = 20% → exactly at boundary → healthy (not >20%)
    assert.strictEqual(result.integrity, "healthy");
  });

  test("healthy when empty dir", async () => {
    const deps = makeDeps();
    const result = await loadHistory(".h", deps);
    assert.strictEqual(result.integrity, "healthy");
    assert.strictEqual(result.totalFiles, 0);
  });

  test("loadRecentHistory preserves integrity from full history", async () => {
    const files: Record<string, string> = {
      ".h/v1.json": JSON.stringify(
        makeRun({ commit: "v1", timestamp: "2025-01-01T00:00:00Z" }),
      ),
      ".h/bad1.json": "{corrupt",
      ".h/bad2.json": "{corrupt",
    };
    const deps = makeDeps(files);
    const result = await loadRecentHistory(".h", deps, 10);
    // 2/3 = 66% invalid → degraded
    assert.strictEqual(result.integrity, "degraded");
    assert.strictEqual(result.runs.length, 1);
  });
});

// ——— FIX 11: Baseline Tampering Guard ———
suite("T5-EL Baseline Checksum (FIX 11)", () => {
  test("saveBaseline adds _checksum", async () => {
    const baseline: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: ["id1"],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const deps = makeDeps();
    await saveBaseline(baseline, ".baseline.json", deps);
    const saved = JSON.parse(deps.written[".baseline.json"]);
    assert.ok(saved._checksum, "checksum should be present");
    assert.strictEqual(typeof saved._checksum, "string");
    assert.ok(saved._checksum.length > 0);
  });

  test("loadBaseline passes with valid checksum", async () => {
    const baseline: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const checksum = computeBaselineChecksum(baseline);
    const withChecksum = { ...baseline, _checksum: checksum };
    const deps = makeDeps({ ".baseline.json": JSON.stringify(withChecksum) });
    const loaded = await loadBaseline(".baseline.json", deps);
    assert.ok(loaded, "should load valid baseline");
    assert.strictEqual(loaded!.baselineScore, 60);
  });

  test("loadBaseline rejects tampered checksum", async () => {
    const baseline: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const tampered = {
      ...baseline,
      _checksum: "forged0000000000",
      baselineScore: 90,
    };
    const deps = makeDeps({ ".baseline.json": JSON.stringify(tampered) });
    const loaded = await loadBaseline(".baseline.json", deps);
    assert.strictEqual(loaded, null, "tampered baseline should be rejected");
  });

  test("loadBaseline accepts baseline without checksum (backward compat)", async () => {
    const baseline: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: [],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const deps = makeDeps({ ".baseline.json": JSON.stringify(baseline) });
    const loaded = await loadBaseline(".baseline.json", deps);
    assert.ok(loaded, "should load baseline without checksum");
  });

  test("computeBaselineChecksum is deterministic", () => {
    const bl: MutationBaseline = {
      baselineScore: 60,
      baselineCritical: 1,
      baselineMutantIds: ["a"],
      createdAt: "2025-01-01T00:00:00Z",
    };
    const c1 = computeBaselineChecksum(bl);
    const c2 = computeBaselineChecksum(bl);
    assert.strictEqual(c1, c2);
  });
});
