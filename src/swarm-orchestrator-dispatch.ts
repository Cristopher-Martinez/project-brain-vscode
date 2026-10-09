// ============================================================
// swarm-orchestrator-dispatch.ts
// Task dispatch strategies: DAG-aware and batch execution
// Extracted from swarm-orchestrator.ts
// ============================================================

import * as vscode from "vscode";
import {
  SwarmWorker,
  type SwarmResult,
  type SwarmTask,
  type SwarmWorkerOptions,
} from "./swarm-worker";
import type { SwarmMailbox } from "./swarm-mailbox";
import { DAGScheduler, validateDAG } from "./task-dag";

// ─── Types ─────────────────────────────────────────────────────────────

export interface DispatchParams {
  tasks: SwarmTask[];
  concurrency: number;
  worker: SwarmWorker;
  token: vscode.CancellationToken;
  fallbackModel: vscode.LanguageModelChat;
  options?: SwarmWorkerOptions;
  mailbox?: SwarmMailbox;
  log: (msg: string) => void;
}

// ─── Dispatcher ────────────────────────────────────────────────────────

/**
 * Dispatch tasks using the appropriate strategy (DAG or batch).
 * Automatically detects dependencies and chooses the right mode.
 */
export async function dispatchSwarmTasks(
  params: DispatchParams,
): Promise<SwarmResult[]> {
  const { tasks, concurrency, log } = params;

  const hasDeps = tasks.some(
    (t) => t.dependsOn && t.dependsOn.length > 0,
  );

  return hasDeps
    ? dispatchDAG(params)
    : dispatchBatch(params);
}

// ─── DAG Dispatch ──────────────────────────────────────────────────────

async function dispatchDAG(params: DispatchParams): Promise<SwarmResult[]> {
  const {
    tasks, concurrency, worker, token,
    fallbackModel, options, mailbox, log,
  } = params;
  const results: SwarmResult[] = [];

  const validation = validateDAG(tasks);
  if (!validation.valid) {
    const issues: string[] = [];
    if (validation.cycles.length > 0) {
      issues.push(
        `Cycles detected: ${validation.cycles.map((c) => c.join(" → ")).join("; ")}`,
      );
    }
    if (validation.missingDeps.length > 0) {
      issues.push(
        `Missing deps: ${validation.missingDeps.map((d) => `${d.taskId} needs ${d.missingDep}`).join(", ")}`,
      );
    }
    throw new Error(`Invalid task DAG: ${issues.join(". ")}`);
  }

  log(
    `[Swarm] DAG mode: ${validation.roots.length} roots, ${tasks.length} total tasks`,
  );
  options?.onProgress?.(
    "swarm",
    `DAG mode: ${validation.roots.length} root tasks...`,
  );

  const scheduler = new DAGScheduler(tasks, log);

  while (!scheduler.isComplete()) {
    const ready = scheduler.getReady(concurrency);
    if (ready.length === 0) {
      log("[Swarm] DAG: No ready tasks but scheduler not complete — breaking");
      break;
    }

    const counts = scheduler.getStatusCounts();
    log(
      `[Swarm] DAG batch: ${ready.length} tasks dispatching (${counts.completed} done, ${counts.pending} pending, ${counts.blocked} blocked)`,
    );
    options?.onProgress?.(
      "swarm",
      `DAG: dispatching ${ready.length} (${counts.completed}/${tasks.length} done)...`,
    );

    const batchResults = await Promise.allSettled(
      ready.map((task) =>
        worker.execute(task, token, fallbackModel, {
          ...options,
          mailbox,
        }),
      ),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const settled = batchResults[j];
      if (settled.status === "fulfilled") {
        results.push(settled.value);
        if (settled.value.success) {
          log(
            `[Swarm] DAG task ${ready[j].id}: COMPLETED (${settled.value.rounds} rounds, ${settled.value.toolCalls.length} tool calls, ${settled.value.durationMs}ms)`,
          );
          scheduler.markCompleted(ready[j].id);
        } else {
          log(
            `[Swarm] DAG task ${ready[j].id}: FAILED — ${settled.value.error}`,
          );
          scheduler.markFailed(ready[j].id);
        }
      } else {
        log(
          `[Swarm] DAG task ${ready[j].id}: REJECTED (promise) — ${String(settled.reason)}`,
        );
        results.push(makeFailedResult(ready[j].id, String(settled.reason)));
        scheduler.markFailed(ready[j].id);
      }
    }
  }

  const finalCounts = scheduler.getStatusCounts();
  log(
    `[Swarm] DAG complete: ${finalCounts.completed} completed, ${finalCounts.failed} failed, ${finalCounts.blocked} blocked`,
  );
  return results;
}

// ─── Batch Dispatch ────────────────────────────────────────────────────

async function dispatchBatch(params: DispatchParams): Promise<SwarmResult[]> {
  const {
    tasks, concurrency, worker, token,
    fallbackModel, options, mailbox, log,
  } = params;
  const results: SwarmResult[] = [];

  log(
    `[Swarm] Batch mode: ${tasks.length} tasks, concurrency=${concurrency}, ${Math.ceil(tasks.length / concurrency)} batches`,
  );

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(tasks.length / concurrency);

    log(
      `[Swarm] Batch ${batchNum}/${totalBatches}: ${batch.length} workers`,
    );
    options?.onProgress?.(
      "swarm",
      `Batch ${batchNum}/${totalBatches} (${batch.length} workers)...`,
    );

    const batchResults = await Promise.allSettled(
      batch.map((task) =>
        worker.execute(task, token, fallbackModel, {
          ...options,
          mailbox,
        }),
      ),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const settled = batchResults[j];
      if (settled.status === "fulfilled") {
        log(
          `[Swarm] Batch task ${batch[j].id}: ${settled.value.success ? "OK" : "FAILED"} (${settled.value.rounds} rounds, ${settled.value.toolCalls.length} tools, ${settled.value.durationMs}ms)`,
        );
        results.push(settled.value);
      } else {
        log(
          `[Swarm] Batch task ${batch[j].id}: REJECTED (promise) — ${String(settled.reason)}`,
        );
        results.push(makeFailedResult(batch[j].id, String(settled.reason)));
      }
    }
  }

  return results;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function makeFailedResult(taskId: string, error: string): SwarmResult {
  return {
    taskId,
    text: "",
    toolCalls: [],
    model: "unknown",
    tier: "unknown",
    durationMs: 0,
    rounds: 0,
    success: false,
    error,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
  };
}
