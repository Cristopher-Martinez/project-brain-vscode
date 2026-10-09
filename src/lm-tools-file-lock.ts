/**
 * File Lock LM Tool — STRAT-4
 *
 * Exposes file-level soft locking as a toolbox sub-tool.
 * Agents call this to register intent to edit a file.
 * Other sessions get warnings when they try to edit the same file.
 *
 * Sub-tool registered via Toolbox.register("fileLock", ...).
 */

import * as vscode from "vscode";
import {
  acquireLock,
  releaseLock,
  releaseAllLocks,
  checkConflicts,
  getLockedFiles,
  type FileLockConflict,
} from "./file-lock-registry";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileLockInput {
  /** Action: "lock" | "unlock" | "unlockAll" | "check" | "list" */
  action: "lock" | "unlock" | "unlockAll" | "check" | "list";
  /** File path (relative to repo root). Required for lock/unlock/check. */
  file?: string;
  /** Optional reason for locking (e.g., "refactoring handler"). */
  reason?: string;
  /** Session ID. */
  sessionId: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class FileLockTool implements vscode.LanguageModelTool<FileLockInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FileLockInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action, sessionId } = options.input;
    this.log(`[FileLockTool] action=${action} session=${sessionId}`);

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      return this.result("❌ No se encontró workspace root.");
    }

    switch (action) {
      case "lock":
        return this.handleLock(options.input, wsRoot);
      case "unlock":
        return this.handleUnlock(options.input, wsRoot);
      case "unlockAll":
        return this.handleUnlockAll(sessionId, wsRoot);
      case "check":
        return this.handleCheck(options.input, wsRoot);
      case "list":
        return this.handleList(sessionId, wsRoot);
      default:
        return this.result(
          `❌ Acción desconocida: "${action}". Usa: lock, unlock, unlockAll, check, list.`,
        );
    }
  }

  private handleLock(
    input: FileLockInput,
    repoRoot: string,
  ): vscode.LanguageModelToolResult {
    if (!input.file) {
      return this.result("❌ Se requiere `file` para adquirir lock.");
    }

    const conflict = acquireLock(
      repoRoot,
      input.sessionId,
      input.file,
      input.reason,
    );

    if (conflict) {
      return this.result(this.formatConflictWarning(conflict));
    }

    this.log(`[FileLockTool] Lock acquired: ${input.file}`);
    return this.result(
      `🔒 Lock adquirido: \`${input.file}\`` +
        (input.reason ? ` — ${input.reason}` : ""),
    );
  }

  private handleUnlock(
    input: FileLockInput,
    repoRoot: string,
  ): vscode.LanguageModelToolResult {
    if (!input.file) {
      return this.result("❌ Se requiere `file` para liberar lock.");
    }

    releaseLock(repoRoot, input.sessionId, input.file);
    this.log(`[FileLockTool] Lock released: ${input.file}`);
    return this.result(`🔓 Lock liberado: \`${input.file}\``);
  }

  private handleUnlockAll(
    sessionId: string,
    repoRoot: string,
  ): vscode.LanguageModelToolResult {
    const count = releaseAllLocks(repoRoot, sessionId);
    this.log(`[FileLockTool] All locks released: ${count} total`);
    return this.result(
      count > 0
        ? `🔓 ${count} lock(s) liberados para esta sesión.`
        : "ℹ️ No había locks activos para esta sesión.",
    );
  }

  private handleCheck(
    input: FileLockInput,
    repoRoot: string,
  ): vscode.LanguageModelToolResult {
    if (!input.file) {
      return this.result("❌ Se requiere `file` para verificar conflictos.");
    }

    const conflict = checkConflicts(repoRoot, input.sessionId, input.file);
    if (!conflict) {
      return this.result(
        `✅ \`${input.file}\` libre — nadie más lo está editando.`,
      );
    }

    return this.result(this.formatConflictWarning(conflict));
  }

  private handleList(
    sessionId: string,
    repoRoot: string,
  ): vscode.LanguageModelToolResult {
    const locks = getLockedFiles(repoRoot, sessionId);
    if (locks.length === 0) {
      return this.result("ℹ️ No hay archivos bloqueados por esta sesión.");
    }

    const lines = locks.map((l) => {
      const age = Math.round((Date.now() - l.acquiredAt) / 60_000);
      return `  🔒 ${l.file} — ${age}min` + (l.reason ? ` (${l.reason})` : "");
    });

    return this.result(
      [`📋 **Archivos bloqueados por esta sesión:**`, ...lines].join("\n"),
    );
  }

  private formatConflictWarning(conflict: FileLockConflict): string {
    const holders = conflict.holders.map((h) => h.substring(0, 8)).join(", ");
    const age = Math.round((Date.now() - conflict.earliestLock) / 60_000);
    return [
      `⚠️ **CONFLICTO DE EDICIÓN**: \`${conflict.file}\``,
      `   Sesiones que también lo editan: ${holders}`,
      `   Lock más antiguo: hace ${age}min`,
      `   Puedes continuar, pero coordina antes de mergear.`,
    ].join("\n");
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}
