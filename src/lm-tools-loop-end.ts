/**
 * LoopEndTool — Ends an active feedback loop session.
 *
 * Extracted from `lm-tools-loop.ts` to keep file sizes manageable.
 * MULTI-SESSION: requires sessionId.
 */

import * as vscode from "vscode";
import { buildSquashDigest } from "./commit-session-ops";
import {
  hasActiveLoop,
  isLoopSessionOpen,
  loopEnd,
  setLoopProtocolMonitor,
} from "./loop-engine";
import {
  activeLoopGoals,
  loopRoundCounters,
} from "./lm-tools-loop";
import { recordLoopProtocolViolation } from "./loop-protocol-monitor";

// ——— Types ————————————————————————————————————————————
interface LoopEndInput {
  sessionId?: string;
}

// ——— LoopEndTool —————————————————————————————————————
export class LoopEndTool implements vscode.LanguageModelTool<LoopEndInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LoopEndInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sessionId = options.input?.sessionId;
    if (!sessionId) {
      this.log("[LoopEnd] no sessionId — caller is not in a loop session");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "NO_ACTIVE_LOOP — No estás dentro de un loop. " +
            "Responde directamente al usuario con texto normal. " +
            "NO vuelvas a llamar loop, loopAwaitInput ni loopEnd.",
        ),
      ]);
    }

    if (isLoopSessionOpen(sessionId)) {
      const snapshot = recordLoopProtocolViolation(sessionId, {
        code: "LOOP_END_BLOCKED",
        severity: "warn",
        message:
          "loopEnd fue invocado mientras el gate seguía abierto y el usuario no había confirmado cierre.",
      });
      if (snapshot) {
        setLoopProtocolMonitor(sessionId, snapshot);
      }
      this.log(`[LoopEnd] BLOCKED — session ${sessionId} gate still OPEN`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          [
            "\uD83D\uDD12 **LOOP BLOQUEADO** — No puedes cerrar el loop.",
            "El usuario NO ha hecho click en 'End Loop' en Brain HQ.",
            "Continúa trabajando o espera instrucciones del usuario.",
          ].join("\n"),
        ),
      ]);
    }

    if (!hasActiveLoop(sessionId)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("ℹ️ No hay loop activo para cerrar."),
      ]);
    }

    const rounds = loopRoundCounters.get(sessionId) || 0;
    loopEnd(sessionId);
    activeLoopGoals.delete(sessionId);
    loopRoundCounters.delete(sessionId);

    // Auto-squash digest on loop end
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    let squash = "";
    try {
      squash = buildSquashDigest(cwd, sessionId);
    } catch {
      /* ok */
    }
    const squashSection =
      squash && !squash.includes("No commits found")
        ? `\n\n---\n**Squash Digest:**\n\n${squash}`
        : "";

    this.log(`[LoopEnd] sessionId=${sessionId} ended (${rounds} rounds)`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        [
          `Loop finalizado`,
          "",
          `Iteraciones completadas: ${rounds || "\u2014"}`,
          "",
          "Puedes iniciar otro loop cuando quieras.",
        ].join("\n") + squashSection,
      ),
    ]);
  }
}
