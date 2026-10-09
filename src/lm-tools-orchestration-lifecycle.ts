/**
 * Orchestration LM Tools — Lifecycle management
 *
 * Contains: OrchEndSessionTool, OrchAwaitInputTool
 */

import * as vscode from "vscode";
import { clearOrchConfig, isOrchSessionOpen } from "./orchestration-config";
import { OrchestrationManager } from "./orchestration-manager";
import {
  getOrchState,
  orchSessionEnd,
  orchWaitForFeedback,
} from "./orchestration-state";

interface OrchEndSessionInput {
  sessionId: string;
}

export class OrchEndSessionTool implements vscode.LanguageModelTool<OrchEndSessionInput> {
  constructor(
    private orchestrationManager: OrchestrationManager,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OrchEndSessionInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sessionId = options.input.sessionId;

    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⛔ Error: sessionId es requerido para cerrar la sesión.",
        ),
      ]);
    }

    // —— MECHANICAL GATE — like isFinalizeReady() ——
    if (isOrchSessionOpen(sessionId)) {
      // TODO: Update to check by sessionId
      this.log(
        `[OrchEndSession] BLOCKED — session gate is still OPEN for ${sessionId}. User must click End Session in HQ.`,
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          [
            "🔒 **SESIÓN BLOQUEADA** — No puedes cerrar la sesión de orquestación.",
            "",
            "El usuario NO ha hecho click en 'End Session' en Brain HQ.",
            "Mientras el gate esté abierto, esta operación está **mecánicamente prohibida**.",
            "",
            "Continúa trabajando o espera instrucciones del usuario.",
          ].join("\n"),
        ),
      ]);
    }

    const activeOrchSession = this.orchestrationManager.getSession(sessionId);

    // —— Gate is open — proceed with cleanup ——
    if (!activeOrchSession) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `ℹ️ No hay sesión de orquestación activa con ID ${sessionId} para cerrar.`,
        ),
      ]);
    }

    try {
      const summary = await activeOrchSession.end();
      orchSessionEnd(sessionId, summary || "Session ended"); // TODO: Update to pass sessionId
      this.orchestrationManager.removeSession(sessionId);
      clearOrchConfig(sessionId); // TODO: Update to pass sessionId

      this.log(`[OrchEndSession] Session ${sessionId} ended cleanly.`);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          [
            "✅ **Sesión de orquestación finalizada**",
            "",
            "**Resumen:**",
            summary || "(sin resumen disponible)",
            "",
            "Configuración limpiada. Puedes iniciar otra sesión desde Brain HQ.",
          ].join("\n"),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[OrchEndSession] Error ending session ${sessionId}: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`⛔ Error al cerrar sesión: ${msg}`),
      ]);
    }
  }
}

interface OrchAwaitInputParams {
  sessionId: string;
  synthesis?: string;
}

export class OrchAwaitInputTool implements vscode.LanguageModelTool<OrchAwaitInputParams> {
  constructor(
    private orchestrationManager: OrchestrationManager,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OrchAwaitInputParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sessionId = options.input.sessionId;

    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⛔ Error: sessionId es requerido para esperar feedback.",
        ),
      ]);
    }

    const activeOrchSession = this.orchestrationManager.getSession(sessionId);

    if (!activeOrchSession) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⚠️ No hay sesión de orquestación activa con ID ${sessionId}. No se puede esperar feedback.`,
        ),
      ]);
    }

    let synthesis = options.input?.synthesis;

    // Safety net: if agent didn't provide synthesis, build a REAL one from worker outputs
    if (!synthesis) {
      this.log(
        `[OrchAwaitInput] WARNING: Agent called without synthesis param for ${sessionId} — building fallback from workerLogs`,
      );
      const state = getOrchState(sessionId); // TODO: Update to pass sessionId
      if (state) {
        const lastRound =
          state.completedRounds[state.completedRounds.length - 1] ??
          state.currentRound;
        if (lastRound) {
          const synthParts: string[] = [];
          synthParts.push(
            `**Ronda ${lastRound.roundNumber} completada** (${lastRound.workers.length} workers)\n`,
          );

          for (const w of lastRound.workers) {
            const status = w.success ? "✅" : w.error ? "❌" : "⏳";
            const fullLog =
              state.workerLogs[w.taskId] || w.message || "(sin output)";
            // Use up to 800 chars of REAL worker output for synthesis
            const preview =
              fullLog.length > 800
                ? fullLog.substring(0, 800) + "..."
                : fullLog;
            synthParts.push(`#### ${status} ${w.agentName} (${w.taskId})`);
            synthParts.push(preview);
            synthParts.push("");
          }

          const successCount = lastRound.workers.filter(
            (w) => w.success,
          ).length;
          const failCount = lastRound.workers.filter((w) => w.error).length;
          synthParts.push(`---`);
          synthParts.push(
            `📊 **Resumen:** ${successCount}/${lastRound.workers.length} exitosos${failCount > 0 ? `, ${failCount} fallidos` : ""}`,
          );
          synthParts.push(
            `\n_Síntesis construida desde output de workers — revisa resultados y envía feedback o instrucciones para la siguiente ronda._`,
          );

          synthesis = synthParts.join("\n");
        } else {
          synthesis =
            "⏳ Ronda en progreso — el agente solicitó feedback antes de tener resultados.";
        }
      } else {
        synthesis = "⏳ Esperando feedback...";
      }
    }
    this.log(
      `[OrchAwaitInput] Posting synthesis to HQ for ${sessionId}, waiting for user feedback...`,
    );

    // This blocks until user sends feedback from HQ (or session ends)
    const feedback = await orchWaitForFeedback(sessionId, synthesis); // TODO: Update to pass sessionId

    if (feedback === "__SESSION_ENDED__") {
      this.log(
        `[OrchAwaitInput] Session ${sessionId} ended while waiting for feedback.`,
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          [
            "🛑 **Sesión finalizada** — El usuario cerró la sesión mientras esperabas feedback.",
            "",
            "No hay más trabajo que hacer. Llama a `orchEndSession` para limpiar.",
          ].join("\n"),
        ),
      ]);
    }

    this.log(
      `[OrchAwaitInput] Feedback received for ${sessionId}: ${feedback.substring(0, 100)}...`,
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        [
          "📬 **Feedback del usuario recibido:**",
          "",
          feedback,
          "",
          "---",
          "**INSTRUCCIÓN**: Incorpora este feedback y llama a `orchestrate` nuevamente",
          "con las instrucciones actualizadas del usuario. El ciclo continúa hasta que",
          "el usuario cierre la sesión.",
        ].join("\n"),
      ),
    ]);
  }
}
