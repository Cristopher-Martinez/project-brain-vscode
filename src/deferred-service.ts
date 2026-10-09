/**
 * DeferredService<T> — Lazy-init wrapper for expensive services.
 *
 * Delays initialization until first access. Promise coalescing ensures
 * concurrent callers share a single factory invocation.
 *
 * Inspired by KiloCode's deferred init patterns.
 * Pure module: zero VS Code dependencies, fully testable standalone.
 *
 * Usage:
 *   const db = new DeferredService((signal) => SessionDB.create(path, signal));
 *   const instance = await db.get(); // Factory runs on first call only
 *   db.dispose(); // Cleans up instance + aborts if still initializing
 *
 * @module deferred-service
 */

/** Factory function that creates the service. Receives AbortSignal for cancellation. */
export type ServiceFactory<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Thrown when get() resolves after dispose() — distinguishable from real errors.
 * Callers can catch this specifically to suppress expected noise:
 *   try { await svc.get(); } catch (e) { if (e instanceof DeferredDisposedError) return; throw e; }
 */
export class DeferredDisposedError extends Error {
  constructor() {
    super("DeferredService: disposed during initialization");
    this.name = "DeferredDisposedError";
  }
}

/**
 * Lazy-initializing service container with:
 * - Single factory invocation (Promise coalescing)
 * - AbortSignal integration for clean dispose-during-init
 * - Retry on failure (errors are not cached)
 * - Optional T.dispose() call on dispose
 */
export class DeferredService<T> {
  private instance: T | null = null;
  private initializing: Promise<T> | null = null;
  private disposed = false;
  private ac = new AbortController();
  private factory: ServiceFactory<T> | null;

  constructor(factory: ServiceFactory<T>) {
    this.factory = factory;
  }

  /**
   * Get or create the service instance.
   * First call triggers the factory; subsequent calls return the cached instance.
   * Concurrent calls share the same Promise (coalescing).
   * @throws Error if service has been disposed
   */
  async get(): Promise<T> {
    if (this.disposed) {
      throw new Error("DeferredService: service has been disposed");
    }

    if (this.instance) return this.instance;

    if (!this.initializing) {
      this.initializing = this.factory!(this.ac.signal)
        .then((instance) => {
          if (this.disposed) {
            // Service was disposed while factory was running — clean up silently
            const d = instance as Record<string, unknown>;
            if (typeof d.dispose === "function") d.dispose();
            throw new DeferredDisposedError();
          }
          this.instance = instance;
          return instance;
        })
        .catch((err) => {
          // Don't cache failures — allow retry
          this.initializing = null;
          // If disposed during init, throw distinguishable error
          if (this.disposed) throw new DeferredDisposedError();
          throw err;
        });
    }

    return this.initializing;
  }

  /**
   * Dispose the service — aborts pending init, calls T.dispose() if available.
   * Idempotent: safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Abort any in-progress factory
    this.ac.abort();

    // Dispose the instance if it exists and has a dispose method
    if (this.instance) {
      const d = this.instance as Record<string, unknown>;
      if (typeof d.dispose === "function") d.dispose();
    }

    // Clean up references for GC
    this.instance = null;
    this.initializing = null;
    this.factory = null;
  }

  /** Whether the service has been successfully initialized. */
  get isInitialized(): boolean {
    return this.instance !== null;
  }
}
