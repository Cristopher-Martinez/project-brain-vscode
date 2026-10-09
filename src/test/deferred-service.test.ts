import * as assert from "assert";
import { DeferredService, DeferredDisposedError } from "../deferred-service";

/** Helper: create a mock service with dispose tracking. */
function mockService(value = 42) {
  let disposed = false;
  return {
    factory: async (_signal?: AbortSignal) => ({
      value,
      get isDisposed() { return disposed; },
      dispose() { disposed = true; },
    }),
    isDisposed: () => disposed,
  };
}

/** Helper: create a slow factory for timing tests. */
function slowFactory(ms: number, value = 99) {
  return async (signal?: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      });
    });
    return { value, dispose() {} };
  };
}

suite("DeferredService", () => {
  // ─── Lazy initialization ────────────────────────────────────

  suite("Lazy init", () => {
    test("get() executes factory and returns instance", async () => {
      const mock = mockService(7);
      const svc = new DeferredService(mock.factory);
      const result = await svc.get();
      assert.strictEqual(result.value, 7);
    });

    test("get() calls factory only once (caches result)", async () => {
      let callCount = 0;
      const svc = new DeferredService(async () => {
        callCount++;
        return { value: callCount, dispose() {} };
      });
      const r1 = await svc.get();
      const r2 = await svc.get();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(r1, r2); // Same reference
    });

    test("isInitialized is false before get, true after", async () => {
      const svc = new DeferredService(mockService().factory);
      assert.strictEqual(svc.isInitialized, false);
      await svc.get();
      assert.strictEqual(svc.isInitialized, true);
    });
  });

  // ─── Promise coalescing ─────────────────────────────────────

  suite("Promise coalescing", () => {
    test("concurrent get() calls result in single factory invocation", async () => {
      let callCount = 0;
      const svc = new DeferredService(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { value: callCount, dispose() {} };
      });

      const [r1, r2, r3] = await Promise.all([
        svc.get(),
        svc.get(),
        svc.get(),
      ]);

      assert.strictEqual(callCount, 1);
      assert.strictEqual(r1, r2);
      assert.strictEqual(r2, r3);
    });
  });

  // ─── Dispose ────────────────────────────────────────────────

  suite("Dispose", () => {
    test("dispose() calls dispose on initialized instance", async () => {
      const mock = mockService();
      const svc = new DeferredService(mock.factory);
      await svc.get();
      svc.dispose();
      assert.strictEqual(mock.isDisposed(), true);
    });

    test("get() after dispose() throws Error", async () => {
      const svc = new DeferredService(mockService().factory);
      await svc.get();
      svc.dispose();
      await assert.rejects(() => svc.get(), /disposed/i);
    });

    test("dispose() before get() is safe (no instance to dispose)", () => {
      const svc = new DeferredService(mockService().factory);
      svc.dispose(); // Should not throw
      assert.strictEqual(svc.isInitialized, false);
    });

    test("dispose() is idempotent — multiple calls safe", async () => {
      const mock = mockService();
      const svc = new DeferredService(mock.factory);
      await svc.get();
      svc.dispose();
      svc.dispose(); // Should not throw or double-dispose
      assert.strictEqual(mock.isDisposed(), true);
    });

    test("isInitialized is false after dispose", async () => {
      const svc = new DeferredService(mockService().factory);
      await svc.get();
      assert.strictEqual(svc.isInitialized, true);
      svc.dispose();
      assert.strictEqual(svc.isInitialized, false);
    });
  });

  // ─── Retry on failure ──────────────────────────────────────

  suite("Retry on failure", () => {
    test("failed factory does not cache error — retry works", async () => {
      let attempt = 0;
      const svc = new DeferredService(async () => {
        attempt++;
        if (attempt === 1) throw new Error("Init failed");
        return { value: attempt, dispose() {} };
      });

      await assert.rejects(() => svc.get(), /Init failed/);
      // Second attempt should work
      const result = await svc.get();
      assert.strictEqual(result.value, 2);
    });

    test("isInitialized remains false after factory failure", async () => {
      const svc = new DeferredService(async () => {
        throw new Error("boom");
      });
      try { await svc.get(); } catch { /* expected */ }
      assert.strictEqual(svc.isInitialized, false);
    });
  });

  // ─── AbortSignal integration ────────────────────────────────

  suite("AbortSignal", () => {
    test("factory receives AbortSignal", async () => {
      let receivedSignal: AbortSignal | undefined;
      const svc = new DeferredService(async (signal) => {
        receivedSignal = signal;
        return { dispose() {} };
      });
      await svc.get();
      assert.ok(receivedSignal instanceof AbortSignal);
    });

    test("dispose during init throws DeferredDisposedError (distinguishable)", async () => {
      const svc = new DeferredService(slowFactory(500));

      const getPromise = svc.get().catch((e) => e);
      await new Promise((r) => setTimeout(r, 10));
      svc.dispose();

      const result = await getPromise;
      assert.ok(result instanceof DeferredDisposedError);
      assert.strictEqual(result.name, "DeferredDisposedError");
    });

    test("abort does not leak — signal is cleaned up after init", async () => {
      const svc = new DeferredService(async (signal) => {
        assert.strictEqual(signal.aborted, false);
        return { dispose() {} };
      });
      await svc.get();
      svc.dispose(); // Clean dispose after successful init
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────

  suite("Edge cases", () => {
    test("works with service that has no dispose method", async () => {
      const svc = new DeferredService(async () => ({ value: "no-dispose" }));
      const result = await svc.get();
      assert.strictEqual(result.value, "no-dispose");
      svc.dispose(); // Should not throw even without dispose()
    });

    test("factory returning sync-like value works", async () => {
      const svc = new DeferredService(async () => ({
        data: [1, 2, 3],
        dispose() {},
      }));
      const result = await svc.get();
      assert.deepStrictEqual(result.data, [1, 2, 3]);
    });
  });
});
