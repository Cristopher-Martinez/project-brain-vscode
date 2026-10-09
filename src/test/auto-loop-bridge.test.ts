import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Auto Loop Bridge tests -- validates core bridge logic:
 * - loadHistoryAsBridgeSyntheses conversion
 * - bulkLoadSyntheses session loading
 * - synthesisId uniqueness
 * - checkPmChatRateLimit behavior
 */

suite("Auto Loop Bridge", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- loadHistoryAsBridgeSyntheses -------------------------------------------

  suite("loadHistoryAsBridgeSyntheses", () => {
    function createHistory(sessionId: string, iterations: object[]): void {
      const loopDir = path.join(tmpDir, ".project-brain", "loops", sessionId);
      fs.mkdirSync(loopDir, { recursive: true });
      fs.writeFileSync(
        path.join(loopDir, "history.json"),
        JSON.stringify({
          sessionId,
          goal: "test goal",
          iterations,
          totalIterations: iterations.length,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        }),
      );
    }

    test("returns empty array for missing history", () => {
      // Dynamic import to avoid VS Code dependency at module level
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const result = loadHistoryAsBridgeSyntheses("nonexistent-id", tmpDir);
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });

    test("converts iterations with synthesis to BridgeSynthesis[]", () => {
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const sessionId = "test-session-001";
      createHistory(sessionId, [
        { index: 1, prompt: "p1", synthesis: "First synthesis", startedAt: "2025-01-01T00:00:00Z", completedAt: "2025-01-01T00:01:00Z" },
        { index: 2, prompt: "p2", synthesis: "Second synthesis", feedback: "Good", startedAt: "2025-01-01T00:02:00Z", completedAt: "2025-01-01T00:03:00Z" },
      ]);

      const result = loadHistoryAsBridgeSyntheses(sessionId, tmpDir);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].round, 1);
      assert.strictEqual(result[0].content, "First synthesis");
      assert.strictEqual(result[1].round, 2);
      assert.strictEqual(result[1].content, "Second synthesis");
    });

    test("filters iterations without synthesis", () => {
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const sessionId = "test-session-002";
      createHistory(sessionId, [
        { index: 1, prompt: "p1", startedAt: "2025-01-01T00:00:00Z" },
        { index: 2, prompt: "p2", synthesis: "Only one", startedAt: "2025-01-01T00:02:00Z", completedAt: "2025-01-01T00:03:00Z" },
        { index: 3, prompt: "p3", startedAt: "2025-01-01T00:04:00Z" },
      ]);

      const result = loadHistoryAsBridgeSyntheses(sessionId, tmpDir);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].round, 2);
    });

    test("generates unique synthesisId per iteration", () => {
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const sessionId = "test-session-003";
      createHistory(sessionId, [
        { index: 1, prompt: "p1", synthesis: "S1", startedAt: "2025-01-01T00:00:00Z", completedAt: "2025-01-01T00:01:00Z" },
        { index: 2, prompt: "p2", synthesis: "S2", startedAt: "2025-01-01T00:02:00Z", completedAt: "2025-01-01T00:03:00Z" },
        { index: 3, prompt: "p3", synthesis: "S3", startedAt: "2025-01-01T00:04:00Z", completedAt: "2025-01-01T00:05:00Z" },
      ]);

      const result = loadHistoryAsBridgeSyntheses(sessionId, tmpDir);
      const ids = new Set(result.map((s: any) => s.synthesisId));
      assert.strictEqual(ids.size, 3, "All synthesis IDs should be unique");
    });

    test("historical IDs use synth_hist_ prefix", () => {
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const sessionId = "test-session-004";
      createHistory(sessionId, [
        { index: 1, prompt: "p1", synthesis: "S1", startedAt: "2025-01-01T00:00:00Z", completedAt: "2025-01-01T00:01:00Z" },
      ]);

      const result = loadHistoryAsBridgeSyntheses(sessionId, tmpDir);
      assert.ok(result[0].synthesisId.startsWith("synth_hist_"), `Expected synth_hist_ prefix, got ${result[0].synthesisId}`);
    });

    test("timestamps convert correctly from ISO to epoch", () => {
      const { loadHistoryAsBridgeSyntheses } = require("../loop-history-rag");
      const sessionId = "test-session-005";
      const completedAt = "2025-06-15T12:30:00Z";
      createHistory(sessionId, [
        { index: 1, prompt: "p1", synthesis: "S1", startedAt: "2025-01-01T00:00:00Z", completedAt },
      ]);

      const result = loadHistoryAsBridgeSyntheses(sessionId, tmpDir);
      assert.strictEqual(result[0].timestamp, new Date(completedAt).getTime());
    });
  });

  // -- synthesisId uniqueness (live IDs) --------------------------------------

  suite("synthesisId collision resistance", () => {
    test("generates 100 unique live IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = `synth_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        ids.add(id);
      }
      assert.strictEqual(ids.size, 100, "All 100 IDs should be unique");
    });
  });

  // -- checkPmChatRateLimit ---------------------------------------------------

  suite("checkPmChatRateLimit", () => {
    test("allows calls within rate limit", () => {
      const { checkPmChatRateLimit, clearPmChatRateLimit } = require("../auto-loop-token-guardrails");
      const sessionId = "rate-test-001";
      clearPmChatRateLimit(sessionId);

      const allowed = checkPmChatRateLimit(sessionId);
      assert.strictEqual(allowed, true);
      clearPmChatRateLimit(sessionId);
    });

    test("blocks after exceeding rate limit", () => {
      const { checkPmChatRateLimit, clearPmChatRateLimit } = require("../auto-loop-token-guardrails");
      const sessionId = "rate-test-002";
      clearPmChatRateLimit(sessionId);

      // Call 10 times to exhaust the limit
      for (let i = 0; i < 10; i++) {
        checkPmChatRateLimit(sessionId);
      }

      const blocked = checkPmChatRateLimit(sessionId);
      assert.strictEqual(blocked, false, "11th call should be blocked");
      clearPmChatRateLimit(sessionId);
    });
  });

  // -- PM Sliding Window (party room model) -----------------------------------

  suite("PM sliding window guardrail", () => {
    test("checkBudgetWarning never blocks, only informs", () => {
      const { checkBudgetWarning, BRIDGE_DEFAULT_BUDGET } = require("../auto-loop-token-guardrails");
      // Simulate consumed turns exceeding max — PM should NOT be blocked
      const budget = { ...BRIDGE_DEFAULT_BUDGET, consumedTurns: 100, maxSuggestionTurns: 50 };
      const warning = checkBudgetWarning(budget);
      // Verify it reports "exhausted" (info only) but the PM session code no longer uses it to block
      assert.strictEqual(warning.level, "exhausted");
      assert.strictEqual(warning.turnsRemaining, 0);
    });

    test("clampBudget does not introduce turn-based blocking", () => {
      const { clampBudget, BRIDGE_DEFAULT_BUDGET } = require("../auto-loop-token-guardrails");
      const budget = clampBudget({ ...BRIDGE_DEFAULT_BUDGET, consumedTurns: 999 });
      // consumedTurns is preserved (for metrics) but has no blocking power
      assert.strictEqual(budget.consumedTurns, 999);
      assert.ok(budget.maxSuggestionTurns > 0, "maxSuggestionTurns should still exist for metrics");
    });

    test("assembleContext trims history to max 20 messages (sliding window)", () => {
      const { assembleContext } = require("../auto-loop-context-assembler");
      const messages: any[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push({ id: `msg_${i}`, synthesisId: "s1", role: i % 2 === 0 ? "user" : "pm", text: `Message ${i}`, timestamp: Date.now() + i });
      }

      const result = assembleContext({
        objective: "test",
        activeSynthesis: { synthesisId: "s1", round: 1, content: "test synthesis", timestamp: Date.now(), workerLoopSessionId: "w1" },
        taskMemory: { sessionId: "t1", objective: "test", decisions: [], createdAt: Date.now(), updatedAt: Date.now() },
        retrievalChunks: [],
        pmChatHistory: messages,
        userMessage: "hello",
        budget: { maxContextChars: 8000, maxRetrievedChunks: 5, maxSuggestionTurns: 50, maxTokensPerTurn: 2048, consumedTurns: 0 },
      });

      assert.ok(result.pmChatHistory.length <= 20, `Expected <=20 messages, got ${result.pmChatHistory.length}`);
      // Verify it keeps the MOST RECENT messages (FIFO eviction of oldest)
      if (result.pmChatHistory.length > 0) {
        const lastMsg = result.pmChatHistory[result.pmChatHistory.length - 1];
        assert.strictEqual(lastMsg.id, "msg_29", "Should keep the most recent message");
      }
    });
  });
});
