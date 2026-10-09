/**
 * TDD Test Suite — Graph Quality Improvements (Ola 1 + Ola 2)
 *
 * These tests MUST FAIL before implementation.
 * They validate the 6 approved improvements from the expert panel audit.
 *
 * Ola 1: Calidad de Datos
 *   1.1 Fix Multitag TAGGED_AS
 *   1.3 Overlap Coefficient (reemplazar Jaccard)
 *
 * Ola 2: Inteligencia de Búsqueda
 *   (BFS + Levenshtein tests are in server-side test file)
 *
 * Run: npx tsx src/test/graph-quality.test.ts
 */

import * as assert from "assert";
import {
  buildWeightedAdjacency,
  findMatchingNodes,
  GraphData,
  graphProximity,
  rankStrategies,
  StrategyDefinition,
} from "../graph-utils";

// ═══════════════════════════════════════════════════════════════════════
// Standalone runner (no Mocha dependency)
// ═══════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ name, error: msg });
    console.log(`  ❌ ${name}`);
    console.log(`     → ${msg}`);
  }
}

function suite(name: string, fn: () => void) {
  console.log(`\n📦 ${name}`);
  fn();
}

// ═══════════════════════════════════════════════════════════════════════
// OLA 1.3 — Overlap Coefficient (reemplazar Jaccard en keywordOverlap)
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 1.3: Overlap Coefficient", () => {
  const richStrategy: StrategyDefinition = {
    name: "comprehensive-testing",
    description:
      "Full test coverage including unit, integration, e2e, performance, security, accessibility, and regression testing with mocking and snapshot validation",
    tags: [
      "testing",
      "unit",
      "integration",
      "e2e",
      "performance",
      "security",
      "accessibility",
      "regression",
      "mocking",
      "snapshot",
      "coverage",
      "quality",
    ],
  };

  const leanStrategy: StrategyDefinition = {
    name: "quick-test",
    description: "Quick unit testing",
    tags: ["testing", "unit"],
  };

  test("Rich strategies should NOT be penalized vs lean ones for same query", () => {
    // Query: "testing unit" → 2 keywords
    // richStrategy has 12+ tags → Jaccard: 2/14 = 0.14
    // leanStrategy has 2 tags → Jaccard: 2/4 = 0.50
    // With Overlap: both should score 1.0 (2/min(2,N) = 2/2 = 1.0)
    const results = rankStrategies(
      "testing unit",
      [richStrategy, leanStrategy],
      null, // no graph
      { keywordWeight: 1.0, graphWeight: 0.0 },
    );

    const richResult = results.find(
      (r) => r.strategy.name === "comprehensive-testing",
    )!;
    const leanResult = results.find((r) => r.strategy.name === "quick-test")!;

    // MUST FAIL with Jaccard: richResult.keywordScore << leanResult.keywordScore
    // MUST PASS with Overlap: richResult.keywordScore >= leanResult.keywordScore
    assert.ok(
      richResult.keywordScore >= leanResult.keywordScore * 0.9,
      `Rich strategy (${richResult.keywordScore.toFixed(3)}) should not be penalized ` +
        `vs lean strategy (${leanResult.keywordScore.toFixed(3)}) for identical keyword match`,
    );
  });

  test("Perfect subset match should score near 1.0", () => {
    // If ALL query tokens match strategy → overlap = 1.0
    const results = rankStrategies(
      "security audit vulnerability",
      [
        {
          name: "security-first",
          description:
            "Security audit before implementation, check vulnerabilities, hardening, penetration testing",
          tags: [
            "security",
            "audit",
            "vulnerability",
            "hardening",
            "penetration",
            "compliance",
          ],
        },
      ],
      null,
      { keywordWeight: 1.0, graphWeight: 0.0 },
    );

    // With Overlap coefficient, all 3 query tokens match → 3/3 = 1.0
    // With Jaccard: 3/9 = 0.33
    assert.ok(
      results[0].keywordScore >= 0.8,
      `Perfect match keyword score should be >= 0.8, got ${results[0].keywordScore.toFixed(3)}`,
    );
  });

  test("Two-word query matching 20-tag strategy should score high", () => {
    const megaStrategy: StrategyDefinition = {
      name: "deploy-strategy",
      description:
        "Comprehensive deployment pipeline with CI/CD, staging, production, rollback, blue-green, canary, monitoring, health checks, load balancing",
      tags: [
        "deploy",
        "production",
        "ci-cd",
        "staging",
        "rollback",
        "blue-green",
        "canary",
        "monitoring",
        "health",
        "load-balancing",
        "docker",
        "kubernetes",
        "terraform",
        "ansible",
        "nginx",
      ],
    };

    const results = rankStrategies("deploy production", [megaStrategy], null, {
      keywordWeight: 1.0,
      graphWeight: 0.0,
    });

    // With Overlap: 2/min(2, 20+) = 2/2 = 1.0
    // With Jaccard: 2/22 = 0.09 (!!!)
    assert.ok(
      results[0].keywordScore >= 0.7,
      `Score for 2-word match in 20-tag strategy should be >= 0.7, got ${results[0].keywordScore.toFixed(3)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 1.1 — These tests validate that multitag works.
// Since extractRelationsFromContent is in server/src/graph.ts (ESM),
// we test the IMPACT on graph-utils ranking here: if tags are properly
// split, graph nodes for each tag exist → better graph scoring.
// The direct extraction test is in the server-side test file.
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 1.1: Multitag Impact on Ranking", () => {
  test("Graph with individual tags should boost strategy better than single hub tag", () => {
    // Simulates: a document has "Tags: testing, security, deploy"
    // BEFORE fix: only "testing" node exists
    // AFTER fix: "testing", "security", "deploy" nodes exist, each connected
    const graphBefore: GraphData = {
      nodes: [
        { id: "testing", type: "concept" },
        { id: "04_LEARNINGS.md", type: "file" },
      ],
      edges: [
        {
          from: "04_LEARNINGS.md",
          to: "testing",
          type: "TAGGED_AS",
          weight: 0.7,
        },
      ],
    };

    const graphAfter: GraphData = {
      nodes: [
        { id: "testing", type: "concept" },
        { id: "security", type: "concept" },
        { id: "deploy", type: "concept" },
        { id: "04_LEARNINGS.md", type: "file" },
      ],
      edges: [
        {
          from: "04_LEARNINGS.md",
          to: "testing",
          type: "TAGGED_AS",
          weight: 0.7,
        },
        {
          from: "04_LEARNINGS.md",
          to: "security",
          type: "TAGGED_AS",
          weight: 0.7,
        },
        {
          from: "04_LEARNINGS.md",
          to: "deploy",
          type: "TAGGED_AS",
          weight: 0.7,
        },
      ],
    };

    const strategy: StrategyDefinition = {
      name: "security-deploy",
      description: "Secure deployment process",
      tags: ["security", "deploy"],
    };

    const resultsBefore = rankStrategies(
      "security deploy testing",
      [strategy],
      graphBefore,
    );
    const resultsAfter = rankStrategies(
      "security deploy testing",
      [strategy],
      graphAfter,
    );

    // With multitag fix, the graph has more connections → higher graphScore
    assert.ok(
      resultsAfter[0].graphScore >= resultsBefore[0].graphScore,
      `Graph with split tags (${resultsAfter[0].graphScore.toFixed(3)}) should score >= ` +
        `single tag graph (${resultsBefore[0].graphScore.toFixed(3)})`,
    );
    assert.ok(
      resultsAfter[0].graphPaths > resultsBefore[0].graphPaths,
      `Split tags should produce more graph paths: after=${resultsAfter[0].graphPaths} before=${resultsBefore[0].graphPaths}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 1.2 — Source-Rewrite impact tests
// Validates that when supernodes are eliminated, graph ranking improves
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 1.2: Source-Rewrite Impact", () => {
  test("Supernode 'document' should be in BLACKLISTED_NODES (graph-utils)", () => {
    // findMatchingNodes should filter out blacklisted nodes
    const graph: GraphData = {
      nodes: [
        { id: "document", type: "entity" },
        { id: "project", type: "entity" },
        { id: "topic", type: "entity" },
        { id: "scanner.ts", type: "entity" },
      ],
      edges: [],
    };

    const matches = findMatchingNodes(graph, ["document", "scanner"]);
    // 'document' should be blacklisted, only scanner should match
    assert.ok(
      !matches.includes("document"),
      "Blacklisted node 'document' should not appear in graph matches",
    );
    assert.ok(
      matches.includes("scanner.ts"),
      "Non-blacklisted node should match",
    );
  });

  test("BFS between non-supernode entities should produce cleaner paths", () => {
    // Graph WITHOUT supernodes (post source-rewrite)
    const cleanGraph: GraphData = {
      nodes: [
        { id: "scanner.ts", type: "file" },
        { id: "extension.ts", type: "file" },
        { id: "glob", type: "dependency" },
        { id: "04_LEARNINGS.md", type: "file" },
      ],
      edges: [
        {
          from: "scanner.ts",
          to: "glob",
          type: "DEPENDS_ON",
          weight: 0.95,
        },
        {
          from: "04_LEARNINGS.md",
          to: "scanner.ts",
          type: "MODIFIES",
          weight: 0.8,
        },
      ],
    };

    // Graph WITH supernodes (pre source-rewrite)
    const dirtyGraph: GraphData = {
      nodes: [
        { id: "document", type: "entity" },
        { id: "scanner.ts", type: "file" },
        { id: "extension.ts", type: "file" },
        { id: "glob", type: "dependency" },
        { id: "lm-tools.ts", type: "file" },
      ],
      edges: [
        {
          from: "document",
          to: "scanner.ts",
          type: "MENTIONS",
          weight: 0.5,
        },
        {
          from: "document",
          to: "extension.ts",
          type: "MENTIONS",
          weight: 0.5,
        },
        {
          from: "document",
          to: "lm-tools.ts",
          type: "MENTIONS",
          weight: 0.5,
        },
        {
          from: "document",
          to: "glob",
          type: "MENTIONS",
          weight: 0.5,
        },
      ],
    };

    const adjacencyClean = buildWeightedAdjacency(cleanGraph);
    const adjacencyDirty = buildWeightedAdjacency(dirtyGraph);

    const cleanProximity = graphProximity(
      adjacencyClean,
      ["scanner.ts"],
      ["glob"],
      3,
    );
    const dirtyProximity = graphProximity(
      adjacencyDirty,
      ["scanner.ts"],
      ["glob"],
      3,
    );

    // In dirty graph, scanner.ts → document → glob (via supernode)
    // produces a noisy path with low-confidence edges
    // In clean graph, scanner.ts → glob is a direct strong path
    assert.ok(
      cleanProximity.score >= dirtyProximity.score,
      `Clean graph proximity (${cleanProximity.score.toFixed(3)}) should >= dirty (${dirtyProximity.score.toFixed(3)})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n🔴 Failures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.error}`);
  }
}
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
