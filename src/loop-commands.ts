/**
 * Loop Commands — VS Code command registrations for loop control.
 *
 * Commands:
 *   - projectBrain.loopPauseToggle — Pause / Resume a running loop
 *   - projectBrain.loopSendMessage — Send an urgent message to a loop
 */

import * as vscode from "vscode";
import { log } from "./logger";
import { showLoopPicker } from "./loop-connect";
import {
  broadcastUserMessage,
  isLoopPaused,
  sendUserMessage,
  togglePause,
} from "./loop-control";
import { getAllLoopStates } from "./loop-engine";
import {
  formatResumeContext,
  hibernateLoop,
  listHibernatedLoops,
  resumeHibernatedLoop,
} from "./loop-hibernate";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface LoopQuickPickItem extends vscode.QuickPickItem {
  sessionId: string;
}

function getActiveLoopPicks(): LoopQuickPickItem[] {
  const states = getAllLoopStates();
  const items: LoopQuickPickItem[] = [];

  for (const [sessionId, state] of states) {
    if (state.state === "completed") continue;
    const paused = isLoopPaused(sessionId);
    const icon = paused ? "$(debug-pause)" : "$(play)";
    const status = paused ? "PAUSED" : state.state;
    items.push({
      label: `${icon} ${sessionId.substring(0, 8)}`,
      description: `[${status}] ${state.goal ?? ""}`.substring(0, 80),
      detail: `Started: ${state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : "?"} | Iterations: ${state.iterations.length}`,
      sessionId,
    });
  }
  return items;
}

async function pickActiveLoop(title: string): Promise<string | undefined> {
  const items = getActiveLoopPicks();
  if (items.length === 0) {
    void vscode.window.showInformationMessage("No active loop sessions.");
    return undefined;
  }
  if (items.length === 1) {
    return items[0].sessionId;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a loop session",
    title,
  });
  return picked?.sessionId;
}

// ─── Command Registrations ──────────────────────────────────────────────────

export function registerLoopCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.loopPauseToggle",
      async (maybeSessionId?: unknown) => {
        const sessionId =
          typeof maybeSessionId === "string"
            ? maybeSessionId
            : await pickActiveLoop("Pause / Resume Loop");
        if (!sessionId) return;

        const newState = togglePause(sessionId);
        const icon = newState === "paused" ? "⏸️" : "▶️";
        const label = newState === "paused" ? "PAUSED" : "RESUMED";
        log(
          `[LoopCommands] ${icon} ${label} loop ${sessionId.substring(0, 8)}`,
        );
        void vscode.window.showInformationMessage(
          `${icon} Loop ${sessionId.substring(0, 8)} — ${label}`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.loopSendMessage",
      async (maybeSessionId?: unknown) => {
        const items = getActiveLoopPicks();
        const broadcastItem: LoopQuickPickItem = {
          label: "$(megaphone) Broadcast — ALL loops",
          description: "Send to every active loop",
          sessionId: "__broadcast__",
        };

        const allItems = [broadcastItem, ...items];
        if (items.length === 0) {
          void vscode.window.showInformationMessage("No active loop sessions.");
          return;
        }

        const target =
          typeof maybeSessionId === "string"
            ? allItems.find((i) => i.sessionId === maybeSessionId)
            : await vscode.window.showQuickPick(allItems, {
                placeHolder: "Who should receive the message?",
                title: "Send Urgent Message to Loop",
              });
        if (!target) {
          if (typeof maybeSessionId === "string") {
            void vscode.window.showWarningMessage(
              `Loop no encontrado o no activo: ${maybeSessionId.substring(0, 8)}`,
            );
          }
          return;
        }

        const message = await vscode.window.showInputBox({
          placeHolder: "Your urgent message...",
          title: "🚨 Urgent Message to Agent",
          prompt: "This will be prioritized in the agent's next feedback round",
        });
        if (!message) return;

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;

        if (target.sessionId === "__broadcast__") {
          broadcastUserMessage(wsRoot, message);
          void vscode.window.showInformationMessage(
            `🚨 Broadcast sent to ${items.length} loop(s)`,
          );
        } else {
          sendUserMessage(wsRoot, target.sessionId, message);
          void vscode.window.showInformationMessage(
            `🚨 Message sent to loop ${target.sessionId.substring(0, 8)}`,
          );
        }
      },
    ),
  );

  // ─── Hibernate ──────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.loopHibernate",
      async (maybeSessionId?: unknown) => {
        const sessionId =
          typeof maybeSessionId === "string"
            ? maybeSessionId
            : await pickActiveLoop("Hibernate Loop");
        if (!sessionId) return;

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;

        const snapshot = hibernateLoop(wsRoot, sessionId);
        if (snapshot) {
          void vscode.window.showInformationMessage(
            `💤 Loop ${sessionId.substring(0, 8)} hibernado. Branch "${snapshot.branchName}" preservado. Resume otro día.`,
          );
          // Refresh hibernated loops in Brain HQ webview (if open)
          const { BrainHQPanel } = await import("./brain-hq");
          if (BrainHQPanel.currentPanel) {
            void BrainHQPanel.currentPanel.refreshHibernatedLoops();
          }
        } else {
          void vscode.window.showWarningMessage(
            `No se pudo hibernar el loop ${sessionId.substring(0, 8)}.`,
          );
        }
      },
    ),
  );

  // ─── Resume ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.loopResume",
      async (maybeSessionId?: unknown) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;

        let targetSessionId: string;

        if (typeof maybeSessionId === "string") {
          // Direct resume (toggle from webview) — no QuickPick
          targetSessionId = maybeSessionId;
        } else {
          // Fallback: QuickPick for command palette usage
          const hibernated = listHibernatedLoops(wsRoot);
          if (hibernated.length === 0) {
            void vscode.window.showInformationMessage(
              "No hay loops hibernados.",
            );
            return;
          }

          const items = hibernated.map((h) => ({
            label: `💤 ${h.sessionId.substring(0, 8)}`,
            description: h.goal.substring(0, 60),
            detail: `${h.currentRound} iteraciones | Branch: ${h.branchName ?? "?"} | Hibernado: ${formatAge(h.hibernatedAt)}`,
            sessionId: h.sessionId,
          }));

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Select a hibernated loop to resume",
            title: "Resume Hibernated Loop",
          });
          if (!picked) return;
          targetSessionId = picked.sessionId;
        }

        const snapshot = await resumeHibernatedLoop(wsRoot, targetSessionId);
        if (snapshot) {
          const ctx = formatResumeContext(snapshot);
          log(
            `[LoopCommands] Resumed ${targetSessionId.substring(0, 8)}: ${ctx.substring(0, 100)}`,
          );

          // Build resume prompt with full context for auto-spawn
          const resumePrompt = [
            `LOOP_SESSION [sessionId=${snapshot.sessionId}]`,
            `**Objetivo:** ${snapshot.goal}`,
            ``,
            ctx,
            ``,
            `⚡ FAST RESUME:`,
            `0. FIRST call \`tool_search_tool_regex({ pattern: "projectBrain" })\` to load loop tools.`,
            `1. Then call \`loop\` con sessionId="${snapshot.sessionId}" y goal="${snapshot.goal}" para iniciar.`,
            `NO hagas búsquedas de memoria ni re-lectura innecesaria. Tu contexto está completo arriba.`,
          ].join("\n");

          // Spawn a new chat in Brain mode (agent mode) with full context
          await spawnResumedLoopChat(resumePrompt, targetSessionId);
        }
      },
    ),
  );

  // ─── Delete Hibernated ────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.loopDeleteHibernated",
      async (maybeSessionId?: unknown) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;

        const sessionId =
          typeof maybeSessionId === "string" ? maybeSessionId : undefined;
        if (!sessionId) return;

        const { deleteHibernatedLoop } = await import("./loop-hibernate");
        const deleted = deleteHibernatedLoop(wsRoot, sessionId);
        if (deleted) {
          void vscode.window.showInformationMessage(
            `🗑️ Loop hibernado ${sessionId.substring(0, 8)} eliminado.`,
          );
        }
      },
    ),
  );
}

// ─── Auto-Spawn Chat for Resumed Loops ──────────────────────────────────────

/**
 * Spawn a new chat in Brain mode (agent mode) with the resume context.
 * Uses the same strategy cascade as session-launchers.ts.
 */
async function spawnResumedLoopChat(
  prompt: string,
  sessionId: string,
): Promise<void> {
  const brainModeName = vscode.workspace
    .getConfiguration("projectBrain")
    .get<string>("chatModeName", "🧠 Brain");

  // Strategy 1: newChat → delay → open in Brain mode
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: prompt,
      mode: brainModeName,
      isPartialQuery: false,
    });
    log(
      `[LoopCommands] ☀️ Resumed loop ${sessionId.substring(0, 8)} — chat spawned in "${brainModeName}" mode`,
    );
    return;
  } catch (err) {
    log(`[LoopCommands] Resume strategy 1 failed: ${err}`);
  }

  // Strategy 2: newChat with agentMode
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat", {
      inputValue: prompt,
      agentMode: true,
      isPartialQuery: false,
    });
    log("[LoopCommands] ☀️ Resumed loop via agent mode fallback");
    return;
  } catch (err) {
    log(`[LoopCommands] Resume strategy 2 failed: ${err}`);
  }

  // Strategy 3: fallback — clipboard + info message
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage(
      `☀️ Loop ${sessionId.substring(0, 8)} restaurado. ` +
        `Prompt copiado al clipboard — pégalo en el chat en modo Brain.`,
    );
  } catch (err) {
    log(`[LoopCommands] All resume strategies failed: ${err}`);
    void vscode.window.showErrorMessage(
      `No se pudo abrir el chat para resumir el loop ${sessionId.substring(0, 8)}. Ábrelo manualmente.`,
    );
  }
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ─── Connect Loop Command ───────────────────────────────────────────────────

/**
 * Register `projectBrain.connectLoop` — accessible from Command Palette.
 * Opens the unified loop picker (active / hibernated / interrupted / new).
 */
export function registerConnectLoopCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.connectLoop", async () => {
      log("[LoopCommands] connectLoop invoked from command palette");
      await showLoopPicker();
    }),
  );
}
