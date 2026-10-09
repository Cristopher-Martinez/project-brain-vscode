/**
 * LM Tool: Todo List — Brain's replacement for native `manage_todo_list`.
 *
 * Part of Operation Tool Takeover (Fase 1).
 * See docs/TOOL_TAKEOVER_PLAN.md for the full strategy.
 *
 * Superpowers over native:
 * - Full logging to Output Channel
 * - Persistence to file (survives window reloads)
 * - Progress metrics (completion time tracking)
 * - Event emitter for Brain HQ integration
 * - Auto-summary on full completion
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  TodoChangeEvent,
  TodoInput,
  TodoItem,
  TodoSession,
  TrackedTodo,
  countByStatus,
  formatDuration,
} from "./lm-tools-todo-types";
import { logError } from "./logger";

export type { TodoChangeEvent } from "./lm-tools-todo-types";

// ─── BrainTodoTool ───────────────────────────────────────────────────────────

export class BrainTodoTool implements vscode.LanguageModelTool<TodoInput> {
  private session: TodoSession = {
    todos: [],
    createdAt: Date.now(),
    lastUpdated: Date.now(),
  };

  private readonly logFn: (msg: string) => void;
  private readonly workspacePath: string;
  private readonly _onDidChange = new vscode.EventEmitter<TodoChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  constructor(workspacePath: string, log: (msg: string) => void) {
    this.workspacePath = workspacePath;
    this.logFn = log;
    this.loadFromDisk();
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<TodoInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const incoming = options.input?.todoList ?? [];
    const message = this.generateProgressMarkdown(incoming);
    return { invocationMessage: message };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TodoInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { todoList } = options.input;

    try {
      const result = this.handleWrite(todoList);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(result),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`[BrainTodo] Error: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: ${msg}`),
      ]);
    }
  }

  /** Get current todo list (for Brain HQ or other consumers) */
  getTodos(): TrackedTodo[] {
    return [...this.session.todos];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // ─── Core Logic ──────────────────────────────────────────────────────────

  private handleWrite(incoming: TodoItem[]): string {
    const now = Date.now();
    const oldMap = new Map(this.session.todos.map((t) => [t.id, t]));
    const warnings: string[] = [];
    const changes: string[] = [];

    // Merge incoming with tracked metadata
    const newTodos: TrackedTodo[] = incoming.map((item) => {
      const existing = oldMap.get(item.id);

      if (!existing) {
        // New todo
        changes.push(`+ Added: "${item.title}" [${item.status}]`);
        return {
          ...item,
          createdAt: now,
          startedAt: item.status === "in-progress" ? now : undefined,
          completedAt: item.status === "completed" ? now : undefined,
        };
      }

      // Existing todo — track transitions
      const tracked: TrackedTodo = {
        ...item,
        createdAt: existing.createdAt,
        startedAt: existing.startedAt,
        completedAt: existing.completedAt,
      };

      if (existing.status !== "in-progress" && item.status === "in-progress") {
        tracked.startedAt = now;
        changes.push(`▶ Started: "${item.title}"`);
      }

      if (existing.status !== "completed" && item.status === "completed") {
        tracked.completedAt = now;
        const elapsed = formatDuration(
          now - (tracked.startedAt ?? tracked.createdAt),
        );
        changes.push(`✓ Completed: "${item.title}" (${elapsed})`);
      }

      if (existing.title !== item.title) {
        changes.push(`~ Renamed: "${existing.title}" → "${item.title}"`);
      }

      return tracked;
    });

    // Detect removed todos
    const newIds = new Set(incoming.map((t) => t.id));
    for (const old of this.session.todos) {
      if (!newIds.has(old.id)) {
        changes.push(`- Removed: "${old.title}"`);
      }
    }

    // Update session
    this.session.todos = newTodos;
    this.session.lastUpdated = now;

    // Log changes
    if (changes.length > 0) {
      this.logFn(`[BrainTodo] ${changes.join(" | ")}`);
    }

    // Warnings (same as native)
    if (newTodos.length < 3 && newTodos.length > 0) {
      warnings.push(
        "Warning: Small todo list (<3 items). Might not need tracking.",
      );
    }
    if (newTodos.length > 10) {
      warnings.push(
        "Warning: Large list (>10 items). Consider keeping it focused.",
      );
    }

    // Persist to disk
    this.saveToDisk();

    // Emit change events
    this.emitChangeEvents(oldMap, newTodos);

    // Check all-done
    const allDone =
      newTodos.length > 0 && newTodos.every((t) => t.status === "completed");
    if (allDone) {
      const summary = this.generateCompletionSummary(newTodos);
      this.logFn(`[BrainTodo] 🎉 ALL DONE! ${summary}`);
      this._onDidChange.fire({
        type: "all-done",
        todos: newTodos,
        summary,
      });
    }

    // Build result
    const counts = countByStatus(newTodos);
    const parts: string[] = [];

    parts.push(
      `Todo list updated: ${counts.completed}/${newTodos.length} completed`,
    );

    if (warnings.length > 0) {
      parts.push(warnings.join("\n"));
    }

    // Directive: tell the model to keep going if there are pending tasks
    const pending = newTodos.filter((t) => t.status !== "completed");
    if (pending.length > 0) {
      parts.push("\n--- PENDING TASKS ---");
      for (const p of pending) {
        const marker =
          p.status === "in-progress" ? "[IN PROGRESS]" : "[NOT STARTED]";
        parts.push(`${marker} #${p.id}: ${p.title}`);
      }
      parts.push(
        `\nYou have ${pending.length} task(s) remaining. Continue working — mark each as in-progress before starting, then completed when done. Do NOT stop until all tasks are completed.`,
      );
    } else if (newTodos.length > 0) {
      parts.push(
        "\n🎉 ALL TASKS COMPLETED. You may now summarize results to the user.",
      );
    }

    return parts.join("\n");
  }

  // ─── Progress Messages ───────────────────────────────────────────────────

  private generateProgressMarkdown(
    incoming: TodoItem[],
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;

    if (incoming.length === 0) {
      md.appendMarkdown("📋 No todos");
      return md;
    }

    // Build checkbox list
    for (const item of incoming) {
      const icon = this.statusIcon(item.status);
      const style =
        item.status === "completed"
          ? "~~"
          : item.status === "in-progress"
            ? "**"
            : "";
      md.appendMarkdown(`${icon} ${style}${item.title}${style}  \n`);
    }

    // Progress bar
    const done = incoming.filter((t) => t.status === "completed").length;
    const pct = Math.round((done / incoming.length) * 100);
    md.appendMarkdown(`\n_${done}/${incoming.length} (${pct}%)_`);

    return md;
  }

  private statusIcon(status: TodoItem["status"]): string {
    switch (status) {
      case "completed":
        return "✅";
      case "in-progress":
        return "🔄";
      default:
        return "⬜";
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private get persistPath(): string {
    return path.join(
      this.workspacePath,
      "docs",
      "memory",
      "sessions",
      "active-todos.json",
    );
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(this.session, null, 2),
        "utf-8",
      );
    } catch (err) {
      logError(
        `[BrainTodo] Failed to save: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, "utf-8");
        const loaded = JSON.parse(raw) as TodoSession;
        if (loaded.todos && Array.isArray(loaded.todos)) {
          this.session = loaded;
          this.logFn(
            `[BrainTodo] Restored ${loaded.todos.length} todos from disk`,
          );
        }
      }
    } catch (err) {
      logError(
        `[BrainTodo] Failed to load: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private emitChangeEvents(
    oldMap: Map<number, TrackedTodo>,
    newTodos: TrackedTodo[],
  ): void {
    for (const todo of newTodos) {
      const old = oldMap.get(todo.id);
      if (!old) {
        this._onDidChange.fire({
          type: "created",
          todos: newTodos,
          changed: todo,
        });
      } else if (
        old.status !== "in-progress" &&
        todo.status === "in-progress"
      ) {
        this._onDidChange.fire({
          type: "started",
          todos: newTodos,
          changed: todo,
        });
      } else if (old.status !== "completed" && todo.status === "completed") {
        this._onDidChange.fire({
          type: "completed",
          todos: newTodos,
          changed: todo,
        });
      } else if (old.title !== todo.title || old.status !== todo.status) {
        this._onDidChange.fire({
          type: "updated",
          todos: newTodos,
          changed: todo,
        });
      }
    }
  }

  private generateCompletionSummary(todos: TrackedTodo[]): string {
    const totalMs = Date.now() - this.session.createdAt;
    const avgMs =
      todos.reduce((sum, t) => {
        const duration = (t.completedAt ?? 0) - (t.startedAt ?? t.createdAt);
        return sum + Math.max(0, duration);
      }, 0) / todos.length;

    return [
      `${todos.length} tasks completed`,
      `Total: ${formatDuration(totalMs)}`,
      `Avg/task: ${formatDuration(avgMs)}`,
    ].join(" | ");
  }
}
