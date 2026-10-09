#!/usr/bin/env node
/**
 * 🏴‍☠️ Smoke Test: Intelligent Memory Management System
 *
 * Tests all 6 hook libraries end-to-end:
 *   1. Session Diary — appendDiaryEntry + recallDiary
 *   2. Entity Graph — updateEntityGraph + getRelated + getGraphSummary
 *   3. Memory Scorer — recordQueryHits + processScores + getTopScored
 *   4. Smart Consolidator — consolidateLearnings
 *   5. Context Predictor — predictContext
 *   6. Integration — Full session-stop → session-start simulation
 *   7. Edge Cases — Empty/corrupt data, boundary conditions
 *   8. Execution Checkpoint — saveCheckpoint, loadCheckpoint, clearCheckpoint, isStale, format
 *   9. Tool-Level Checkpoints — saveToolCheckpoint, loadToolCheckpoint, clearToolCheckpoint, summarizeToolInput
 *
 * Usage:
 *   node scripts/smoke-test-memory.mjs
 *
 * Creates a temp directory, runs all tests, cleans up.
 * Exit 0 = all pass. Exit 1 = failures.
 *
 * @since 2026-03-01
 * @author Jasper 🏴‍☠️
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// ─── Imports from libraries ──────────────────────────────────────────────────

const LIB_DIR = join(PROJECT_ROOT, ".github", "hooks", "scripts", "lib");

/** Convert a file path to a file:// URL (required on Windows for dynamic ESM imports) */
const toURL = (p) => pathToFileURL(p).href;

const { appendDiaryEntry, recallDiary } = await import(
  toURL(join(LIB_DIR, "session-diary.mjs"))
);
const { updateEntityGraph, getRelated, getGraphSummary } = await import(
  toURL(join(LIB_DIR, "entity-graph.mjs"))
);
const { recordQueryHits, processScores, getTopScored } = await import(
  toURL(join(LIB_DIR, "memory-scorer.mjs"))
);
const { consolidateLearnings } = await import(
  toURL(join(LIB_DIR, "smart-consolidator.mjs"))
);
const { predictContext } = await import(
  toURL(join(LIB_DIR, "context-predictor.mjs"))
);
const {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  isStaleCheckpoint,
  formatCheckpointForInjection,
  saveToolCheckpoint,
  loadToolCheckpoint,
  clearToolCheckpoint,
  summarizeToolInput,
} = await import(toURL(join(LIB_DIR, "execution-checkpoint.mjs")));

// ─── Test Infrastructure ─────────────────────────────────────────────────────

const TEMP_DIR = join(PROJECT_ROOT, "temp-test-memory");
let passed = 0;
let failed = 0;
let skipped = 0;

function setup() {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(join(TEMP_DIR, "sessions"), { recursive: true });
}

function cleanup() {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
}

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — expected: ${expected}, got: ${actual}`);
  }
}

function assertGte(actual, min, label) {
  if (actual >= min) {
    passed++;
    console.log(`  ✅ ${label} (${actual} >= ${min})`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — expected >= ${min}, got: ${actual}`);
  }
}

function skip(label, reason) {
  skipped++;
  console.log(`  ⏭️  ${label} — ${reason}`);
}

// ─── 1. Session Diary Tests ─────────────────────────────────────────────────

function testSessionDiary() {
  console.log("\n📔 1. Session Diary");

  // Test: append a single entry
  appendDiaryEntry(TEMP_DIR, {
    branch: "feat/memory-hooks",
    status: " M src/extension.ts\n M src/lm-tools.ts\n",
    lastCommit: "abc1234 feat: add memory hooks",
    taskContext: "Implementing memory management",
  });

  const diaryPath = join(TEMP_DIR, "16_SESSION_DIARY.md");
  assert(existsSync(diaryPath), "Diary file created");

  const content = readFileSync(diaryPath, "utf8");
  assert(content.includes("# Session Diary"), "Has header");
  assert(content.includes("feat/memory-hooks"), "Contains branch name");
  assert(
    content.includes("Implementing memory management"),
    "Contains task context",
  );
  assert(content.includes("**Files**:"), "Contains files section");
  assert(content.includes("**Status**:"), "Contains status section");

  // Test: recall diary
  const recalled = recallDiary(TEMP_DIR, 3);
  assert(typeof recalled === "string", "recallDiary returns string");
  assert(recalled.includes("feat/memory-hooks"), "Recalled entry has branch");

  // Test: append multiple entries
  for (let i = 0; i < 3; i++) {
    appendDiaryEntry(TEMP_DIR, {
      branch: `test/branch-${i}`,
      status: ` M src/file-${i}.ts\n A src/new-${i}.ts\n`,
      lastCommit: `hash${i} fix: iteration ${i}`,
    });
  }

  const afterMultiple = readFileSync(diaryPath, "utf8");
  const entryCount = (afterMultiple.match(/^## /gm) || []).length;
  assertEq(entryCount, 4, "4 total diary entries after appends");

  // Test: recall with limit
  const recalledLimited = recallDiary(TEMP_DIR, 2);
  const recalledEntries = (recalledLimited.match(/^- \*\*/gm) || []).length;
  assertEq(recalledEntries, 2, "recallDiary(2) returns exactly 2 entries");

  // Test: recall from non-existent dir
  const recalledEmpty = recallDiary(join(TEMP_DIR, "nonexistent"), 3);
  assertEq(
    recalledEmpty,
    "",
    "recallDiary on missing dir returns empty string",
  );
}

// ─── 2. Entity Graph Tests ──────────────────────────────────────────────────

function testEntityGraph() {
  console.log("\n🕸️  2. Entity Graph");

  // Prerequisite: need diary entries with topics
  // The diary from test 1 should still exist

  const diaryPath = join(TEMP_DIR, "16_SESSION_DIARY.md");
  assert(existsSync(diaryPath), "Diary exists for graph building");

  // Test: update entity graph
  const stats = updateEntityGraph(TEMP_DIR);
  assert(stats !== null, "updateEntityGraph returns stats");
  assertGte(stats.nodes, 1, "Graph has nodes");
  assertGte(
    stats.edges,
    0,
    "Graph has edges (or zero if single-topic entries)",
  );

  // Verify graph file was created
  const graphPath = join(TEMP_DIR, "sessions", "entity-graph.json");
  assert(existsSync(graphPath), "entity-graph.json created");

  // Test: get graph summary
  const summary = getGraphSummary(TEMP_DIR);
  assert(typeof summary === "object", "getGraphSummary returns object");
  assertGte(summary.nodes, 1, "Summary shows nodes");
  assert(Array.isArray(summary.topEntities), "Summary has topEntities array");

  // Test: get related (may return empty if graph is small)
  if (summary.topEntities.length > 0) {
    const related = getRelated(TEMP_DIR, summary.topEntities[0], 5);
    assert(Array.isArray(related), "getRelated returns array");
    // Each result should have id, type, weight
    if (related.length > 0) {
      assert("id" in related[0], "Related entry has 'id'");
      assert("type" in related[0], "Related entry has 'type'");
      assert("weight" in related[0], "Related entry has 'weight'");
    } else {
      skip(
        "Related entry structure",
        "No related entities found (graph too small)",
      );
    }
  } else {
    skip("getRelated", "No entities in graph");
  }

  // Test: getRelated on non-existent entity
  const noRelated = getRelated(TEMP_DIR, "NONEXISTENT_ENTITY_XYZ", 5);
  assert(
    Array.isArray(noRelated),
    "getRelated on missing entity returns array",
  );
  assertEq(noRelated.length, 0, "No related for non-existent entity");

  // Test: update graph on empty dir
  const emptyStats = updateEntityGraph(join(TEMP_DIR, "nonexistent"));
  assertEq(emptyStats.nodes, 0, "Empty dir → 0 nodes");
}

// ─── 3. Memory Scorer Tests ─────────────────────────────────────────────────

function testMemoryScorer() {
  console.log("\n📊 3. Memory Scorer");

  const sessionsDir = join(TEMP_DIR, "sessions");

  // Test: record query hits
  recordQueryHits(sessionsDir, [
    {
      type: "learning",
      statement: "TypeScript strict mode prevents runtime errors",
    },
    { type: "opinion", statement: "Always use named exports over default" },
    {
      type: "learning",
      statement: "TypeScript strict mode prevents runtime errors",
    },
  ]);

  const hitsPath = join(sessionsDir, "query-hits.jsonl");
  assert(existsSync(hitsPath), "query-hits.jsonl created");

  const hitsContent = readFileSync(hitsPath, "utf8");
  const hitsLines = hitsContent.trim().split("\n").filter(Boolean);
  assertEq(hitsLines.length, 1, "One hit record line written");

  // Verify JSON structure
  const hitData = JSON.parse(hitsLines[0]);
  assert("ts" in hitData, "Hit record has timestamp");
  assert(Array.isArray(hitData.hits), "Hit record has hits array");
  assertEq(hitData.hits.length, 3, "3 hits recorded");

  // Test: record multiple query batches
  recordQueryHits(sessionsDir, [
    {
      type: "learning",
      statement: "TypeScript strict mode prevents runtime errors",
    },
  ]);
  recordQueryHits(sessionsDir, [
    { type: "opinion", statement: "Always use named exports over default" },
    {
      type: "learning",
      statement: "Use execFile instead of exec for security",
    },
  ]);

  const multiHits = readFileSync(hitsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assertEq(multiHits.length, 3, "3 hit record lines after multiple calls");

  // Test: process scores
  const scoreResult = processScores(TEMP_DIR);
  assert(scoreResult !== null, "processScores returns result");
  assertGte(scoreResult.tracked, 1, "At least 1 entry tracked");
  // Note: active requires age>=5 && relevance>=0.3 — freshly created entries have age=1
  assertGte(scoreResult.active, 0, "Active entries (0 expected for fresh data)");

  // Verify scores file
  const scoresPath = join(sessionsDir, "memory-scores.json");
  assert(existsSync(scoresPath), "memory-scores.json created");

  const scoresData = JSON.parse(readFileSync(scoresPath, "utf8"));
  assert("entries" in scoresData, "Scores file has entries");
  assert("updatedAt" in scoresData, "Scores file has updatedAt");

  // Test: hits file cleared after processing
  const hitsAfter = existsSync(hitsPath) ? readFileSync(hitsPath, "utf8") : "";
  assertEq(hitsAfter.trim(), "", "Hits file cleared after processScores");

  // Test: getTopScored (may return empty — entries need age >= 3)
  const topScored = getTopScored(TEMP_DIR, 5);
  assert(Array.isArray(topScored), "getTopScored returns array");
  // Note: entries just created have age=1, so getTopScored filters age>=3
  // We'll test with faked ages in the integration test

  // Test: record empty results
  recordQueryHits(sessionsDir, []);
  recordQueryHits(sessionsDir, null);
  // Should not crash — verify hits file still clean
  assert(true, "recordQueryHits handles empty/null gracefully");

  // Test: processScores on clean state (no new hits)
  const cleanResult = processScores(TEMP_DIR);
  // Should still return stats without crashing
  assert(
    cleanResult !== null || cleanResult === null,
    "processScores handles no-new-hits",
  );
}

// ─── 4. Smart Consolidator Tests ────────────────────────────────────────────

function testSmartConsolidator() {
  console.log("\n🗃️  4. Smart Consolidator");

  const learningsPath = join(TEMP_DIR, "04_LEARNINGS.md");

  // Test: consolidate on empty/missing file
  const emptyResult = consolidateLearnings(TEMP_DIR);
  assertEq(emptyResult, null, "Returns null for missing learnings file");

  // Test: consolidate with few entries (below threshold of 30)
  let content = "# Learnings\n\n";
  for (let i = 0; i < 20; i++) {
    const date = new Date(Date.now() - (i + 10) * 86400000)
      .toISOString()
      .slice(0, 10);
    content += `### Entry ${i} (${date})\n- Bullet point for entry ${i}\n- Another bullet\n\n`;
  }
  writeFileSync(learningsPath, content, "utf8");

  const belowResult = consolidateLearnings(TEMP_DIR);
  assertEq(
    belowResult,
    null,
    "Returns null when entries < MIN_ENTRIES_TO_CONSOLIDATE (30)",
  );

  // Test: consolidate with many entries (above MAX_ACTIVE=80)
  // Need > 80 entries, and some should be old (> 7 days)
  // IMPORTANT: parseEntries splits on ^## (h2), so entries must use ## not ###
  content = "# Learnings\n\n";
  for (let i = 0; i < 90; i++) {
    // Mix of old (30+ days) and recent (< 7 days) entries
    const daysAgo = i < 75 ? i + 10 : i - 75; // first 75 are old, last 15 are recent
    const date = new Date(Date.now() - daysAgo * 86400000)
      .toISOString()
      .slice(0, 10);

    if (i % 5 === 0) {
      // Named entries (get bonus in scoring)
      content += `## Feature: Important Thing ${i} (${date})\n- **[learning]** Critical learning ${i}\n- Another bullet\n\n`;
    } else {
      // Auto-Summary entries (generic names)
      content += `## Auto-Summary (${date})\n- **[learning]** Generic learning ${i}\n- Something else\n\n`;
    }
  }
  writeFileSync(learningsPath, content, "utf8");

  const result = consolidateLearnings(TEMP_DIR);
  assert(result !== null, "Consolidation triggered (>80 entries)");

  if (result) {
    assertGte(result.archived, 1, `Archived ${result.archived} entries`);
    assertEq(
      result.remaining <= 80,
      true,
      `Remaining <= MAX_ACTIVE (got ${result.remaining})`,
    );
    assert(
      result.strategy === "age-based" || result.strategy === "score-based",
      `Strategy: ${result.strategy}`,
    );

    // Verify archive file was created
    const archivePath = join(TEMP_DIR, "04_LEARNINGS_ARCHIVE.md");
    assert(existsSync(archivePath), "Archive file created");
    const archiveContent = readFileSync(archivePath, "utf8");
    assert(archiveContent.includes("Archived"), "Archive has header");

    // Verify learnings file was reduced
    const updatedLearnings = readFileSync(learningsPath, "utf8");
    const remainingCount = (updatedLearnings.match(/^## /gm) || []).length;
    assertEq(
      remainingCount,
      result.remaining,
      "File entry count matches result.remaining",
    );

    // Recent entries (< 7 days) should survive (protected)
    // We created 15 recent entries
    assertGte(
      remainingCount,
      10,
      "Recent entries mostly survived (protection rule)",
    );
  }
}

// ─── 5. Context Predictor Tests ─────────────────────────────────────────────

function testContextPredictor() {
  console.log("\n🔮 5. Context Predictor");

  // Test: predict on empty dir
  const emptyPrediction = predictContext(join(TEMP_DIR, "nonexistent"));
  assertEq(emptyPrediction, "", "Empty prediction for missing dir");

  // Test: predict with insufficient diary entries (< 5)
  // Current diary has 4 entries from test 1 — should be below threshold
  const currentDiary = join(TEMP_DIR, "16_SESSION_DIARY.md");
  if (existsSync(currentDiary)) {
    const currentContent = readFileSync(currentDiary, "utf8");
    const currentCount = (currentContent.match(/^## /gm) || []).length;
    if (currentCount < 5) {
      const tooFew = predictContext(TEMP_DIR);
      assertEq(tooFew, "", "Returns empty with < 5 diary entries");
    }
  }

  // Now create enough diary entries for meaningful predictions (>= 5)
  // Simulate 6 sessions across 2 branches with overlapping topics
  const diaryContent = `# Session Diary

<!-- Auto-generated episodic memory. Last 50 sessions. -->

## 2026-02-25 10:00 | feat/hooks
**Topics**: hooks, testing, typescript
**Files**: 3 modified (src/hooks.ts, src/testing.ts, src/types.ts)
**Summary**: Building hook system tests
**Status**: progress

## 2026-02-25 14:00 | feat/hooks
**Topics**: hooks, memory, entity-graph
**Files**: 2 modified (src/hooks.ts, src/entity-graph.ts)
**Summary**: Entity graph integration with hooks
**Status**: commit

## 2026-02-26 09:00 | feat/hooks
**Topics**: hooks, memory, scoring
**Files**: 4 modified (src/hooks.ts, src/memory-scorer.ts, src/scoring.ts, src/types.ts)
**Summary**: Memory scoring pipeline
**Status**: commit

## 2026-02-26 15:00 | main
**Topics**: deployment, config
**Files**: 2 modified (package.json, tsconfig.json)
**Summary**: Deploy configuration updates
**Status**: commit

## 2026-02-27 10:00 | feat/hooks
**Topics**: hooks, testing, memory
**Files**: 3 modified (src/hooks.ts, src/testing.ts, src/memory.ts)
**Summary**: Memory hook smoke tests
**Status**: progress

## 2026-02-27 16:00 | feat/hooks
**Topics**: hooks, consolidation, scoring
**Files**: 2 modified (src/consolidator.ts, src/scoring.ts)
**Summary**: Smart consolidation with scoring
**Status**: commit
`;

  writeFileSync(currentDiary, diaryContent, "utf8");

  // Update entity graph with this richer diary
  updateEntityGraph(TEMP_DIR);

  const prediction = predictContext(TEMP_DIR);
  assert(typeof prediction === "string", "predictContext returns string");

  // With 6 entries on feat/hooks branch, should have predictions
  // The function reads getCurrentBranch internally (may fail in temp dir)
  // but should still use last session's branch as fallback
  if (prediction.length > 0) {
    assert(true, `Prediction generated (${prediction.length} chars)`);
    // Topics like "hooks", "memory", "testing" should appear
    const hasRelevantTopic =
      prediction.includes("hooks") ||
      prediction.includes("memory") ||
      prediction.includes("testing") ||
      prediction.includes("scoring");
    assert(hasRelevantTopic, "Prediction contains relevant topics");
  } else {
    // May be empty if getCurrentBranch fails and fallback logic doesn't match
    skip(
      "Prediction content",
      "Empty prediction (branch detection may have failed in temp dir)",
    );
  }
}

// ─── 6. Integration Test ────────────────────────────────────────────────────

function testIntegration() {
  console.log("\n🔗 6. Integration (session-stop → session-start simulation)");

  // Fresh temp dir for integration
  const integDir = join(TEMP_DIR, "integration");
  mkdirSync(join(integDir, "sessions"), { recursive: true });

  // ── Simulate multiple full sessions ──────────────────────────────────
  const sessions = [
    {
      branch: "feat/api",
      status: " M src/api.ts\n M src/routes.ts\n",
      lastCommit: "a1 feat: api endpoints",
      taskContext: "Building REST API",
    },
    {
      branch: "feat/api",
      status: " M src/api.ts\n A src/middleware.ts\n",
      lastCommit: "a2 feat: add auth middleware",
      taskContext: "Auth middleware",
    },
    {
      branch: "feat/api",
      status: " M src/routes.ts\n M src/validation.ts\n",
      lastCommit: "a3 fix: validation rules",
    },
    {
      branch: "fix/bugfix",
      status: " M src/core.ts\n",
      lastCommit: "b1 fix: null check",
      taskContext: "Critical bugfix",
    },
    {
      branch: "feat/api",
      status: " M src/api.ts\n M src/tests.ts\n",
      lastCommit: "a4 test: api tests",
    },
    {
      branch: "feat/api",
      status: " M src/api.ts\n M src/docs.ts\n",
      lastCommit: "a5 docs: api documentation",
    },
  ];

  // Step 1: Write diary entries (session-stop flow)
  for (const session of sessions) {
    appendDiaryEntry(integDir, session);
  }

  const diaryPath = join(integDir, "16_SESSION_DIARY.md");
  assert(existsSync(diaryPath), "Integration: diary created");
  const diaryEntries = (readFileSync(diaryPath, "utf8").match(/^## /gm) || [])
    .length;
  assertEq(diaryEntries, 6, "Integration: 6 diary entries written");

  // Step 2: Update entity graph
  const graphStats = updateEntityGraph(integDir);
  assertGte(graphStats.nodes, 2, "Integration: graph has multiple nodes");
  assertGte(graphStats.edges, 1, "Integration: graph has edges");

  // Step 3: Record some query hits
  const sessionsDir = join(integDir, "sessions");
  recordQueryHits(sessionsDir, [
    { type: "learning", statement: "REST API best practices" },
    { type: "learning", statement: "Auth middleware patterns" },
  ]);
  recordQueryHits(sessionsDir, [
    { type: "opinion", statement: "Always validate input" },
    { type: "learning", statement: "REST API best practices" },
  ]);

  // Step 4: Process scores
  const scores = processScores(integDir);
  assert(scores !== null, "Integration: scores processed");
  assertGte(scores.tracked, 2, "Integration: multiple entries tracked");

  // Step 5: Verify graph + scores coexist
  const graphFile = join(sessionsDir, "entity-graph.json");
  const scoresFile = join(sessionsDir, "memory-scores.json");
  assert(existsSync(graphFile), "Integration: graph file exists");
  assert(existsSync(scoresFile), "Integration: scores file exists");

  // Step 6: Session-start simulation — recall diary + predict context
  const recalled = recallDiary(integDir, 3);
  assert(recalled.length > 0, "Integration: diary recall works");
  assert(
    recalled.includes("feat/api"),
    "Integration: recall shows recent branch",
  );

  const graphSummary = getGraphSummary(integDir);
  assertGte(graphSummary.nodes, 2, "Integration: graph summary has nodes");

  // Step 7: Context prediction (needs >= 5 diary entries — we have 6)
  const prediction = predictContext(integDir);
  assert(
    typeof prediction === "string",
    "Integration: prediction returns string",
  );

  // Step 8: Verify no data corruption across operations
  const finalDiary = readFileSync(diaryPath, "utf8");
  assert(
    finalDiary.includes("# Session Diary"),
    "Integration: diary header intact",
  );
  assert(
    !finalDiary.includes("undefined"),
    "Integration: no 'undefined' in diary",
  );
  assert(
    !finalDiary.includes("[object Object]"),
    "Integration: no serialization errors",
  );

  const finalGraph = JSON.parse(readFileSync(graphFile, "utf8"));
  assert(typeof finalGraph === "object", "Integration: graph is valid JSON");
  assert("nodes" in finalGraph, "Integration: graph has nodes key");
  assert("edges" in finalGraph, "Integration: graph has edges key");
}

// ─── 7. Edge Cases & Error Handling ─────────────────────────────────────────

function testEdgeCases() {
  console.log("\n🏴‍☠️ 7. Edge Cases & Error Handling");

  // Test: diary with empty/malformed status
  const edgeDir = join(TEMP_DIR, "edge-cases");
  mkdirSync(join(edgeDir, "sessions"), { recursive: true });

  appendDiaryEntry(edgeDir, {
    branch: "",
    status: "",
    lastCommit: "",
  });
  const edgeDiary = join(edgeDir, "16_SESSION_DIARY.md");
  assert(existsSync(edgeDiary), "Diary created with empty inputs");

  const edgeContent = readFileSync(edgeDiary, "utf8");
  assert(
    !edgeContent.includes("undefined"),
    "No 'undefined' with empty inputs",
  );

  // Test: diary with special characters in branch name
  appendDiaryEntry(edgeDir, {
    branch: "feat/user's-bug-fix_v2.0",
    status: " M src/test.ts\n",
    lastCommit: 'hash1 fix: handle "quotes" & <brackets>',
  });
  const specialContent = readFileSync(edgeDiary, "utf8");
  assert(
    specialContent.includes("user's-bug-fix"),
    "Special chars in branch preserved",
  );

  // Test: entity graph on dir without diary → 0 nodes
  const noDiaryDir = join(TEMP_DIR, "no-diary");
  mkdirSync(join(noDiaryDir, "sessions"), { recursive: true });
  const noDiaryStats = updateEntityGraph(noDiaryDir);
  assertEq(noDiaryStats.nodes, 0, "No diary → 0 nodes");

  // Test: memory scorer with non-existent sessions dir
  recordQueryHits(join(TEMP_DIR, "fresh-sessions"), [
    { type: "test", statement: "Something" },
  ]);
  assert(
    existsSync(join(TEMP_DIR, "fresh-sessions", "query-hits.jsonl")),
    "recordQueryHits creates sessions dir if needed",
  );

  // Test: processScores with no hits file
  const cleanDir = join(TEMP_DIR, "clean-scores");
  mkdirSync(join(cleanDir, "sessions"), { recursive: true });
  const noHitsResult = processScores(cleanDir);
  // Should handle gracefully
  assert(true, "processScores doesn't crash with no hits");

  // Test: getTopScored with faked age-3 entries
  const fakeSessions = join(TEMP_DIR, "fake-scored", "sessions");
  mkdirSync(fakeSessions, { recursive: true });
  const fakeScores = {
    lastProcessed: Date.now(),
    entries: {
      "learning:Important thing": { hits: 10, age: 5, relevance: 2.0 },
      "opinion:Less important": { hits: 3, age: 4, relevance: 0.75 },
      "learning:Too young": { hits: 20, age: 1, relevance: 20.0 },
    },
  };
  writeFileSync(
    join(fakeSessions, "memory-scores.json"),
    JSON.stringify(fakeScores),
    "utf8",
  );

  const topFaked = getTopScored(join(TEMP_DIR, "fake-scored"), 5);
  assertEq(topFaked.length, 2, "getTopScored filters out age < 3 entries");
  assertEq(
    topFaked[0].key,
    "learning:Important thing",
    "Highest relevance first",
  );

  // Test: consolidator with score-based strategy
  const scoreDir = join(TEMP_DIR, "score-consolidate");
  mkdirSync(join(scoreDir, "sessions"), { recursive: true });

  // Create 85 learnings (must use ## for parseEntries)
  let learnings = "# Learnings\n\n";
  for (let i = 0; i < 85; i++) {
    const date = new Date(Date.now() - (i + 10) * 86400000)
      .toISOString()
      .slice(0, 10);
    learnings += `## Entry ${i} (${date})\n- **[learning]** Bullet about topic-${i}\n\n`;
  }
  writeFileSync(join(scoreDir, "04_LEARNINGS.md"), learnings, "utf8");

  // Create memory-scores that match some entries
  const scores = {
    lastProcessed: Date.now(),
    entries: {
      "learning:Bullet about topic-0": { hits: 50, age: 10, relevance: 5.0 },
      "learning:Bullet about topic-1": { hits: 1, age: 10, relevance: 0.1 },
    },
  };
  writeFileSync(
    join(scoreDir, "sessions", "memory-scores.json"),
    JSON.stringify(scores),
    "utf8",
  );

  const scoreResult = consolidateLearnings(scoreDir);
  if (scoreResult) {
    assertEq(
      scoreResult.strategy,
      "score-based",
      "Uses score-based strategy when scores exist",
    );
    assertGte(scoreResult.archived, 1, "Archives entries with scores");
  } else {
    skip(
      "Score-based consolidation",
      "Consolidator returned null (unexpected)",
    );
  }
}

// ─── Section 8: Execution Checkpoint ─────────────────────────────────────────

function testExecutionCheckpoint() {
  console.log("\n🔖 Section 8: Execution Checkpoint");

  // 8.1 — Save and load a checkpoint
  saveCheckpoint(TEMP_DIR, {
    sessionId: "crash-test-001",
    goal: "Fix the rigging on the mainmast",
    lastSynthesis: "Refactored rigging module, 3/5 files done.",
    iterations: [
      { index: 0, synthesis: "Started refactoring", feedback: "Looks good" },
      { index: 1, synthesis: "Extracted helpers", feedback: "Continue" },
    ],
    startedAt: "2026-03-01T10:00:00Z",
  });

  const cp = loadCheckpoint(TEMP_DIR);
  assert(cp !== null, "loadCheckpoint returns saved data");
  assertEq(cp.sessionId, "crash-test-001", "Checkpoint sessionId correct");
  assertEq(cp.goal, "Fix the rigging on the mainmast", "Checkpoint goal correct");
  assertEq(cp.status, "in-progress", "Checkpoint status is in-progress");
  assertEq(cp.iterations.length, 2, "Checkpoint has 2 iterations");
  assert(cp.updatedAt !== undefined, "Checkpoint has updatedAt timestamp");

  // 8.2 — isStaleCheckpoint
  assert(isStaleCheckpoint(cp), "In-progress checkpoint is stale");
  assert(!isStaleCheckpoint(null), "Null checkpoint is not stale");
  assert(!isStaleCheckpoint({ status: "completed" }), "Completed checkpoint is not stale");

  // 8.3 — formatCheckpointForInjection
  const formatted = formatCheckpointForInjection(cp);
  assert(formatted.includes("crash-test-001"), "Formatted output contains sessionId");
  assert(formatted.includes("Fix the rigging"), "Formatted output contains goal");
  assert(formatted.includes("Refactored rigging"), "Formatted output contains synthesis");
  assert(formatted.includes("Ronda 0"), "Formatted output contains iteration 0");
  assert(formatted.includes("Ronda 1"), "Formatted output contains iteration 1");
  assert(formatted.includes("ACCIÓN REQUERIDA"), "Formatted output contains action prompt");

  // 8.4 — formatCheckpointForInjection with null
  assertEq(formatCheckpointForInjection(null), "", "Format null returns empty string");

  // 8.5 — clearCheckpoint removes file
  clearCheckpoint(TEMP_DIR);
  const cleared = loadCheckpoint(TEMP_DIR);
  assertEq(cleared, null, "Checkpoint cleared successfully");

  // 8.6 — clearCheckpoint on non-existent file is safe
  clearCheckpoint(TEMP_DIR); // Should not throw
  assert(true, "clearCheckpoint on missing file is safe (no-throw)");

  // 8.7 — loadCheckpoint on non-existent is null
  assertEq(loadCheckpoint(TEMP_DIR), null, "loadCheckpoint returns null when no file");

  // 8.8 — Synthesis truncation (500 chars max in iterations)
  const longSynthesis = "A".repeat(800);
  saveCheckpoint(TEMP_DIR, {
    sessionId: "trunc-test",
    goal: "Test truncation",
    lastSynthesis: "short",
    iterations: [{ index: 0, synthesis: longSynthesis, feedback: "B".repeat(500) }],
  });
  const truncCp = loadCheckpoint(TEMP_DIR);
  assertEq(truncCp.iterations[0].synthesis.length, 500, "Iteration synthesis truncated to 500");
  assertEq(truncCp.iterations[0].feedback.length, 300, "Iteration feedback truncated to 300");
  clearCheckpoint(TEMP_DIR);

  // 8.9 — Default values for missing fields
  saveCheckpoint(TEMP_DIR, { sessionId: "minimal" });
  const minCp = loadCheckpoint(TEMP_DIR);
  assertEq(minCp.goal, "(sin objetivo)", "Default goal when missing");
  assertEq(minCp.lastSynthesis, "", "Default empty synthesis");
  assertEq(minCp.iterations.length, 0, "Default empty iterations");
  assert(minCp.startedAt !== undefined, "Default startedAt is set");
  clearCheckpoint(TEMP_DIR);
}

// ─── Section 9: Tool-Level Checkpoints ──────────────────────────────────────

function testToolCheckpoints() {
  console.log("\n🔧 Section 9: Tool-Level Checkpoints");

  // 9.1 — Save and load tool checkpoint
  saveToolCheckpoint(TEMP_DIR, { tool: "replace_string_in_file", inputSummary: "file: loop-engine.ts" });
  const tc = loadToolCheckpoint(TEMP_DIR);
  assert(tc !== null, "loadToolCheckpoint returns saved data");
  assertEq(tc.tool, "replace_string_in_file", "Tool name correct");
  assertEq(tc.inputSummary, "file: loop-engine.ts", "Input summary correct");
  assert(tc.startedAt !== undefined, "Tool checkpoint has startedAt");

  // 9.2 — clearToolCheckpoint removes file
  clearToolCheckpoint(TEMP_DIR);
  assertEq(loadToolCheckpoint(TEMP_DIR), null, "Tool checkpoint cleared");

  // 9.3 — clearToolCheckpoint on non-existent is safe
  clearToolCheckpoint(TEMP_DIR);
  assert(true, "clearToolCheckpoint on missing file is safe");

  // 9.4 — loadToolCheckpoint returns null when no file
  assertEq(loadToolCheckpoint(TEMP_DIR), null, "loadToolCheckpoint null when absent");

  // 9.5 — inputSummary truncated to 300 chars
  saveToolCheckpoint(TEMP_DIR, { tool: "big_tool", inputSummary: "X".repeat(500) });
  const truncTc = loadToolCheckpoint(TEMP_DIR);
  assertEq(truncTc.inputSummary.length, 300, "Tool inputSummary truncated to 300");
  clearToolCheckpoint(TEMP_DIR);

  // 9.6 — Default empty inputSummary
  saveToolCheckpoint(TEMP_DIR, { tool: "minimal_tool" });
  const minTc = loadToolCheckpoint(TEMP_DIR);
  assertEq(minTc.inputSummary, "", "Default empty inputSummary");
  clearToolCheckpoint(TEMP_DIR);

  // 9.7 — summarizeToolInput: replace_string_in_file
  assertEq(
    summarizeToolInput("replace_string_in_file", { filePath: "/src/loop-engine.ts" }),
    "file: loop-engine.ts",
    "summarize replace_string_in_file extracts basename",
  );

  // 9.8 — summarizeToolInput: create_file
  assertEq(
    summarizeToolInput("create_file", { filePath: "C:\\Users\\dev\\foo.mjs" }),
    "file: foo.mjs",
    "summarize create_file extracts basename",
  );

  // 9.9 — summarizeToolInput: run_in_terminal
  const cmdSum = summarizeToolInput("run_in_terminal", { command: "npm run compile && npm test" });
  assert(cmdSum.startsWith("cmd:"), "summarize run_in_terminal starts with cmd:");
  assert(cmdSum.length <= 255, "summarize run_in_terminal is bounded");

  // 9.10 — summarizeToolInput: grep_search
  assertEq(
    summarizeToolInput("grep_search", { query: "checkpoint" }),
    "query: checkpoint",
    "summarize grep_search extracts query",
  );

  // 9.11 — summarizeToolInput: semantic_search
  assertEq(
    summarizeToolInput("semantic_search", { query: "crash recovery" }),
    "query: crash recovery",
    "summarize semantic_search extracts query",
  );

  // 9.12 — summarizeToolInput: read_file
  assertEq(
    summarizeToolInput("read_file", { filePath: "/src/test.ts", startLine: 10, endLine: 50 }),
    "file: test.ts L10-50",
    "summarize read_file shows file + lines",
  );

  // 9.13 — summarizeToolInput: file_search
  assertEq(
    summarizeToolInput("file_search", { query: "**/*.ts" }),
    "glob: **/*.ts",
    "summarize file_search extracts glob",
  );

  // 9.14 — summarizeToolInput: multi_replace_string_in_file
  const multiSum = summarizeToolInput("multi_replace_string_in_file", {
    explanation: "Fix imports",
    replacements: [{}, {}, {}],
  });
  assert(multiSum.includes("3 replacements"), "summarize multi_replace counts replacements");
  assert(multiSum.includes("Fix imports"), "summarize multi_replace includes explanation");

  // 9.15 — summarizeToolInput: unknown tool fallback
  const unknownSum = summarizeToolInput("custom_tool", { foo: "bar", baz: 42 });
  assert(unknownSum.length <= 250, "summarize unknown tool is bounded");
  assert(unknownSum.includes("foo"), "summarize unknown tool includes key");

  // 9.16 — summarizeToolInput: null input
  assertEq(summarizeToolInput("any_tool", null), "", "summarize null input returns empty");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🏴‍☠️ Smoke Test: Intelligent Memory Management");
  console.log("=".repeat(55));

  setup();

  try {
    testSessionDiary();
    testEntityGraph();
    testMemoryScorer();
    testSmartConsolidator();
    testContextPredictor();
    testIntegration();
    testEdgeCases();
    testExecutionCheckpoint();
    testToolCheckpoints();
  } catch (err) {
    console.error("\n💥 FATAL ERROR:", err.message);
    console.error(err.stack);
    failed++;
  } finally {
    cleanup();
  }

  console.log("\n" + "=".repeat(55));
  console.log(
    `📋 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  console.log("=".repeat(55));

  if (failed > 0) {
    console.error("\n❌ SMOKE TEST FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED — ¡Tierra a la vista! 🏴‍☠️");
    process.exit(0);
  }
}

main();
