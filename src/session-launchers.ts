import * as path from "path";
import * as vscode from "vscode";
import { createFork } from "./fork-isolation";
import { getKnownForkIssuesHint, getForkLimitations } from "./fork-helpers";
import { log, logError } from "./logger";
import { getOrchConfig } from "./orchestration-config";

/**
 * Register session launcher commands (orchestration + loop).
 */
export function registerSessionLaunchers(
  context: vscode.ExtensionContext,
): void {
  // ─── Launch Orchestration Session (spawn new Chat with config) ──────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.launchOrchSession",
      async (sessionId?: string) => {
        if (!sessionId) {
          vscode.window.showWarningMessage(
            "No orchestration sessionId provided. Configure team in Brain HQ first.",
          );
          return;
        }
        const config = getOrchConfig(sessionId);
        if (!config) {
          vscode.window.showWarningMessage(
            "No orchestration config prepared. Configure team in Brain HQ first.",
          );
          return;
        }

        // Build the orchestration prompt to auto-submit in the new session
        const teamDesc = config.team
          .map(
            (t) => `- ${t.agent.name} (model: ${t.modelId}, tier: ${t.tier})`,
          )
          .join("\n");

        const orchModelHint = config.orchestratorModelId
          ? `\n**Modelo del orquestador (recomendado):** ${config.orchestratorModelId}\nSi es posible, selecciona este modelo en el picker del chat.\n`
          : "";

        const orchPrompt = [
          `ORCHESTRATION_SESSION [sessionId=${sessionId}]: Sesión de orquestación multi-agente PERSISTENTE con FEEDBACK LOOP.`,
          ``,
          `**REGLA ABSOLUTA:** Cada vez que el usuario envíe un mensaje en este chat, DEBES llamar la herramienta \`orchestrate\` con el mensaje del usuario como \`prompt\` y sessionId="${sessionId}". El equipo persiste entre rondas con contexto acumulado.`,
          ``,
          `**Objetivo:** ${config.goal}`,
          orchModelHint,
          `**Equipo configurado:**`,
          teamDesc,
          ``,
          `**FLUJO DE FEEDBACK LOOP (obligatorio):**`,
          `1. Llama \`orchestrate\` con el prompt del usuario`,
          `2. Cuando los agentes terminen, analiza sus resultados y forma una SÍNTESIS concisa (3-5 oraciones con hallazgos clave)`,
          `3. Llama \`orchAwaitInput\` pasando sessionId="${sessionId}" y el parámetro synthesis="tu síntesis aquí" — OBLIGATORIO, sin synthesis el UI queda vacío. Esto BLOQUEA hasta que el usuario envíe feedback desde Brain HQ`,
          `4. Cuando recibas el feedback, llama \`orchestrate\` otra vez incorporando las instrucciones del usuario`,
          `5. Repite el ciclo (pasos 2-4) hasta que el usuario cierre la sesión`,
          ``,
          `Llama \`orchestrate\` AHORA para iniciar la primera ronda.`,
          `La sesión está BLOQUEADA — no puedes finalizarla hasta que el usuario haga click en "End Session" en Brain HQ.`,
        ].join("\n");

        const brainModeName = vscode.workspace
          .getConfiguration("projectBrain")
          .get<string>("chatModeName", "🧠 Brain");

        // Strategy 1: newChat → delay → open in Brain mode (same as session-spawner)
        try {
          await vscode.commands.executeCommand("workbench.action.chat.newChat");
          await new Promise((resolve) => setTimeout(resolve, 300));
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: orchPrompt,
            mode: brainModeName,
            isPartialQuery: false,
          });
          log(
            `[OrchSession] New chat spawned in "${brainModeName}" mode with ${config.team.length} agents`,
          );
          return;
        } catch (err) {
          log(`[OrchSession] Strategy 1 failed: ${err}`);
        }

        // Strategy 2: newChat with agentMode
        try {
          await vscode.commands.executeCommand(
            "workbench.action.chat.newChat",
            {
              inputValue: orchPrompt,
              agentMode: true,
              isPartialQuery: false,
            },
          );
          log("[OrchSession] Fallback: generic agent mode");
          return;
        } catch (err) {
          log(`[OrchSession] Strategy 2 failed: ${err}`);
        }

        // Strategy 3: bare new chat + info message
        try {
          await vscode.commands.executeCommand("workbench.action.chat.newChat");
          vscode.window.showInformationMessage(
            "Orchestration session ready! Switch to Brain mode and call the `orchestrate` tool.",
          );
        } catch (err) {
          log(`[OrchSession] All strategies failed: ${err}`);
          vscode.window.showErrorMessage(
            "Failed to spawn orchestration chat. Open chat manually → Brain mode → call orchestrate tool.",
          );
        }
      },
    ),
  );

  // ─── Launch Loop Session (spawn new Chat with loop goal) ────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.launchLoopSession",
      async (
        sessionId?: string,
        loopGoal?: string,
        useBranchIsolation?: boolean,
        baseBranch?: string,
      ) => {
        const goal = loopGoal || "Interactive feedback loop session";
        const sid = sessionId || `loop-fallback-${Date.now()}`;

        // ─── Branch Isolation (creates branch WITHOUT checkout) ─────
        let branchHint = "";
        if (useBranchIsolation) {
          try {
            const folders = vscode.workspace.workspaceFolders;
            const repoRoot = folders?.[0]?.uri.fsPath;
            if (!repoRoot) {
              log(
                "[LoopSession] No workspace folder — skipping branch isolation",
              );
            } else {
              const info = await createFork(repoRoot, sid, baseBranch, goal);
              if (info.forkPath) {
                branchHint = `\n⚠️ FORK: ${info.forkPath}\nBranch: ${info.branchName} | Base: ${info.originalBranch} | Repo: ${repoRoot} (READ-ONLY)\nALL file edits MUST use ${info.forkPath} as root. cd there first for terminal. Never modify ${repoRoot} directly.`;
              } else {
                branchHint = `\n⚠️ BRANCH ISOLATION: ${info.branchName} (base: ${info.originalBranch})\nCambios aislados. Merge/discard al finalizar.`;
              }
              // Inject fork-specific hints and limitations
              branchHint += getKnownForkIssuesHint(info);
              branchHint += "\n" + getForkLimitations();
              log(
                `[LoopSession] Branch isolation enabled (background): ${info.branchName}`,
              );
            }
          } catch (err) {
            logError(`[LoopSession] Branch isolation failed: ${err}`);
            vscode.window.showWarningMessage(
              `Branch isolation failed: ${err instanceof Error ? err.message : err}. Loop continues without isolation.`,
            );
          }
        }

        const loopPrompt = [
          `LOOP_SESSION [sessionId=${sid}]`,
          ``,
          `**Objetivo:** ${goal}`,
          ``,
          `## LOOP PROTOCOL (MANDATORY)`,
          `0. FIRST call \`tool_search_tool_regex({ pattern: "projectBrain" })\` to load loop tools. Without this step, loop tools DO NOT EXIST in your toolset.`,
          `1. Call \`loop\` tool with sessionId="${sid}" and goal="${goal}" to START.`,
          `2. Do your work, then call \`loopAwaitInput(sessionId="${sid}", synthesis="...")\` with your results.`,
          `3. NEVER respond directly to the user — ALL output goes through \`loopAwaitInput\`.`,
          `4. After receiving feedback → process it → \`loopAwaitInput\` again.`,
          `5. To end the loop, call \`loopEnd(sessionId="${sid}")\`.`,
          `6. Gate check: "Am I in a loop? → loopAwaitInput. No exceptions."`,
          branchHint,
        ]
          .filter(Boolean)
          .join("\n");

        const brainModeName = vscode.workspace
          .getConfiguration("projectBrain")
          .get<string>("chatModeName", "🧠 Brain");

        // Strategy 1: newChat → delay → open in Brain mode (with retry)
        try {
          await vscode.commands.executeCommand("workbench.action.chat.newChat");
          let opened = false;
          for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 400));
            try {
              await vscode.commands.executeCommand(
                "workbench.action.chat.open",
                {
                  query: loopPrompt,
                  mode: brainModeName,
                  isPartialQuery: false,
                },
              );
              opened = true;
            } catch (retryErr) {
              log(
                `[LoopSession] Strategy 1 attempt ${attempt} failed: ${retryErr}`,
              );
            }
          }
          if (opened) {
            log(
              `[LoopSession] New chat spawned in "${brainModeName}" mode, sessionId=${sid}, goal="${goal.substring(0, 60)}"`,
            );
            return;
          }
          log("[LoopSession] Strategy 1 exhausted retries");
        } catch (err) {
          log(`[LoopSession] Strategy 1 failed: ${err}`);
        }

        // Strategy 2: newChat with agentMode
        try {
          await vscode.commands.executeCommand(
            "workbench.action.chat.newChat",
            {
              inputValue: loopPrompt,
              agentMode: true,
              isPartialQuery: false,
            },
          );
          log("[LoopSession] Fallback: generic agent mode");
          return;
        } catch (err) {
          log(`[LoopSession] Strategy 2 failed: ${err}`);
        }

        // Strategy 3: bare new chat + info message
        try {
          await vscode.commands.executeCommand("workbench.action.chat.newChat");
          vscode.window.showInformationMessage(
            "Loop session ready! Switch to Brain mode and call the `loop` tool.",
          );
        } catch (err) {
          log(`[LoopSession] All strategies failed: ${err}`);
          vscode.window.showErrorMessage(
            "Failed to spawn loop chat. Open chat manually → Brain mode → call loop tool.",
          );
        }
      },
    ),
  );
}
