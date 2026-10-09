/**
 * TDD Test Suite — Graph Server Improvements (Ola 1 + Ola 2)
 *
 * Tests for server/src/graph.ts (ESM) — covers extraction patterns
 * and GraphMemory class improvements.
 *
 * These tests MUST FAIL before implementation.
 *
 * Run: npx tsx server/test/graph-quality.test.ts
 */

import { strict as assert } from "node:assert";
import { extractRelationsFromContent, GraphMemory } from "../src/graph.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
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
// OLA 1.1 — Fix Multitag TAGGED_AS
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 1.1: Fix Multitag TAGGED_AS", () => {
  test("Should create multiple edges for comma-separated tags", () => {
    const content = `## Bug Fix
**Tags**: deploy, error, mcp
Some description here.`;

    const relations = extractRelationsFromContent(content, "04_LEARNINGS.md");
    const taggedRels = relations.filter((r) => r.relationship === "TAGGED_AS");

    // BEFORE fix: only 1 edge (first tag "deploy")
    // AFTER fix: 3 edges (deploy, error, mcp)
    assert.ok(
      taggedRels.length >= 3,
      `Expected >= 3 TAGGED_AS relations, got ${taggedRels.length}. ` +
        `Tags found: [${taggedRels.map((r) => r.target).join(", ")}]`,
    );

    const targets = taggedRels.map((r) => r.target.toLowerCase());
    assert.ok(targets.includes("deploy"), "Missing tag: deploy");
    assert.ok(targets.includes("error"), "Missing tag: error");
    assert.ok(targets.includes("mcp"), "Missing tag: mcp");
  });

  test("Should handle single tag without regression", () => {
    const content = `**Tags**: architecture
Some text.`;

    const relations = extractRelationsFromContent(content, "test.md");
    const taggedRels = relations.filter((r) => r.relationship === "TAGGED_AS");

    assert.ok(
      taggedRels.length >= 1,
      `Single tag should produce at least 1 TAGGED_AS relation`,
    );
    assert.ok(
      taggedRels.some((r) => r.target.toLowerCase() === "architecture"),
      "Single tag 'architecture' should be captured",
    );
  });

  test("Should filter tags shorter than 3 characters", () => {
    const content = `**Tags**: ok, a, deployment, bb
Other text.`;

    const relations = extractRelationsFromContent(content, "test.md");
    const taggedRels = relations.filter((r) => r.relationship === "TAGGED_AS");
    const targets = taggedRels.map((r) => r.target.toLowerCase().trim());

    assert.ok(
      !targets.includes("a"),
      "Tag 'a' (1 char) should be filtered out",
    );
    assert.ok(
      !targets.includes("bb"),
      "Tag 'bb' (2 chars) should be filtered out",
    );
    assert.ok(
      targets.includes("deployment"),
      "Tag 'deployment' should be kept",
    );
  });

  test("Should handle multiple Tags entries in same content", () => {
    const content = `## Section 1
**Tags**: api, rest
## Section 2
**Tags**: deploy, docker`;

    const relations = extractRelationsFromContent(content, "test.md");
    const taggedRels = relations.filter((r) => r.relationship === "TAGGED_AS");

    // Should capture tags from BOTH sections
    assert.ok(
      taggedRels.length >= 4,
      `Expected >= 4 TAGGED_AS from 2 sections, got ${taggedRels.length}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 1.2 — Source-Rewrite (eliminar supernodes)
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 1.2: Source-Rewrite", () => {
  test("MENTIONS pattern should use sourceFile, not 'document'", () => {
    const content = `The scanner is in src/scanner.ts and handles file discovery.`;
    const relations = extractRelationsFromContent(
      content,
      "docs/memory/02_CODE_MAP.md",
    );

    const mentionRels = relations.filter((r) => r.relationship === "MENTIONS");

    for (const rel of mentionRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "document",
        `MENTIONS source should be the sourceFile, not 'document'. Got source: '${rel.source}'`,
      );
    }

    if (mentionRels.length > 0) {
      // Source should be the actual file, not generic
      assert.ok(
        mentionRels.some(
          (r) =>
            r.source.includes("02_CODE_MAP") ||
            r.source.includes("docs/memory"),
        ),
        `MENTIONS source should reference the actual sourceFile, not a generic node`,
      );
    }
  });

  test("PRODUCES pattern should use sourceFile, not 'process'", () => {
    const content = `The build system generates dist/mcp-server/index.mjs`;
    const relations = extractRelationsFromContent(
      content,
      "01_ARCHITECTURE.md",
    );

    const producesRels = relations.filter((r) => r.relationship === "PRODUCES");

    for (const rel of producesRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "process",
        `PRODUCES source should be sourceFile, not 'process'. Got: '${rel.source}'`,
      );
    }
  });

  test("TAGGED_AS pattern should use sourceFile, not 'entry'", () => {
    const content = `**Tags**: deploy, testing`;
    const relations = extractRelationsFromContent(content, "04_LEARNINGS.md");

    const taggedRels = relations.filter((r) => r.relationship === "TAGGED_AS");

    for (const rel of taggedRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "entry",
        `TAGGED_AS source should be sourceFile, not 'entry'. Got: '${rel.source}'`,
      );
    }
  });

  test("CATEGORIZED_AS pattern should use sourceFile, not 'entry'", () => {
    const content = `**Category**: architecture`;
    const relations = extractRelationsFromContent(content, "04_LEARNINGS.md");

    const catRels = relations.filter(
      (r) => r.relationship === "CATEGORIZED_AS",
    );

    for (const rel of catRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "entry",
        `CATEGORIZED_AS source should be sourceFile, got: '${rel.source}'`,
      );
    }
  });

  test("RELATED_TO pattern should use sourceFile, not 'topic'", () => {
    const content = `**Related**: Architecture Design`;
    const relations = extractRelationsFromContent(
      content,
      "05_TROUBLESHOOTING.md",
    );

    const relatedRels = relations.filter(
      (r) => r.relationship === "RELATED_TO",
    );

    for (const rel of relatedRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "topic",
        `RELATED_TO source should be sourceFile, not 'topic'. Got: '${rel.source}'`,
      );
    }
  });

  test("MODIFIES pattern should use sourceFile, not 'change'", () => {
    const content = `Modified: \`scanner.ts\``;
    const relations = extractRelationsFromContent(content, "04_LEARNINGS.md");

    const modifiesRels = relations.filter((r) => r.relationship === "MODIFIES");

    for (const rel of modifiesRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "change",
        `MODIFIES source should be sourceFile, not 'change'. Got: '${rel.source}'`,
      );
    }
  });

  test("FIXES pattern should use sourceFile, not 'solution'", () => {
    const content = `Fixed: graph file path mismatch causing duplicates`;
    const relations = extractRelationsFromContent(
      content,
      "05_TROUBLESHOOTING.md",
    );

    const fixesRels = relations.filter((r) => r.relationship === "FIXES");

    for (const rel of fixesRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "solution",
        `FIXES source should be sourceFile, not 'solution'. Got: '${rel.source}'`,
      );
    }
  });

  test("DEPENDS_ON (JSON) should use sourceFile, not 'project'", () => {
    const content = `"glob": "^10.0"`;
    const relations = extractRelationsFromContent(
      content,
      "03_DEPENDENCIES.md",
    );

    const depRels = relations.filter(
      (r) => r.relationship === "DEPENDS_ON" && r.target.includes("glob"),
    );

    for (const rel of depRels) {
      assert.notStrictEqual(
        rel.source.toLowerCase(),
        "project",
        `DEPENDS_ON (JSON) source should be sourceFile, not 'project'. Got: '${rel.source}'`,
      );
    }
  });

  test("No generic supernode names should appear as source in any relation", () => {
    const content = `
The system uses src/scanner.ts to scan files.
It generates docs/memory/02_CODE_MAP.md as output.
**Tags**: scanning, files
**Category**: architecture
**Related**: File Discovery
Modified: \`scanner.ts\`
Fixed: scanning bug in large directories
"glob": "^10.0"
`;

    const relations = extractRelationsFromContent(content, "test-doc.md");
    const genericSources = [
      "document",
      "project",
      "process",
      "entry",
      "topic",
      "change",
      "solution",
    ];

    const offenders = relations.filter((r) =>
      genericSources.includes(r.source.toLowerCase()),
    );

    assert.strictEqual(
      offenders.length,
      0,
      `Found ${offenders.length} relations with generic sources: ` +
        offenders
          .map((r) => `${r.source}→${r.relationship}→${r.target}`)
          .join("; "),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 2.1 — BFS Confidence Filter
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 2.1: BFS Confidence Filter", () => {
  test("searchRelated should NOT expand low-confidence edges", () => {
    const gm = new GraphMemory("test-bfs-confidence");
    gm.reset();

    // High confidence path: a → b (DEPENDS_ON, 0.95)
    gm.addRelation({
      id: "r1",
      source: "scanner",
      relationship: "DEPENDS_ON",
      target: "glob",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // Low confidence path: a → noise (MENTIONS, 0.3)
    gm.addRelation({
      id: "r2",
      source: "scanner",
      relationship: "MENTIONS",
      target: "some-random-file",
      sourceFile: "test.md",
      confidence: 0.3,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // noise → far-away (MENTIONS, 0.3)
    gm.addRelation({
      id: "r3",
      source: "some-random-file",
      relationship: "MENTIONS",
      target: "far-away-node",
      sourceFile: "test.md",
      confidence: 0.3,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    const results = gm.searchRelated("scanner", 2);

    // Should find glob (high confidence) but NOT far-away-node
    const foundTargets = results.map((r) => r.target.toLowerCase());
    assert.ok(
      foundTargets.includes("glob"),
      "Should find high-confidence relation: glob",
    );

    // With confidence filter, far-away-node should be unreachable
    // (MENTIONS * 0.3 * EDGE_WEIGHT_MENTIONS < threshold)
    assert.ok(
      !foundTargets.includes("far-away-node"),
      `BFS should NOT reach far-away-node through low-confidence edges. Found: [${foundTargets.join(", ")}]`,
    );
  });

  test("BFS should fallback to unfiltered when filtered returns empty", () => {
    const gm = new GraphMemory("test-bfs-fallback");
    gm.reset();

    // Only low confidence edges
    gm.addRelation({
      id: "r1",
      source: "lonely-node",
      relationship: "MENTIONS",
      target: "somewhat-related",
      sourceFile: "test.md",
      confidence: 0.4,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    const results = gm.searchRelated("lonely-node", 2);

    // Even though confidence is low, fallback should return something
    assert.ok(
      results.length > 0,
      "BFS fallback should return results even when all edges are low-confidence",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 2.2 — Blacklist Hub Nodes (Server)
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 2.2: Blacklist Hub Nodes", () => {
  test("BFS should not expand through blacklisted hub nodes", () => {
    const gm = new GraphMemory("test-blacklist");
    gm.reset();

    // Create a hub: scanner → document → extension.ts → lm-tools.ts
    gm.addRelation({
      id: "r1",
      source: "scanner",
      relationship: "MENTIONS",
      target: "document",
      sourceFile: "test.md",
      confidence: 0.5,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    gm.addRelation({
      id: "r2",
      source: "document",
      relationship: "MENTIONS",
      target: "extension.ts",
      sourceFile: "test.md",
      confidence: 0.5,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    gm.addRelation({
      id: "r3",
      source: "document",
      relationship: "MENTIONS",
      target: "lm-tools.ts",
      sourceFile: "test.md",
      confidence: 0.5,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // Direct relation
    gm.addRelation({
      id: "r4",
      source: "scanner",
      relationship: "DEPENDS_ON",
      target: "glob",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    const results = gm.searchRelated("scanner", 3);
    const foundTargets = results
      .map((r) => [r.source.toLowerCase(), r.target.toLowerCase()])
      .flat();

    // 'document' is a blacklisted hub — BFS should not traverse through it
    assert.ok(
      !foundTargets.includes("lm-tools.ts"),
      `BFS should not reach lm-tools.ts through blacklisted hub 'document'. Found: [${foundTargets.join(", ")}]`,
    );
    assert.ok(
      foundTargets.includes("glob"),
      "Direct DEPENDS_ON relation should still be found",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OLA 2.3 — Levenshtein Normalizado en findBestMatch
// ═══════════════════════════════════════════════════════════════════════

suite("Ola 2.3: Levenshtein in findBestMatch", () => {
  test("Should find entity with typo (scanenr → scanner)", () => {
    const gm = new GraphMemory("test-levenshtein");
    gm.reset();

    gm.addRelation({
      id: "r1",
      source: "scanner",
      relationship: "DEPENDS_ON",
      target: "glob",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // searchRelated internally calls findBestMatch
    const results = gm.searchRelated("scanenr", 1);

    assert.ok(
      results.length > 0,
      `Typo 'scanenr' should fuzzy-match to 'scanner' via Levenshtein. Got 0 results.`,
    );
  });

  test("Should find entity with partial name (ext → extension)", () => {
    const gm = new GraphMemory("test-levenshtein-partial");
    gm.reset();

    gm.addRelation({
      id: "r1",
      source: "extension",
      relationship: "DEPENDS_ON",
      target: "vscode",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // 'extensoin' (typo) should match 'extension'
    const results = gm.searchRelated("extensoin", 1);

    assert.ok(
      results.length > 0,
      `Typo 'extensoin' should fuzzy-match to 'extension'. Got 0 results.`,
    );
  });

  test("Should NOT match completely unrelated strings", () => {
    const gm = new GraphMemory("test-levenshtein-no-match");
    gm.reset();

    gm.addRelation({
      id: "r1",
      source: "scanner",
      relationship: "DEPENDS_ON",
      target: "glob",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // 'zzzzzzz' should not match anything
    const results = gm.searchRelated("zzzzzzz", 1);

    assert.strictEqual(
      results.length,
      0,
      `Completely unrelated query 'zzzzzzz' should return 0 results, got ${results.length}`,
    );
  });

  test("Should handle very short strings gracefully (< 3 chars)", () => {
    const gm = new GraphMemory("test-levenshtein-short");
    gm.reset();

    gm.addRelation({
      id: "r1",
      source: "ab",
      relationship: "DEPENDS_ON",
      target: "cd",
      sourceFile: "test.md",
      confidence: 0.95,
      extractedFrom: "test",
      timestamp: Date.now(),
    });

    // Short strings should use includes(), not Levenshtein
    // 'ab' exists as exact match
    const results = gm.searchRelated("ab", 1);
    assert.ok(results.length > 0, "Exact short match should still work");
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
