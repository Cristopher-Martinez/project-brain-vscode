/**
 * Shadow Test LM Tool — STRAT-6
 *
 * Lets agents run commands "as HEAD" without leaving their isolated worktree.
 * Creates a temporary merge of HEAD + agent changes, runs the command,
 * captures output, and auto-cleans up. The agent's worktree is NEVER touched.
 *
 * Sub-tool registered via Toolbox.register("shadowTest", ...).
 *
 * Usage examples:
 *   shadowTest({ action: "run", command: "npx tsc --noEmit", sessionId })
 *   shadowTest({ action: "checkConflicts", sessionId })
 */

import * as vscode from "vscode";
import { getIsolationInfo } from "./fork-queries";
import {
  checkMergeConflicts,
  runShadowTest,
  acquireShadowSlot,
  releaseShadowSlot,
  type ShadowTestResult,
} from "./shadow-worktree";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShadowTestInput {
  /** Action: "run" to execute a command, "checkConflicts" to just check. */
  action: "run" | "checkConflicts";
  /** Command to run (required for action="run"). */
  command?: string;
  /** Timeout in ms (default: 60000). */
  timeout?: number;
  /** Session ID to find the worktree. */
  sessionId: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ShadowTestTool implements vscode.LanguageModelTool<ShadowTestInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ShadowTestInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action, sessionId } = options.input;
    this.log(`[ShadowTestTool] action=${action} session=${sessionId}`);

    const info = getIsolationInfo(sessionId);
    if (!info?.forkPath) {
      return this.result(
        "❌ No hay fork activo para esta sesión. Shadow test requiere fork isolation.",
      );
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      return this.result("❌ No se encontró workspace root.");
    }

    switch (action) {
      case "checkConflicts":
        return this.handleCheckConflicts(
          wsRoot,
          info.branchName,
          info.originalBranch,
        );
      case "run":
        return this.handleRun(
          options.input,
          wsRoot,
          info.branchName,
          info.originalBranch,
        );
      default:
        return this.result(
          `❌ Acción desconocida: "${action}". Usa: run, checkConflicts.`,
        );
    }
  }

  private async handleCheckConflicts(
    repoRoot: string,
    agentBranch: string,
    originalBranch: string,
  ): Promise<vscode.LanguageModelToolResult> {
    const { hasConflicts, conflictFiles } = await checkMergeConflicts(
      repoRoot,
      agentBranch,
      originalBranch,
    );

    if (!hasConflicts) {
      return this.result(
        `✅ **No hay conflictos.** Tus cambios en \`${agentBranch}\` se pueden mergear limpiamente con \`${originalBranch}\`.`,
      );
    }

    return this.result(
      [
        `⚠️ **Conflictos detectados** al simular merge con \`${originalBranch}\`:`,
        ...conflictFiles.map((f) => `  • ${f}`),
        "",
        "Resuelve estos archivos antes de mergear o usa `checkpoint` para guardar tu estado actual.",
      ].join("\n"),
    );
  }

  private async handleRun(
    input: ShadowTestInput,
    repoRoot: string,
    agentBranch: string,
    originalBranch: string,
  ): Promise<vscode.LanguageModelToolResult> {
    if (!input.command) {
      return this.result(
        "❌ Se requiere `command` para ejecutar. Ej: `npx tsc --noEmit`, `npm test`.",
      );
    }

    this.log(`[ShadowTestTool] Running shadow test: "${input.command}"`);

    // Concurrent guard — one shadow test per session
    if (!acquireShadowSlot(input.sessionId)) {
      return this.result(
        "⏳ Ya hay un shadow test ejecutándose para esta sesión. Espera a que termine.",
      );
    }

    try {
      const result = await runShadowTest(
        repoRoot,
        agentBranch,
        originalBranch,
        {
          command: input.command,
          timeout: input.timeout,
        },
      );

      return this.result(this.formatResult(result, input.command));
    } finally {
      releaseShadowSlot(input.sessionId);
    }
  }

  private formatResult(result: ShadowTestResult, command: string): string {
    const parts: string[] = [];

    if (result.hasConflicts) {
      parts.push(
        "⚠️ **Merge conflicts** — no se pudo ejecutar el comando.",
        `Archivos en conflicto: ${result.conflictFiles.join(", ")}`,
      );
      return parts.join("\n");
    }

    const icon = result.success ? "✅" : "❌";
    parts.push(
      `${icon} **Shadow Test: \`${command}\`** — ${result.success ? "PASÓ" : "FALLÓ"} (${result.durationMs}ms)`,
    );

    if (result.stdout.trim()) {
      const stdout = result.stdout.trim().substring(0, 3000);
      parts.push("", "**stdout:**", "```", stdout, "```");
    }

    if (result.stderr.trim()) {
      const stderr = result.stderr.trim().substring(0, 2000);
      parts.push("", "**stderr:**", "```", stderr, "```");
    }

    if (!result.stdout.trim() && !result.stderr.trim()) {
      parts.push("", "(sin output)");
    }

    return parts.join("\n");
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}
