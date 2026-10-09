// ============================================================
// SOURCE MAP — task-dag.ts
// Dependency-aware task scheduler for Swarm execution
// ============================================================
// L1-10:       Source map
// L12-40:      Types (TaskNode, DAGValidation, DAGExecution)
// L42-90:      validateDAG — cycle detection + missing deps
// L92-180:     DAGScheduler — event-driven dependency resolution
// ============================================================

import type { SwarmTask } from "./swarm-worker";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending" // Waiting for dependencies
  | "ready" // Dependencies met, can be dispatched
  | "running" // Currently executing
  | "completed" // Finished successfully
  | "failed" // Execution failed
  | "blocked"; // Dependency failed — cannot run

interface TaskNode {
  task: SwarmTask;
  status: TaskStatus;
  dependsOn: Set<string>;
  dependedBy: Set<string>;
}

export interface DAGValidationResult {
  valid: boolean;
  /** Detected cycles (list of taskId chains) */
  cycles: string[][];
  /** Missing dependency references */
  missingDeps: { taskId: string; missingDep: string }[];
  /** Tasks with no dependencies (roots) */
  roots: string[];
  /** Total tasks */
  totalTasks: number;
}

export interface DAGTaskEvent {
  taskId: string;
  status: TaskStatus;
  /** Tasks that became ready because of this status change */
  nowReady: string[];
  /** Tasks that became blocked because of this failure */
  nowBlocked: string[];
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a set of tasks for DAG correctness.
 * Checks: no cycles, no missing dependencies, at least one root.
 */
export function validateDAG(tasks: SwarmTask[]): DAGValidationResult {
  const taskIds = new Set(tasks.map((t) => t.id));
  const missingDeps: { taskId: string; missingDep: string }[] = [];
  const roots: string[] = [];

  // Check for missing dependencies
  for (const task of tasks) {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      roots.push(task.id);
    } else {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          missingDeps.push({ taskId: task.id, missingDep: dep });
        }
      }
    }
  }

  // Cycle detection via DFS
  const cycles = detectCycles(tasks);

  const result = {
    valid: cycles.length === 0 && missingDeps.length === 0 && roots.length > 0,
    cycles,
    missingDeps,
    roots,
    totalTasks: tasks.length,
  };

  // Debug output (goes to console since validateDAG is a standalone function)
  if (!result.valid) {
    console.log(
      `[DAG:validate] INVALID: ${cycles.length} cycles, ${missingDeps.length} missing deps, ${roots.length} roots`,
    );
    if (cycles.length > 0)
      console.log(`[DAG:validate] Cycles: ${JSON.stringify(cycles)}`);
    if (missingDeps.length > 0)
      console.log(
        `[DAG:validate] Missing deps: ${JSON.stringify(missingDeps)}`,
      );
  }

  return result;
}

/**
 * Detect cycles in the task dependency graph using DFS.
 * Returns arrays of taskId chains that form cycles.
 */
function detectCycles(tasks: SwarmTask[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    adjacency.set(task.id, task.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart).concat(node));
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = adjacency.get(node) ?? [];
    for (const dep of deps) {
      dfs(dep, [...path]);
    }

    inStack.delete(node);
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  return cycles;
}

// ─── DAG Scheduler ──────────────────────────────────────────────────────────

/**
 * Event-driven DAG scheduler for swarm tasks.
 *
 * Instead of dispatching all tasks at once, the scheduler:
 * 1. Starts with root tasks (no dependencies)
 * 2. When a task completes → checks which dependents are now unblocked
 * 3. Returns newly-ready tasks for immediate dispatch
 * 4. If a task fails → marks all dependents as "blocked"
 *
 * Usage:
 * ```typescript
 * const scheduler = new DAGScheduler(tasks);
 * let ready = scheduler.getReady(4); // get up to 4 ready tasks
 * // ...dispatch and execute...
 * const event = scheduler.markCompleted('task-1');
 * ready = scheduler.getReady(4); // get newly unblocked tasks
 * ```
 */
export class DAGScheduler {
  private nodes: Map<string, TaskNode> = new Map();
  private log: (msg: string) => void;

  constructor(tasks: SwarmTask[], log?: (msg: string) => void) {
    this.log = log ?? (() => {});

    // Build the graph
    for (const task of tasks) {
      this.nodes.set(task.id, {
        task,
        status: "pending",
        dependsOn: new Set(task.dependsOn ?? []),
        dependedBy: new Set(),
      });
    }

    // Build reverse edges (who depends on me?)
    for (const [id, node] of this.nodes) {
      for (const dep of node.dependsOn) {
        const depNode = this.nodes.get(dep);
        if (depNode) {
          depNode.dependedBy.add(id);
        }
      }
    }

    // Mark root tasks as ready
    for (const [id, node] of this.nodes) {
      if (node.dependsOn.size === 0) {
        node.status = "ready";
        this.log(`[DAG] Root task: ${id} → ready`);
      }
    }

    this.log(
      `[DAG] Initialized: ${tasks.length} tasks, ${this.getReadyCount()} ready (roots), deps: ${
        [...this.nodes.entries()]
          .filter(([, n]) => n.dependsOn.size > 0)
          .map(([id, n]) => `${id}←[${[...n.dependsOn].join(",")}]`)
          .join(" | ") || "none"
      }`,
    );
  }

  /**
   * Get up to `limit` tasks that are ready to execute.
   * Ordered by priority (higher first), then by ID for determinism.
   */
  getReady(limit: number): SwarmTask[] {
    const ready = [...this.nodes.values()]
      .filter((n) => n.status === "ready")
      .sort((a, b) => {
        const pa = a.task.priority ?? 0;
        const pb = b.task.priority ?? 0;
        if (pa !== pb) return pb - pa; // higher priority first
        return a.task.id.localeCompare(b.task.id); // stable sort
      })
      .slice(0, limit);

    // Mark as running
    for (const node of ready) {
      node.status = "running";
      this.log(`[DAG] ${node.task.id}: ready → running`);
    }

    this.log(
      `[DAG] getReady(${limit}): dispatching ${ready.length} tasks: [${ready.map((n) => n.task.id).join(", ")}]`,
    );

    return ready.map((n) => n.task);
  }

  /**
   * Mark a task as completed. Returns event with newly-ready tasks.
   */
  markCompleted(taskId: string): DAGTaskEvent {
    const node = this.nodes.get(taskId);
    if (!node) {
      this.log(
        `[DAG] markCompleted(${taskId}): WARN — task not found in graph`,
      );
      return { taskId, status: "completed", nowReady: [], nowBlocked: [] };
    }

    const prevStatus = node.status;
    node.status = "completed";
    this.log(`[DAG] ${taskId}: ${prevStatus} → completed`);
    const nowReady: string[] = [];

    // Check dependents — are they now unblocked?
    for (const depId of node.dependedBy) {
      const depNode = this.nodes.get(depId);
      if (!depNode || depNode.status !== "pending") continue;

      // Check if ALL dependencies are completed
      const allDepsCompleted = [...depNode.dependsOn].every((d) => {
        const dNode = this.nodes.get(d);
        return dNode?.status === "completed";
      });

      if (allDepsCompleted) {
        depNode.status = "ready";
        nowReady.push(depId);
      }
    }

    this.log(
      `[DAG] ${taskId} completed → ${nowReady.length} tasks unblocked: [${nowReady.join(", ")}]`,
    );

    return { taskId, status: "completed", nowReady, nowBlocked: [] };
  }

  /**
   * Mark a task as failed. Cascades "blocked" to all dependents.
   */
  markFailed(taskId: string): DAGTaskEvent {
    const node = this.nodes.get(taskId);
    if (!node) {
      this.log(`[DAG] markFailed(${taskId}): WARN — task not found in graph`);
      return { taskId, status: "failed", nowReady: [], nowBlocked: [] };
    }

    const prevStatus = node.status;
    node.status = "failed";
    this.log(`[DAG] ${taskId}: ${prevStatus} → FAILED`);
    const nowBlocked: string[] = [];

    // Cascade: mark all transitive dependents as blocked
    const queue = [...node.dependedBy];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);

      const depNode = this.nodes.get(depId);
      if (!depNode) continue;

      if (depNode.status === "pending" || depNode.status === "ready") {
        depNode.status = "blocked";
        nowBlocked.push(depId);

        // Cascade further
        for (const transitive of depNode.dependedBy) {
          queue.push(transitive);
        }
      }
    }

    this.log(
      `[DAG] ${taskId} FAILED → ${nowBlocked.length} tasks blocked: [${nowBlocked.join(", ")}]`,
    );

    return { taskId, status: "failed", nowReady: [], nowBlocked };
  }

  /**
   * Check if all tasks are in a terminal state (completed, failed, or blocked).
   */
  isComplete(): boolean {
    const complete = [...this.nodes.values()].every(
      (n) =>
        n.status === "completed" ||
        n.status === "failed" ||
        n.status === "blocked",
    );
    const counts = this.getStatusCounts();
    this.log(
      `[DAG] isComplete=${complete} (completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}, pending=${counts.pending}, ready=${counts.ready}, running=${counts.running})`,
    );
    return complete;
  }

  /**
   * Get count of tasks in each status.
   */
  getStatusCounts(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    };

    for (const node of this.nodes.values()) {
      counts[node.status]++;
    }

    return counts;
  }

  /**
   * Get the number of ready tasks.
   */
  getReadyCount(): number {
    return [...this.nodes.values()].filter((n) => n.status === "ready").length;
  }

  /**
   * Get status of a specific task.
   */
  getStatus(taskId: string): TaskStatus | undefined {
    return this.nodes.get(taskId)?.status;
  }

  /**
   * Get all tasks with their current status (for UI display).
   */
  getAllStatuses(): {
    taskId: string;
    status: TaskStatus;
    dependsOn: string[];
  }[] {
    return [...this.nodes.entries()].map(([id, node]) => ({
      taskId: id,
      status: node.status,
      dependsOn: [...node.dependsOn],
    }));
  }

  /**
   * Check if the task graph has dependencies (vs flat/parallel).
   */
  hasDependencies(): boolean {
    return [...this.nodes.values()].some((n) => n.dependsOn.size > 0);
  }
}
