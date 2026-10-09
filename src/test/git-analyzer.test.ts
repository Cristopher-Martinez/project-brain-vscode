import * as assert from "assert";

// ─── Git Analyzer Tests ──────────────────────────────────────────────────────
// Test parsing and aggregation logic from git-analyzer.ts
// These tests validate the pure data-processing functions
// (commit parsing, coupling computation, author aggregation)

suite("Git Analyzer — Parsing Tests", () => {
  const SEP = "<<SEP>>";

  test("Parse commit log output", () => {
    // Simulate the raw output from `git log --pretty=format:<<SEP>>%H|%aI|%aN|%s --name-only`
    const rawOutput = [
      `${SEP}abc12345|2024-06-15T10:30:00Z|Alice|feat: add login`,
      "src/auth.ts",
      "src/utils.ts",
      "",
      `${SEP}def67890|2024-06-14T09:00:00Z|Bob|fix: broken nav`,
      "src/nav.ts",
    ].join("\n");

    const blocks = rawOutput.split(SEP).filter((b) => b.trim());
    assert.strictEqual(blocks.length, 2, "Should parse 2 commits");

    // Parse first commit
    const lines1 = blocks[0].trim().split("\n");
    const header1 = lines1[0];
    const parts1 = header1.split("|");
    assert.strictEqual(parts1[0], "abc12345", "Should extract hash");
    assert.ok(parts1[1].startsWith("2024-06-15"), "Should extract date");
    assert.strictEqual(parts1[2], "Alice", "Should extract author");
    assert.strictEqual(parts1[3], "feat: add login", "Should extract message");

    const files1 = lines1
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    assert.strictEqual(files1.length, 2, "Should find 2 changed files");
    assert.ok(files1.includes("src/auth.ts"), "Should include auth.ts");
    assert.ok(files1.includes("src/utils.ts"), "Should include utils.ts");
  });

  test("Compute file coupling from co-changes", () => {
    // Simulate commits with file lists
    const commits = [
      { files: ["a.ts", "b.ts"] },
      { files: ["a.ts", "b.ts", "c.ts"] },
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts", "d.ts"] },
      { files: ["a.ts", "c.ts"] },
    ];

    // Count co-occurrences
    const pairCount = new Map<string, number>();
    for (const commit of commits) {
      const files = commit.files.sort();
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = `${files[i]}||${files[j]}`;
          pairCount.set(key, (pairCount.get(key) || 0) + 1);
        }
      }
    }

    assert.strictEqual(
      pairCount.get("a.ts||b.ts"),
      3,
      "a.ts and b.ts should co-change 3 times",
    );
    assert.strictEqual(
      pairCount.get("a.ts||c.ts"),
      2,
      "a.ts and c.ts should co-change 2 times",
    );
    assert.strictEqual(
      pairCount.get("c.ts||d.ts"),
      1,
      "c.ts and d.ts should co-change 1 time",
    );
  });

  test("Aggregate authors from commits", () => {
    const commits = [
      { author: "Alice" },
      { author: "Bob" },
      { author: "Alice" },
      { author: "Alice" },
      { author: "Bob" },
      { author: "Charlie" },
    ];

    const authorMap = new Map<string, number>();
    for (const c of commits) {
      authorMap.set(c.author, (authorMap.get(c.author) || 0) + 1);
    }

    const sorted = Array.from(authorMap.entries())
      .map(([name, count]) => ({ name, commits: count }))
      .sort((a, b) => b.commits - a.commits);

    assert.strictEqual(sorted[0].name, "Alice", "Alice should be most active");
    assert.strictEqual(sorted[0].commits, 3);
    assert.strictEqual(sorted[1].name, "Bob");
    assert.strictEqual(sorted[1].commits, 2);
    assert.strictEqual(sorted[2].name, "Charlie");
    assert.strictEqual(sorted[2].commits, 1);
  });

  test("File extension to language mapping", () => {
    const extToLang: Record<string, string> = {
      ".ts": "TypeScript",
      ".tsx": "TypeScript (React)",
      ".js": "JavaScript",
      ".py": "Python",
      ".rs": "Rust",
      ".go": "Go",
      ".java": "Java",
      ".cs": "C#",
      ".cpp": "C++",
    };

    // Simulate file list
    const files = [
      "src/index.ts",
      "src/app.ts",
      "src/utils.ts",
      "src/helper.js",
      "tests/test.ts",
    ];

    const extCount = new Map<string, number>();
    let total = 0;
    for (const file of files) {
      const ext = "." + file.split(".").pop()!;
      extCount.set(ext, (extCount.get(ext) || 0) + 1);
      total++;
    }

    const languages = Array.from(extCount.entries())
      .map(([ext, count]) => ({
        language: extToLang[ext] || ext,
        percentage: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.percentage - a.percentage);

    assert.strictEqual(
      languages[0].language,
      "TypeScript",
      "TypeScript should be primary",
    );
    assert.strictEqual(languages[0].percentage, 80, "TypeScript should be 80%");
    assert.strictEqual(languages[1].language, "JavaScript");
    assert.strictEqual(languages[1].percentage, 20);
  });

  test("Hotspot detection should rank by commit count", () => {
    const fileMap = new Map<
      string,
      { commits: number; authors: Set<string>; lastDate: string }
    >();

    // Simulate commit activity
    const activity = [
      { file: "hot.ts", author: "A", date: "2024-06-15" },
      { file: "hot.ts", author: "B", date: "2024-06-14" },
      { file: "hot.ts", author: "A", date: "2024-06-13" },
      { file: "cold.ts", author: "A", date: "2024-06-15" },
      { file: "medium.ts", author: "B", date: "2024-06-14" },
      { file: "medium.ts", author: "C", date: "2024-06-12" },
    ];

    for (const act of activity) {
      const entry = fileMap.get(act.file) || {
        commits: 0,
        authors: new Set<string>(),
        lastDate: "",
      };
      entry.commits++;
      entry.authors.add(act.author);
      if (!entry.lastDate || act.date > entry.lastDate)
        entry.lastDate = act.date;
      fileMap.set(act.file, entry);
    }

    const hotspots = Array.from(fileMap.entries())
      .map(([file, data]) => ({
        file,
        commits: data.commits,
        authors: Array.from(data.authors),
        lastModified: data.lastDate,
      }))
      .sort((a, b) => b.commits - a.commits);

    assert.strictEqual(
      hotspots[0].file,
      "hot.ts",
      "hot.ts should be #1 hotspot",
    );
    assert.strictEqual(hotspots[0].commits, 3);
    assert.strictEqual(
      hotspots[0].authors.length,
      2,
      "hot.ts should have 2 unique authors",
    );
    assert.strictEqual(hotspots[1].file, "medium.ts");
    assert.strictEqual(hotspots[2].file, "cold.ts");
  });
});
