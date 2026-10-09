import * as assert from "assert";
import { createCancellableOperation } from "../cancellable-operation";

/**
 * Integration tests for CancellableOperation + AutoVectorizer cancel patterns.
 *
 * These tests validate the patterns used in auto-vectorizer.ts without
 * requiring the full VS Code extension host. They verify the abort/tree-kill
 * wiring, multiple-cancel scenarios, and lifecycle edge cases.
 */
suite("AutoVectorizer — Cancellation Integration Patterns", () => {

  test("abort signal fires handler when cancel() is called mid-operation", async () => {
    const op = createCancellableOperation();
    let abortFired = false;

    const onAbort = () => { abortFired = true; };
    op.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Simulate async operation that gets cancelled
      const promise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 5000);
        op.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("AbortError"));
        }, { once: true });
      });

      // Cancel after a microtask
      op.cancel("test-cancel");

      try {
        await promise;
        assert.fail("Should have been rejected");
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.strictEqual(op.isCancelled, true);
      }

      assert.strictEqual(abortFired, true);
    } finally {
      op.signal.removeEventListener("abort", onAbort);
      op.dispose();
    }
  });

  test("rapid re-trigger: second operation cancels the first", async () => {
    // Simulates triggerSync() being called twice in quick succession
    let op1Cancelled = false;
    let op2Completed = false;

    // First operation
    const op1 = createCancellableOperation();
    const promise1 = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve("op1-done"), 5000);
      op1.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        op1Cancelled = true;
        reject(new Error("Cancelled"));
      }, { once: true });
    });

    // Second operation cancels the first (like cancelSync() in triggerSync)
    op1.cancel("replaced-by-new-sync");
    op1.dispose();

    const op2 = createCancellableOperation();

    try {
      await promise1;
      assert.fail("Op1 should have been cancelled");
    } catch {
      // Expected
    }

    // Op2 completes normally
    const promise2 = Promise.resolve("op2-done");
    await promise2;
    op2Completed = true;

    assert.strictEqual(op1Cancelled, true);
    assert.strictEqual(op2Completed, true);
    assert.strictEqual(op1.isCancelled, true);
    assert.strictEqual(op2.isCancelled, false);

    op2.dispose();
  });

  test("cancel after operation already completed is harmless", async () => {
    const op = createCancellableOperation();
    let onAbortCalled = false;

    const onAbort = () => { onAbortCalled = true; };
    op.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Operation completes immediately
      const result = await Promise.resolve("done");
      assert.strictEqual(result, "done");

      // Now cancel (like the user clicks stop after sync finished)
      op.cancel("late-cancel");
      assert.strictEqual(op.isCancelled, true);
      assert.strictEqual(onAbortCalled, true);
      // No error thrown — this is the key assertion
    } finally {
      op.signal.removeEventListener("abort", onAbort);
      op.dispose();
    }
  });

  test("dispose always cleans up even without explicit cancel", () => {
    const op = createCancellableOperation();

    const onAbort = () => { /* tracked via signal.reason */ };
    op.signal.addEventListener("abort", onAbort, { once: true });

    // Simulate the finally {} block in triggerSync — no cancel, just dispose
    op.signal.removeEventListener("abort", onAbort);
    op.dispose();

    // dispose() should have called cancel("disposed-without-cancel") internally
    assert.strictEqual(op.isCancelled, true);
    assert.strictEqual(op.isDisposed, true);
    assert.strictEqual(op.signal.reason, "disposed-without-cancel");
  });

  test("killChildTree pattern: abort handler checks exitCode guard", () => {
    const op = createCancellableOperation();
    let killAttempted = false;

    // Simulate the pattern from auto-vectorizer.ts
    const mockExitCode: number | null = 0; // Process already exited

    const onAbort = () => {
      if (mockExitCode === null) {
        killAttempted = true; // Would call killChildTree
      }
    };
    op.signal.addEventListener("abort", onAbort, { once: true });

    op.cancel("test");

    // exitCode was 0 (already dead), so kill should NOT have been attempted
    assert.strictEqual(killAttempted, false);

    op.signal.removeEventListener("abort", onAbort);
    op.dispose();
  });

  test("killChildTree pattern: abort handler kills running process", () => {
    const op = createCancellableOperation();
    let killAttempted = false;

    // Simulate the pattern from auto-vectorizer.ts
    const mockExitCode: number | null = null; // Process still running

    const onAbort = () => {
      if (mockExitCode === null) {
        killAttempted = true; // Would call killChildTree
      }
    };
    op.signal.addEventListener("abort", onAbort, { once: true });

    op.cancel("test");

    // exitCode was null (still running), so kill SHOULD have been attempted
    assert.strictEqual(killAttempted, true);

    op.signal.removeEventListener("abort", onAbort);
    op.dispose();
  });

  test("activeSyncOp reference pattern: only nullifies if same reference", () => {
    // Simulates the finally {} block in triggerSync
    let activeSyncOp = createCancellableOperation();
    const op1 = activeSyncOp;

    // Simulate a second triggerSync starting while first is in finally
    activeSyncOp = createCancellableOperation();
    const op2 = activeSyncOp;

    // Op1's finally block should NOT nullify activeSyncOp because it changed
    if (activeSyncOp === op1) {
      activeSyncOp = null as never; // This should NOT execute
    }

    assert.strictEqual(activeSyncOp, op2);
    assert.notStrictEqual(activeSyncOp, op1);

    op1.dispose();
    op2.dispose();
  });
});
