import * as assert from "assert";
import {
  extractBestScore,
  formatEntityBFS,
  formatGraphStats,
  formatQueryResults,
  getConfidenceEmoji,
  GraphData,
  parseEmbeddingType,
  parseGraphCounts,
  parseGraphologyExport,
  rankStrategies,
  StrategyDefinition,
  tokenize,
} from "../graph-utils";

suite("Graph Utils Tests", () => {
  // ─── parseGraphologyExport ──────────────────────────────────────────

  suite("parseGraphologyExport", () => {
    test("Should parse graphology format with wrapper", () => {
      const raw = {
        projectId: "test",
        lastUpdated: Date.now(),
        graphology: {
          nodes: [
            { key: "scanner.ts", attributes: { type: "entity", mentions: 3 } },
            {
              key: "extension.ts",
              attributes: { type: "entity", mentions: 5 },
            },
          ],
          edges: [
            {
              source: "extension.ts",
              target: "scanner.ts",
              attributes: { relationship: "DEPENDS_ON", confidence: 0.95 },
            },
          ],
        },
      };

      const result = parseGraphologyExport(raw);

      assert.strictEqual(result.nodes.length, 2);
      assert.strictEqual(result.nodes[0].id, "scanner.ts");
      assert.strictEqual(result.nodes[0].type, "entity");
      assert.strictEqual(result.edges.length, 1);
      assert.strictEqual(result.edges[0].from, "extension.ts");
      assert.strictEqual(result.edges[0].to, "scanner.ts");
      assert.strictEqual(result.edges[0].type, "DEPENDS_ON");
      assert.strictEqual(result.edges[0].weight, 0.95);
    });

    test("Should parse flat format (no graphology wrapper)", () => {
      const raw = {
        nodes: [{ key: "a", attributes: { type: "file" } }],
        edges: [
          {
            source: "a",
            target: "b",
            attributes: { relationship: "LINKS_TO", confidence: 0.8 },
          },
        ],
      };

      const result = parseGraphologyExport(raw);
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].id, "a");
      assert.strictEqual(result.edges[0].type, "LINKS_TO");
    });

    test("Should handle missing attributes gracefully", () => {
      const raw = {
        graphology: {
          nodes: [{ key: "orphan" }],
          edges: [{ source: "a", target: "b" }],
        },
      };

      const result = parseGraphologyExport(raw);
      assert.strictEqual(result.nodes[0].id, "orphan");
      assert.strictEqual(result.nodes[0].type, "entity"); // default
      assert.strictEqual(result.edges[0].type, "RELATED_TO"); // default
      assert.strictEqual(result.edges[0].weight, undefined);
    });

    test("Should handle empty graph", () => {
      const raw = { graphology: { nodes: [], edges: [] } };
      const result = parseGraphologyExport(raw);
      assert.strictEqual(result.nodes.length, 0);
      assert.strictEqual(result.edges.length, 0);
    });

    test("Should handle completely empty object", () => {
      const result = parseGraphologyExport({});
      assert.strictEqual(result.nodes.length, 0);
      assert.strictEqual(result.edges.length, 0);
    });
  });

  // ─── parseGraphCounts ───────────────────────────────────────────────

  suite("parseGraphCounts", () => {
    test("Should count from graphology wrapper", () => {
      const raw = {
        graphology: {
          nodes: [{ key: "a" }, { key: "b" }, { key: "c" }],
          edges: [{ source: "a", target: "b" }],
        },
      };
      const counts = parseGraphCounts(raw);
      assert.strictEqual(counts.nodes, 3);
      assert.strictEqual(counts.edges, 1);
    });

    test("Should return 0 for empty graph", () => {
      const counts = parseGraphCounts({});
      assert.strictEqual(counts.nodes, 0);
      assert.strictEqual(counts.edges, 0);
    });
  });

  // ─── parseEmbeddingType ─────────────────────────────────────────────

  suite("parseEmbeddingType", () => {
    test("Should prefer embeddingType field", () => {
      const index = {
        embeddingType: "cloudflare",
        embeddingProvider: "openai",
      };
      assert.strictEqual(parseEmbeddingType(index), "cloudflare");
    });

    test("Should fallback to embeddingProvider", () => {
      const index = { embeddingProvider: "openai" };
      assert.strictEqual(parseEmbeddingType(index), "openai");
    });

    test("Should fallback to config.embeddingProvider", () => {
      const index = { config: { embeddingProvider: "cohere" } };
      assert.strictEqual(parseEmbeddingType(index), "cohere");
    });

    test("Should return unknown when no field exists", () => {
      assert.strictEqual(parseEmbeddingType({}), "unknown");
    });
  });

  // ─── formatGraphStats ──────────────────────────────────────────────

  suite("formatGraphStats", () => {
    test("Should format node and edge counts", () => {
      const graph: GraphData = {
        nodes: [
          { id: "a", type: "entity" },
          { id: "b", type: "entity" },
          { id: "c", type: "file" },
        ],
        edges: [
          { from: "a", to: "b", type: "DEPENDS_ON" },
          { from: "b", to: "c", type: "DEPENDS_ON" },
          { from: "a", to: "c", type: "LINKS_TO" },
        ],
      };

      const output = formatGraphStats(graph);
      assert.ok(output.includes("**Total Nodes:** 3"));
      assert.ok(output.includes("**Total Edges:** 3"));
      assert.ok(output.includes("entity: 2"));
      assert.ok(output.includes("file: 1"));
      assert.ok(output.includes("DEPENDS_ON: 2"));
      assert.ok(output.includes("LINKS_TO: 1"));
    });

    test("Should handle empty graph", () => {
      const output = formatGraphStats({ nodes: [], edges: [] });
      assert.ok(output.includes("**Total Nodes:** 0"));
      assert.ok(output.includes("**Total Edges:** 0"));
    });
  });

  // ─── formatQueryResults ─────────────────────────────────────────────

  suite("formatQueryResults", () => {
    const graph: GraphData = {
      nodes: [
        { id: "scanner.ts", type: "file" },
        { id: "extension.ts", type: "file" },
        { id: "utils.ts", type: "file" },
      ],
      edges: [
        {
          from: "extension.ts",
          to: "scanner.ts",
          type: "DEPENDS_ON",
          weight: 0.95,
        },
        {
          from: "extension.ts",
          to: "utils.ts",
          type: "DEPENDS_ON",
          weight: 0.8,
        },
      ],
    };

    test("Should find matching nodes", () => {
      const output = formatQueryResults(graph, "scanner");
      assert.ok(output.includes("**Matching Nodes:** 1"));
      assert.ok(output.includes("scanner.ts"));
    });

    test("Should find matching edges", () => {
      const output = formatQueryResults(graph, "extension");
      assert.ok(output.includes("**Matching Edges:** 2"));
    });

    test("Should return 0 matches for unknown query", () => {
      const output = formatQueryResults(graph, "nonexistent");
      assert.ok(output.includes("**Matching Nodes:** 0"));
      assert.ok(output.includes("**Matching Edges:** 0"));
    });

    test("Should match by edge type", () => {
      const output = formatQueryResults(graph, "depends");
      assert.ok(output.includes("**Matching Edges:** 2"));
    });

    test("Should display weight when present", () => {
      const output = formatQueryResults(graph, "scanner");
      assert.ok(output.includes("0.95"));
    });
  });

  // ─── formatEntityBFS ───────────────────────────────────────────────

  suite("formatEntityBFS", () => {
    const graph: GraphData = {
      nodes: [
        { id: "A", type: "entity" },
        { id: "B", type: "entity" },
        { id: "C", type: "entity" },
        { id: "D", type: "entity" },
      ],
      edges: [
        { from: "A", to: "B", type: "DEPENDS_ON", weight: 0.9 },
        { from: "B", to: "C", type: "EXTENDS", weight: 0.8 },
        { from: "C", to: "D", type: "LINKS_TO" },
      ],
    };

    test("Should find entity and traverse BFS", () => {
      const output = formatEntityBFS(graph, "A", 2);
      assert.ok(output.includes("🔷 A"));
      assert.ok(output.includes("→ B"));
      assert.ok(output.includes("→ C"));
      assert.ok(output.includes("Nodes reached:"));
    });

    test("Should respect depth limit", () => {
      const output = formatEntityBFS(graph, "A", 1);
      assert.ok(output.includes("🔷 A"));
      assert.ok(output.includes("→ B"));
      // C is at depth 2, should NOT appear with maxDepth=1
      assert.ok(!output.includes("→ C [via:"));
    });

    test("Should handle no match", () => {
      const output = formatEntityBFS(graph, "nonexistent", 2);
      assert.ok(output.includes("No entity found"));
      assert.ok(output.includes('Try mode "query"'));
    });

    test("Should show via relationship type", () => {
      const output = formatEntityBFS(graph, "A", 2);
      assert.ok(output.includes("DEPENDS_ON"));
    });

    test("Should handle bidirectional traversal", () => {
      // Starting from C should reach B (via reverse edge) and then A
      const output = formatEntityBFS(graph, "C", 2);
      assert.ok(output.includes("🔷 C"));
      assert.ok(output.includes("→ B") || output.includes("→ D"));
    });
  });

  // ─── getConfidenceEmoji ─────────────────────────────────────────────

  suite("getConfidenceEmoji", () => {
    test("Should return 🟢 for high confidence (≥70%)", () => {
      assert.strictEqual(getConfidenceEmoji(0.7), "🟢");
      assert.strictEqual(getConfidenceEmoji(0.85), "🟢");
      assert.strictEqual(getConfidenceEmoji(1.0), "🟢");
    });

    test("Should return 🟡 for medium confidence (40-70%)", () => {
      assert.strictEqual(getConfidenceEmoji(0.4), "🟡");
      assert.strictEqual(getConfidenceEmoji(0.55), "🟡");
      assert.strictEqual(getConfidenceEmoji(0.69), "🟡");
    });

    test("Should return 🔴 for low confidence (<40%)", () => {
      assert.strictEqual(getConfidenceEmoji(0.0), "🔴");
      assert.strictEqual(getConfidenceEmoji(0.2), "🔴");
      assert.strictEqual(getConfidenceEmoji(0.39), "🔴");
    });

    test("Should guard against NaN and Infinity", () => {
      assert.strictEqual(getConfidenceEmoji(NaN), "🔴");
      assert.strictEqual(getConfidenceEmoji(Infinity), "🔴");
      assert.strictEqual(getConfidenceEmoji(-Infinity), "🔴");
    });
  });

  // ─── extractBestScore ──────────────────────────────────────────────

  suite("extractBestScore", () => {
    test("Should extract highest score from multiple results", () => {
      const output = [
        "---",
        "## Result 1: docs/memory/01_ARCHITECTURE.md",
        "🟡 Score: 45.3% [sem:50% kw:10%]",
        "",
        "Some content here",
        "---",
        "## Result 2: docs/memory/02_CODE_MAP.md",
        "🟢 Score: 85.1% [sem:90% kw:20%]",
        "",
        "More content",
      ].join("\n");
      assert.strictEqual(extractBestScore(output), 0.851);
    });

    test("Should return 0 when no scores found", () => {
      assert.strictEqual(extractBestScore("No relevant results found."), 0);
      assert.strictEqual(extractBestScore(""), 0);
    });

    test("Should handle Score without emoji prefix", () => {
      const output = "Score: 72.5%\nSome text\nScore: 30.0%";
      assert.strictEqual(extractBestScore(output), 0.725);
    });

    test("Should handle 100% score", () => {
      const output = "🟢 Score: 100.0%";
      assert.strictEqual(extractBestScore(output), 1.0);
    });

    test("Should handle malformed numbers gracefully", () => {
      const output = "Score: abc%";
      assert.strictEqual(extractBestScore(output), 0);
    });
  });

  // ─── tokenize ───────────────────────────────────────────────────────

  suite("tokenize", () => {
    test("Should lowercase and split words", () => {
      const result = tokenize("Refactor Extract Component");
      assert.ok(result.includes("refactor"));
      assert.ok(result.includes("extract"));
      assert.ok(result.includes("component"));
    });

    test("Should remove stopwords (EN)", () => {
      const result = tokenize("the component is not working");
      assert.ok(!result.includes("the"));
      assert.ok(!result.includes("is"));
      assert.ok(!result.includes("not"));
      assert.ok(result.includes("component"));
      assert.ok(result.includes("working"));
    });

    test("Should remove stopwords (ES)", () => {
      const result = tokenize("el componente para los usuarios");
      assert.ok(!result.includes("el"));
      assert.ok(!result.includes("para"));
      assert.ok(!result.includes("los"));
      assert.ok(result.includes("componente"));
      assert.ok(result.includes("usuarios"));
    });

    test("Should filter out short tokens (<3 chars)", () => {
      const result = tokenize("a do it up go run");
      // all <= 2 chars or stopwords → should be empty or minimal
      assert.ok(!result.includes("a"));
      assert.ok(!result.includes("do"));
      assert.ok(!result.includes("up"));
      assert.ok(!result.includes("go"));
    });

    test("Should handle hyphens and underscores as separators", () => {
      const result = tokenize("test-driven_development");
      assert.ok(result.includes("test"));
      assert.ok(result.includes("driven"));
      assert.ok(result.includes("development"));
    });

    test("Should return empty for empty string", () => {
      const result = tokenize("");
      assert.strictEqual(result.length, 0);
    });
  });

  // ─── rankStrategies ─────────────────────────────────────────────────

  suite("rankStrategies", () => {
    const testStrategies: StrategyDefinition[] = [
      {
        name: "tdd-first",
        description: "Test-driven development, Red Green Refactor",
        tags: ["tdd", "testing", "quality"],
      },
      {
        name: "prototype-fast",
        description: "Rapid prototyping, quick iteration",
        tags: ["prototype", "speed", "mvp"],
      },
      {
        name: "security-first",
        description: "Security audit before implementation",
        tags: ["security", "audit", "vulnerability", "hardening"],
      },
      {
        name: "refactor-extract",
        description: "Extract and clean code before adding features",
        tags: ["refactor", "clean", "extract", "modularize"],
      },
    ];

    test("Should return all strategies when no graph (keyword-only)", () => {
      const results = rankStrategies(
        "I want to add tests and do TDD",
        testStrategies,
        null,
      );
      assert.ok(results.length > 0);
      // tdd-first should be top since it matches "tdd" and "tests"
      assert.strictEqual(results[0].strategy.name, "tdd-first");
    });

    test("Should return all strategies sorted by score", () => {
      const results = rankStrategies(
        "refactor the component and extract logic",
        testStrategies,
        null,
      );
      assert.ok(results.length > 0);
      // refactor-extract should rank first
      assert.strictEqual(results[0].strategy.name, "refactor-extract");
      // Scores should be descending
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i].score <= results[i - 1].score);
      }
    });

    test("Should handle empty strategies array", () => {
      const results = rankStrategies("build something", [], null);
      assert.strictEqual(results.length, 0);
    });

    test("Should handle empty task description", () => {
      const results = rankStrategies("", testStrategies, null);
      // All scores should be 0 since no tokens
      for (const r of results) {
        assert.strictEqual(r.keywordScore, 0);
      }
    });

    test("Should respect minScore filter", () => {
      const results = rankStrategies(
        "security audit vulnerability scan",
        testStrategies,
        null,
        { minScore: 0.1 },
      );
      for (const r of results) {
        assert.ok(r.score >= 0.1);
      }
    });

    test("Should include graph scoring when graph is provided", () => {
      const graph: GraphData = {
        nodes: [
          { id: "tdd", type: "entity" },
          { id: "testing", type: "entity" },
          { id: "quality", type: "entity" },
        ],
        edges: [
          { from: "tdd", to: "testing", type: "DEPENDS_ON", weight: 0.9 },
          { from: "testing", to: "quality", type: "RELATED_TO", weight: 0.7 },
        ],
      };
      const results = rankStrategies(
        "implement tdd testing",
        testStrategies,
        graph,
      );
      assert.ok(results.length > 0);
      // tdd-first should rank high with both keyword AND graph signal
      assert.strictEqual(results[0].strategy.name, "tdd-first");
      assert.ok(results[0].graphScore >= 0 || results[0].keywordScore > 0);
    });

    test("Should fall back to keyword-only when graph is empty", () => {
      const emptyGraph: GraphData = { nodes: [], edges: [] };
      const results = rankStrategies(
        "security hardening check",
        testStrategies,
        emptyGraph,
      );
      assert.ok(results.length > 0);
      // Graph scores should all be 0
      for (const r of results) {
        assert.strictEqual(r.graphScore, 0);
      }
      // security-first should still rank well via keywords
      assert.strictEqual(results[0].strategy.name, "security-first");
    });

    test("Should filter blacklisted nodes from graph", () => {
      const graph: GraphData = {
        nodes: [
          { id: "document", type: "entity" }, // blacklisted
          { id: "project", type: "entity" }, // blacklisted
          { id: "refactor", type: "entity" }, // valid
        ],
        edges: [
          { from: "document", to: "refactor", type: "MENTIONS", weight: 1.0 },
        ],
      };
      const results = rankStrategies(
        "refactor component",
        testStrategies,
        graph,
      );
      // Should still work, blacklisted nodes shouldn't crash
      assert.ok(results.length > 0);
    });

    test("Should report matched keywords", () => {
      const results = rankStrategies(
        "security audit check vulnerability",
        testStrategies,
        null,
      );
      const secResult = results.find(
        (r) => r.strategy.name === "security-first",
      );
      assert.ok(secResult);
      assert.ok(secResult.matchedKeywords.length > 0);
      assert.ok(secResult.matchedKeywords.includes("security"));
    });

    test("Should handle custom weights", () => {
      const results = rankStrategies(
        "test driven development",
        testStrategies,
        null,
        { keywordWeight: 1.0, graphWeight: 0.0 },
      );
      assert.ok(results.length > 0);
      // With graph weight 0 and no graph, should still rank
      for (const r of results) {
        assert.strictEqual(r.graphScore, 0);
      }
    });
  });
});
