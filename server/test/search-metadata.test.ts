import { strict as assert } from "node:assert";
import { searchDocuments } from "../src/search.js";
import type { DocumentChunk, ProjectIndex } from "../src/types.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    })
    .catch((err: unknown) => {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${name}`);
      console.log(`     → ${msg}`);
    });
}

function makeChunk(overrides: Partial<DocumentChunk>): DocumentChunk {
  return {
    id: overrides.id ?? "chunk-1",
    filePath: overrides.filePath ?? "C:/tmp/04_LEARNINGS.md",
    relativePath: overrides.relativePath ?? "04_LEARNINGS.md",
    projectId: overrides.projectId ?? "project",
    content: overrides.content ?? "Agent diary learning for search metadata tests.",
    keywords: overrides.keywords ?? ["agent", "diary", "metadata"],
    metadata: {
      lineStart: 1,
      lineEnd: 10,
      modifiedAt: Date.now(),
      category: "learnings",
      topic: "agent-diaries-per-mode",
      ...overrides.metadata,
    },
    embedding: overrides.embedding ?? [1, 1, 0],
  };
}

async function run() {
  console.log("\n📦 Search Metadata Filters");

  const index: ProjectIndex = {
    projectId: "project",
    projectPath: "C:/tmp/project",
    memoryPath: "C:/tmp/project/.project-brain/memory",
    lastUpdated: Date.now(),
    fileHashes: {},
    vocabulary: ["agent", "diary", "metadata"],
    embeddingType: "tfidf",
    chunks: [
      makeChunk({ id: "learn-1" }),
      makeChunk({
        id: "trouble-1",
        relativePath: "05_TROUBLESHOOTING.md",
        metadata: {
          lineStart: 1,
          lineEnd: 10,
          modifiedAt: Date.now(),
          category: "troubleshooting",
          topic: "vscode-runner-updating",
        },
        content: "Runner update issue unrelated to agent diary.",
        keywords: ["runner", "update", "vscode"],
        embedding: [0, 0, 1],
      }),
    ],
  };

  test("category filter keeps only exact category matches", async () => {
    const results = await searchDocuments(index, "agent diary", {
      topK: 5,
      minScore: 0,
      hybridWeight: 0,
      category: "learnings",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].chunk.metadata.category, "learnings");
  });

  test("topic filter accepts human text and matches slugged topic metadata", async () => {
    const results = await searchDocuments(index, "agent diary", {
      topK: 5,
      minScore: 0,
      hybridWeight: 0,
      topic: "Agent Diaries",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].chunk.metadata.topic, "agent-diaries-per-mode");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});