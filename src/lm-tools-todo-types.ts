/**
 * Types for BrainTodoTool — separated for clean imports.
 *
 * Part of Operation Tool Takeover (Fase 1).
 */

// ——— Types ———————————————————————————————————————————————————

export type TodoStatus = "not-started" | "in-progress" | "completed";

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

export interface TrackedTodo extends TodoItem {
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TodoSession {
  todos: TrackedTodo[];
  createdAt: number;
  lastUpdated: number;
}

export interface TodoInput {
  todoList: TodoItem[];
}

export interface TodoChangeEvent {
  type: "created" | "started" | "completed" | "updated" | "all-done";
  todos: TrackedTodo[];
  changed?: TrackedTodo;
  summary?: string;
}

// ——— Helpers ————————————————————————————————————————————————

export function countByStatus(todos: TrackedTodo[]): {
  "not-started": number;
  "in-progress": number;
  completed: number;
} {
  return {
    "not-started": todos.filter((t) => t.status === "not-started").length,
    "in-progress": todos.filter((t) => t.status === "in-progress").length,
    completed: todos.filter((t) => t.status === "completed").length,
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
