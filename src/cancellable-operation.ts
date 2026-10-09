/**
 * Abstracción para operaciones cancelables de larga duración.
 *
 * SRP: solo gestiona el ciclo de vida de cancelación.
 *
 * Contrato:
 * - cancel() es idempotente — llamar N veces es seguro
 * - dispose() DEBE llamarse siempre (usar try/finally)
 * - dispose() aborta si no se canceló previamente (cleanup safety)
 * - signal puede pasarse a APIs Node.js (fetch, execFile, etc.)
 *
 * @module cancellable-operation
 */

import type { CancellationToken } from "vscode";

/**
 * Represents a cancellable long-running operation backed by AbortController.
 */
export interface CancellableOperation {
  /** Whether this operation has been cancelled */
  readonly isCancelled: boolean;
  /** Whether dispose() has been called */
  readonly isDisposed: boolean;
  /** AbortSignal compatible with Node.js APIs */
  readonly signal: AbortSignal;
  /** Cancel the operation. Idempotent. */
  cancel(reason?: string): void;
  /** Dispose resources (listeners). Aborts if not already cancelled. Idempotent. */
  dispose(): void;
}

/**
 * Creates a CancellableOperation backed by AbortController.
 * Optionally links to a VS Code CancellationToken for UI integration.
 *
 * @param vscodeCancellation - VS Code token that triggers cancel() when fired
 * @returns A new CancellableOperation. Caller MUST call dispose() in a finally block.
 */
export function createCancellableOperation(
  vscodeCancellation?: CancellationToken,
): CancellableOperation {
  const controller = new AbortController();
  let cancelled = false;
  let disposed = false;

  // Link VS Code cancellation → AbortController (auto-cleanup on dispose)
  const listener = vscodeCancellation?.onCancellationRequested(() =>
    cancel("vscode-cancellation-token"),
  );

  function cancel(reason?: string): void {
    if (cancelled) return;
    cancelled = true;
    try {
      controller.abort(reason ?? "cancelled");
    } catch {
      // AbortController.abort() defensive — should not throw in Node 22
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listener?.dispose();
    if (!cancelled) {
      cancel("disposed-without-cancel");
    }
  }

  return {
    get isCancelled() {
      return cancelled;
    },
    get isDisposed() {
      return disposed;
    },
    get signal() {
      return controller.signal;
    },
    cancel,
    dispose,
  };
}
