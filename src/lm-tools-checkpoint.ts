/**
 * Checkpoint LM Tool — STRAT-1
 *
 * Allows agents to create/restore/list/delete named checkpoints
 * within their isolated session. Like a "save game" for code.
 * Sub-tool registered via Toolbox.register("checkpoint", ...).
 */

import * as vscode from "vscode";
import { getIsolationInfo } from "./fork-queries";
import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
} from "./checkpoint";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CheckpointInput {
  /** Action to perform. */
  action: "create" | "restore" | "list" | "delete";
  /** Checkpoint name (required for create/restore/delete). */
  name?: string;
  /** Session ID to find the worktree. */
  sessionId: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class CheckpointTool implements vscode.LanguageModelTool<CheckpointInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CheckpointInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action, name, sessionId } = options.input;
    this.log(
      `[CheckpointTool] action=${action} name=${name ?? "(none)"} session=${sessionId}`,
    );

    // Find the fork for this session
    const info = getIsolationInfo(sessionId);
    if (!info?.forkPath) {
      return this.result(
        `❌ No hay fork activo para sesión "${sessionId}". ` +
          `Checkpoints solo funcionan en sesiones con fork isolation.`,
      );
    }
    const wt = info.forkPath;

    switch (action) {
      case "create":
        return this.handleCreate(wt, name);
      case "restore":
        return this.handleRestore(wt, name);
      case "list":
        return this.handleList(wt);
      case "delete":
        return this.handleDelete(wt, name);
      default:
        return this.result(
          `❌ Acción desconocida: "${action}". Usa: create, restore, list, delete.`,
        );
    }
  }

  private async handleCreate(
    wt: string,
    name: string | undefined,
  ): Promise<vscode.LanguageModelToolResult> {
    if (!name) {
      return this.result(
        "❌ Se requiere un nombre para el checkpoint. Ej: `before-refactor`",
      );
    }
    const result = await createCheckpoint(wt, name);
    return this.result(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
    );
  }

  private async handleRestore(
    wt: string,
    name: string | undefined,
  ): Promise<vscode.LanguageModelToolResult> {
    if (!name) {
      const checkpoints = await listCheckpoints(wt);
      const available =
        checkpoints.map((c) => c.name).join(", ") || "(ninguno)";
      return this.result(
        `❌ Se requiere nombre del checkpoint a restaurar. Disponibles: ${available}`,
      );
    }
    const result = await restoreCheckpoint(wt, name);
    return this.result(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
    );
  }

  private async handleList(
    wt: string,
  ): Promise<vscode.LanguageModelToolResult> {
    const checkpoints = await listCheckpoints(wt);
    if (checkpoints.length === 0) {
      return this.result("📋 No hay checkpoints guardados en este worktree.");
    }
    const lines = checkpoints.map(
      (c) => `• **${c.name}** (stash@{${c.stashIndex}}) — ${c.createdAt}`,
    );
    return this.result(
      `📋 **Checkpoints (${checkpoints.length}):**\n${lines.join("\n")}`,
    );
  }

  private async handleDelete(
    wt: string,
    name: string | undefined,
  ): Promise<vscode.LanguageModelToolResult> {
    if (!name) {
      return this.result("❌ Se requiere nombre del checkpoint a eliminar.");
    }
    const result = await deleteCheckpoint(wt, name);
    return this.result(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
    );
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}
