import * as assert from "assert";
import {
  AdaptiveLatencyTracker,
  type LatencyPrediction,
} from "../adaptive-latency";

suite("AdaptiveLatencyTracker", () => {
  let tracker: AdaptiveLatencyTracker;

  setup(() => {
    tracker = new AdaptiveLatencyTracker();
  });

  // ─── Cold Start / Defaults ──────────────────────────────────────────────

  suite("Cold Start", () => {
    test("returns tier default with confident=false when no samples", () => {
      const pred = tracker.getExpected("gpt-4o");
      assert.strictEqual(pred.confident, false);
      assert.strictEqual(typeof pred.ms, "number");
      assert.ok(pred.ms > 0, "default must be positive");
    });

    test("uses tier-specific defaults when tier is provided via setTier", () => {
      tracker.setModelTier("fast-model", "free");
      tracker.setModelTier("heavy-model", "premium");

      const fast = tracker.getExpected("fast-model");
      const heavy = tracker.getExpected("heavy-model");

      assert.ok(fast.ms < heavy.ms, "free tier should have lower default than premium");
      assert.strictEqual(fast.confident, false);
      assert.strictEqual(heavy.confident, false);
    });

    test("returns confident=false with fewer than 5 samples", () => {
      tracker.record("model-a", 100);
      tracker.record("model-a", 200);
      tracker.record("model-a", 150);
      tracker.record("model-a", 180);
      const pred = tracker.getExpected("model-a");
      assert.strictEqual(pred.confident, false); // only 4 samples
    });

    test("returns confident=true with 5+ samples", () => {
      for (let i = 0; i < 5; i++) {
        tracker.record("model-a", 100 + i * 10);
      }
      const pred = tracker.getExpected("model-a");
      assert.strictEqual(pred.confident, true);
    });
  });

  // ─── EWMA Math ──────────────────────────────────────────────────────────

  suite("EWMA Calculation", () => {
    test("first record sets EWMA to that value", () => {
      tracker.record("m", 100);
      const pred = tracker.getExpected("m");
      // With 1 sample, still not confident, but internal EWMA should be 100
      assert.strictEqual(pred.ms, 100);
    });

    test("EWMA with α=0.3 on sequence [100, 200, 150]", () => {
      // EWMA₁ = 100
      // EWMA₂ = 0.3 × 200 + 0.7 × 100 = 60 + 70 = 130
      // EWMA₃ = 0.3 × 150 + 0.7 × 130 = 45 + 91 = 136
      tracker.record("m", 100);
      tracker.record("m", 200);
      tracker.record("m", 150);
      const pred = tracker.getExpected("m");
      assert.ok(
        Math.abs(pred.ms - 136) < 0.01,
        `Expected ~136, got ${pred.ms}`,
      );
    });

    test("α=0.3 weighs recent samples more", () => {
      // Record low values then a spike
      for (let i = 0; i < 10; i++) {
        tracker.record("m", 100);
      }
      tracker.record("m", 1000); // sudden spike
      const afterSpike = tracker.getExpected("m");

      // EWMA should have moved toward 1000 but not reached it
      assert.ok(afterSpike.ms > 100, "should increase after spike");
      assert.ok(afterSpike.ms < 1000, "should not jump to spike value");
    });

    test("converges toward stable mean over many samples", () => {
      const targetMean = 500;
      for (let i = 0; i < 50; i++) {
        tracker.record("m", targetMean);
      }
      const pred = tracker.getExpected("m");
      assert.ok(
        Math.abs(pred.ms - targetMean) < 1,
        `Should converge to ${targetMean}, got ${pred.ms}`,
      );
    });
  });

  // ─── Hierarchical Fallback ──────────────────────────────────────────────

  suite("Hierarchical Fallback", () => {
    test("uses specific (model:task) key when it has enough data", () => {
      // Record 5 samples for specific key
      for (let i = 0; i < 5; i++) {
        tracker.record("gpt-4o:code-review", 200 + i * 10);
      }
      // Record 5 different samples for generic model key
      for (let i = 0; i < 5; i++) {
        tracker.record("gpt-4o", 500 + i * 10);
      }

      const pred = tracker.getExpectedHierarchical("gpt-4o", "code-review");
      assert.strictEqual(pred.confident, true);
      // Should use the specific key (~230-ish via EWMA), not the generic (~530)
      assert.ok(pred.ms < 400, `Should use specific key, got ${pred.ms}`);
    });

    test("falls back to model-level when task-specific has insufficient data", () => {
      // Only 2 samples for specific key
      tracker.record("gpt-4o:chat", 200);
      tracker.record("gpt-4o:chat", 250);
      // 5 samples for generic model key
      for (let i = 0; i < 5; i++) {
        tracker.record("gpt-4o", 500 + i * 10);
      }

      const pred = tracker.getExpectedHierarchical("gpt-4o", "chat");
      assert.strictEqual(pred.confident, true);
      assert.ok(pred.ms > 400, `Should fall back to model-level, got ${pred.ms}`);
    });

    test("falls back to tier default when no data at any level", () => {
      tracker.setModelTier("claude-3.5-sonnet", "standard");
      const pred = tracker.getExpectedHierarchical("claude-3.5-sonnet", "debug-analyze");
      assert.strictEqual(pred.confident, false);
      assert.strictEqual(typeof pred.ms, "number");
    });
  });

  // ─── Reset ──────────────────────────────────────────────────────────────

  suite("Reset", () => {
    test("reset(key) clears data for a specific key", () => {
      for (let i = 0; i < 5; i++) {
        tracker.record("m", 100);
      }
      assert.strictEqual(tracker.getExpected("m").confident, true);

      tracker.reset("m");
      assert.strictEqual(tracker.getExpected("m").confident, false);
    });

    test("resetAll() clears all data", () => {
      for (let i = 0; i < 5; i++) {
        tracker.record("a", 100);
        tracker.record("b", 200);
      }
      tracker.resetAll();
      assert.strictEqual(tracker.getExpected("a").confident, false);
      assert.strictEqual(tracker.getExpected("b").confident, false);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────

  suite("Edge Cases", () => {
    test("handles zero latency gracefully", () => {
      tracker.record("m", 0);
      const pred = tracker.getExpected("m");
      assert.strictEqual(pred.ms, 0);
    });

    test("handles very large latency values", () => {
      tracker.record("m", 999999);
      const pred = tracker.getExpected("m");
      assert.strictEqual(pred.ms, 999999);
    });

    test("multiple models tracked independently", () => {
      for (let i = 0; i < 5; i++) {
        tracker.record("fast", 100);
        tracker.record("slow", 5000);
      }
      const fast = tracker.getExpected("fast");
      const slow = tracker.getExpected("slow");
      assert.ok(fast.ms < slow.ms, "models should be independent");
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────────

  suite("Stats", () => {
    test("getSampleCount returns correct count per key", () => {
      tracker.record("m", 100);
      tracker.record("m", 200);
      tracker.record("m", 300);
      assert.strictEqual(tracker.getSampleCount("m"), 3);
    });

    test("getSampleCount returns 0 for unknown key", () => {
      assert.strictEqual(tracker.getSampleCount("unknown"), 0);
    });

    test("getTrackedKeys returns all known keys", () => {
      tracker.record("a", 100);
      tracker.record("b", 200);
      const keys = tracker.getTrackedKeys();
      assert.ok(keys.includes("a"));
      assert.ok(keys.includes("b"));
      assert.strictEqual(keys.length, 2);
    });
  });
});
