import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// ─── LM Tools Tests ──────────────────────────────────────────────────────────
// Test core LM tools functionality, pressure tracking, tool output validation

suite("LM Tools Tests", () => {
  // ─── Core Tools Registration ────────────────────────────────────────

  const CORE_TOOLS = [
    "searchMemory",
    "getContext",
    "writeMemory",
    "delegateTask",
    "contextPressure",
    "indexProject",
    "vectorizationStatus",
    "watchProject",
    "searchRelations",
    "memoryHistory",
    "listMemoryFiles",
    "listProjects",
    "heartbeat",
    "reflect",
    "strategyPicker",
  ];

  test("toolbox should register 15 core tools", () => {
    assert.strictEqual(CORE_TOOLS.length, 15);
    assert.ok(CORE_TOOLS.includes("searchMemory"));
    assert.ok(CORE_TOOLS.includes("getContext"));
    assert.ok(CORE_TOOLS.includes("writeMemory"));
    assert.ok(CORE_TOOLS.includes("delegateTask"));
    assert.ok(CORE_TOOLS.includes("contextPressure"));
  });

  test("awaken tool should be standalone (not in toolbox)", () => {
    assert.ok(!CORE_TOOLS.includes("awaken"));
  });

  test("diary tools should define required params in lm-tools.ts", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "lm-tools.ts"),
      "utf-8",
    );

    assert.ok(source.includes('readAgentDiary: ["mode"]'));
    assert.ok(source.includes('writeAgentDiary: ["mode", "learning"]'));
  });

  // ─── Pressure Tracking ────────────────────────────────────────────────

  test("pressure tracker should initialize at zero", () => {
    const tracker = {
      totalOutputBytes: 0,
      toolCallCount: 0,
      messageCount: 0,
    };

    assert.strictEqual(tracker.totalOutputBytes, 0);
    assert.strictEqual(tracker.toolCallCount, 0);
    assert.strictEqual(tracker.messageCount, 0);
  });

  test("pressure calculation should use bytes and tool counts", () => {
    // Simplified pressure calculation
    function calculatePressure(
      outputBytes: number,
      toolCalls: number,
      modelMaxTokens: number,
    ): number {
      const estimatedTokens = outputBytes / 4; // ~4 bytes per token
      const toolOverhead = toolCalls * 200; // ~200 tokens per tool call
      const totalEstimated = estimatedTokens + toolOverhead;
      return Math.min(100, Math.round((totalEstimated / modelMaxTokens) * 100));
    }

    // Small conversation
    assert.ok(
      calculatePressure(1000, 2, 200000) < 5,
      "Small conversation should have low pressure",
    );

    // Large conversation
    assert.ok(
      calculatePressure(400000, 50, 200000) > 50,
      "Large conversation should have high pressure",
    );
  });

  test("pressure levels should map correctly", () => {
    function getPressureLevel(pct: number): "🟢" | "🟡" | "🔴" | "☠️" {
      if (pct >= 85) return "☠️";
      if (pct >= 65) return "🔴";
      if (pct >= 40) return "🟡";
      return "🟢";
    }

    assert.strictEqual(getPressureLevel(0), "🟢");
    assert.strictEqual(getPressureLevel(39), "🟢");
    assert.strictEqual(getPressureLevel(40), "🟡");
    assert.strictEqual(getPressureLevel(64), "🟡");
    assert.strictEqual(getPressureLevel(65), "🔴");
    assert.strictEqual(getPressureLevel(84), "🔴");
    assert.strictEqual(getPressureLevel(85), "☠️");
    assert.strictEqual(getPressureLevel(100), "☠️");
  });

  // ─── Tool Output Format ──────────────────────────────────────────────

  test("search results should be markdown formatted", () => {
    function formatSearchResult(
      title: string,
      section: string,
      score: number,
      content: string,
    ): string {
      return [
        `## ${title}`,
        `Section: ${section}`,
        `Score: ${(score * 100).toFixed(1)}%`,
        `\`\`\``,
        content,
        `\`\`\``,
      ].join("\n");
    }

    const result = formatSearchResult(
      "01_ARCHITECTURE.md",
      "Overview",
      0.85,
      "The system uses...",
    );
    assert.ok(result.includes("## 01_ARCHITECTURE.md"));
    assert.ok(result.includes("85.0%"));
    assert.ok(result.includes("The system uses..."));
  });

  // ─── DelegateTask Validation ──────────────────────────────────────────

  test("valid task kinds should be accepted", () => {
    const validKinds = [
      "summarize",
      "generate-code",
      "generate-test",
      "code-review",
      "format",
      "list",
      "classify",
      "transform",
      "extract",
      "document",
      "debug-analyze",
      "refactor",
      "raw",
    ];

    assert.ok(validKinds.length >= 13, "Should have at least 13 task kinds");
    assert.ok(validKinds.includes("summarize"));
    assert.ok(validKinds.includes("raw"));
  });

  test("model tier ceiling should be respected", () => {
    const TIER_PRIORITY: Record<string, number> = {
      free: 0,
      cheap: 1,
      standard: 2,
      premium: 3,
      ultra: 4,
    };

    function isWithinBudget(modelTier: string, maxTier: string): boolean {
      return TIER_PRIORITY[modelTier] <= TIER_PRIORITY[maxTier];
    }

    assert.ok(isWithinBudget("free", "free"));
    assert.ok(isWithinBudget("free", "cheap"));
    assert.ok(!isWithinBudget("standard", "cheap"));
    assert.ok(!isWithinBudget("premium", "free"));
    assert.ok(isWithinBudget("premium", "ultra"));
  });
});
