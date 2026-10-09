import * as assert from "assert";
import type { CancellationToken, Disposable } from "vscode";
import {
  type CancellableOperation,
  createCancellableOperation,
} from "../cancellable-operation";

suite("CancellableOperation", () => {
  let op: CancellableOperation;

  teardown(() => {
    // Safety net — always dispose to prevent leaks in test runner
    if (op && !op.isDisposed) {
      op.dispose();
    }
  });

  test("starts in non-cancelled, non-disposed state", () => {
    op = createCancellableOperation();
    assert.strictEqual(op.isCancelled, false);
    assert.strictEqual(op.isDisposed, false);
    assert.strictEqual(op.signal.aborted, false);
  });

  test("cancel() sets isCancelled and aborts signal", () => {
    op = createCancellableOperation();
    op.cancel();
    assert.strictEqual(op.isCancelled, true);
    assert.strictEqual(op.signal.aborted, true);
  });

  test("cancel(reason) passes reason to AbortController", () => {
    op = createCancellableOperation();
    op.cancel("user-stop");
    assert.strictEqual(op.signal.aborted, true);
    assert.strictEqual(op.signal.reason, "user-stop");
  });

  test("cancel() is idempotent — multiple calls safe", () => {
    op = createCancellableOperation();
    op.cancel("first");
    op.cancel("second");
    assert.strictEqual(op.isCancelled, true);
    // Reason should be from the first call
    assert.strictEqual(op.signal.reason, "first");
  });

  test("dispose() sets isDisposed", () => {
    op = createCancellableOperation();
    op.dispose();
    assert.strictEqual(op.isDisposed, true);
  });

  test("dispose() aborts signal if not already cancelled", () => {
    op = createCancellableOperation();
    assert.strictEqual(op.signal.aborted, false);
    op.dispose();
    // dispose() should have called cancel("disposed-without-cancel")
    assert.strictEqual(op.isCancelled, true);
    assert.strictEqual(op.signal.aborted, true);
    assert.strictEqual(op.signal.reason, "disposed-without-cancel");
  });

  test("dispose() is idempotent — multiple calls safe", () => {
    op = createCancellableOperation();
    op.dispose();
    op.dispose(); // Should not throw
    assert.strictEqual(op.isDisposed, true);
  });

  test("cancel() after dispose() is no-op", () => {
    op = createCancellableOperation();
    op.dispose();
    // dispose() already cancelled with "disposed-without-cancel"
    op.cancel("late-cancel");
    // Reason should remain from dispose
    assert.strictEqual(op.signal.reason, "disposed-without-cancel");
  });

  test("signal fires abort event on cancel", () => {
    op = createCancellableOperation();
    let fired = false;
    op.signal.addEventListener("abort", () => {
      fired = true;
    }, { once: true });
    op.cancel();
    assert.strictEqual(fired, true);
  });

  test("VS Code CancellationToken triggers cancel", () => {
    // Mock a minimal VS Code CancellationToken
    let registeredCallback: (() => void) | null = null;
    const mockToken: CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: (e: unknown) => void): Disposable => {
        registeredCallback = () => cb(undefined);
        return { dispose: () => { registeredCallback = null; } };
      },
    };

    op = createCancellableOperation(mockToken);
    assert.strictEqual(op.isCancelled, false);

    // Simulate VS Code cancellation
    registeredCallback!();
    assert.strictEqual(op.isCancelled, true);
    assert.strictEqual(op.signal.reason, "vscode-cancellation-token");
  });

  test("dispose() removes VS Code CancellationToken listener", () => {
    let listenerDisposed = false;
    const mockToken: CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: (_cb: (e: unknown) => void): Disposable => {
        return {
          dispose: () => { listenerDisposed = true; },
        };
      },
    };

    op = createCancellableOperation(mockToken);
    assert.strictEqual(listenerDisposed, false);

    op.dispose();
    assert.strictEqual(listenerDisposed, true);
  });
});
