/**
 * Loop Actions — Handles `/loop --start` and `/loop --resume` actions.
 *
 * Extracted from lm-tools-loop.ts to respect the 400-line limit.
 * These actions are specific to the Brain agent mode (NOT @brain participant).
 */

import * as vscode from "vscode";
import { log } from "./logger";
import {
  hasActiveLoop,
  loopReconnect,
  loopStart,
  setLoopSessionOpen,
} from "./loop-engine";
import {
  formatResumeContext,
  listHibernatedLoops,
  resumeHibernatedLoop,
} from "./loop-hibernate";

// ——— Types ————————————————————————————————————————————————————————

interface LoopStartResult {
  sessionId: string;
  goal: string;
  hqOpened: boolean;
}

interface HibernatedPick extends vscode.QuickPickItem {
  sessionId: string;
}

// ——— /loop --start ———————————————————————————————————————————————

/**
 * Handles `action: "start"` — creates a new loop session and immediately
 * opens Brain HQ so the user can interact with the feedback panel.
 */
export async function handleLoopStart(
  sessionId: string,
  goal: string,
  activeLoopGoals: Map<string, string>,
  loopRoundCounters: Map<string, number>,
): Promise<vscode.LanguageModelToolResult> {
  // Guard: already active
  if (hasActiveLoop(sessionId)) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `⚠️ Ya hay un loop activo con sessionId=${sessionId}. Usa \`loopAwaitInput\` para continuar.`,
      ),
    ]);
  }

  // Start the loop engine
  const loopGoal = goal || "Interactive loop session";
  activeLoopGoals.set(sessionId, loopGoal);
  loopRoundCounters.set(sessionId, 0);
  await loopStart(sessionId, loopGoal);
  setLoopSessionOpen(sessionId, true);

  log(
    `[Loop] --start: sessionId=${sessionId}, goal="${loopGoal.substring(0, 60)}"`,
  );

  // Open Brain HQ immediately
  let hqOpened = false;
  try {
    await vscode.commands.executeCommand("projectBrain.openBrainHQ");
    hqOpened = true;
    log("[Loop] --start: Brain HQ opened");
  } catch (err) {
    log(`[Loop] --start: Failed to open HQ: ${err}`);
  }

  const parts = [
    `🔄 **Loop Mode iniciado** (con Brain HQ ${hqOpened ? "abierto" : "⚠️ no se pudo abrir"})`,
    `**Objetivo:** ${loopGoal}`,
    `**Session ID:** ${sessionId}`,
    "",
    "---",
    "**INSTRUCCIÓN:** Procesa el objetivo. Cuando tengas resultados, llama `loopAwaitInput`",
    `con sessionId="${sessionId}" y synthesis="tu síntesis aquí".`,
    "El usuario verá tu síntesis en Brain HQ y podrá enviarte feedback.",
  ];

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(parts.join("\n")),
  ]);
}

// ——— /loop --resume —————————————————————————————————————————————

/**
 * Handles `action: "resume"` — shows a QuickPick of hibernated loops
 * and resumes the selected one in the CURRENT chat session (no new chat spawn).
 */
export async function handleLoopResume(
  sessionId: string,
  activeLoopGoals: Map<string, string>,
  loopRoundCounters: Map<string, number>,
): Promise<vscode.LanguageModelToolResult> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("⚠️ No workspace folder found."),
    ]);
  }

  const hibernated = listHibernatedLoops(wsRoot);
  if (hibernated.length === 0) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        "ℹ️ No hay loops hibernados para resumir. Usa `loop` con action `start` para crear uno nuevo.",
      ),
    ]);
  }

  // Show QuickPick with hibernated loops
  const items: HibernatedPick[] = hibernated.map((h) => ({
    label: `💤 ${h.sessionId.substring(0, 8)}`,
    description: h.goal.substring(0, 60),
    detail: `${h.currentRound} iteraciones | Branch: ${h.branchName ?? "?"} | Hibernado: ${formatAge(h.hibernatedAt)}`,
    sessionId: h.sessionId,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Selecciona un loop hibernado para resumir",
    title: "Resume Hibernated Loop",
  });

  if (!picked) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("ℹ️ Selección cancelada."),
    ]);
  }

  // Resume the selected loop
  const snapshot = await resumeHibernatedLoop(wsRoot, picked.sessionId);
  if (!snapshot) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `⚠️ No se pudo resumir el loop ${picked.sessionId.substring(0, 8)}.`,
      ),
    ]);
  }

  const resumeCtx = formatResumeContext(snapshot);

  // Initialize loop state for the resumed session
  activeLoopGoals.set(snapshot.sessionId, snapshot.goal);
  loopRoundCounters.set(snapshot.sessionId, snapshot.currentRound || 0);
  await loopStart(snapshot.sessionId, snapshot.goal);
  setLoopSessionOpen(snapshot.sessionId, true);

  log(
    `[Loop] --resume: Resumed ${snapshot.sessionId.substring(0, 8)} in current chat`,
  );

  // Open Brain HQ
  try {
    await vscode.commands.executeCommand("projectBrain.openBrainHQ");
    log("[Loop] --resume: Brain HQ opened");
  } catch {
    /* non-fatal */
  }

  const parts = [
    `☀️ **Loop resumido** — ${snapshot.sessionId.substring(0, 8)}`,
    `**Objetivo:** ${snapshot.goal}`,
    `**Ronda actual:** ${snapshot.currentRound}`,
    "",
    resumeCtx,
    "",
    "---",
    "⚡ **FAST RESUME** — Continúa desde donde se quedó. Procesa el contexto anterior y llama `loopAwaitInput`",
    `con sessionId="${snapshot.sessionId}" y synthesis="tu síntesis aquí".`,
    "NO hagas búsquedas de memoria ni re-lectura de archivos innecesarias.",
  ];

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(parts.join("\n")),
  ]);
}

// ——— Helpers ————————————————————————————————————————————————————

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ─── LoopReconnectTool ───────────────────────────────────────────────────────

/**
 * Reconnects a lost loop session from persisted metadata (e.g., after extension restart).
 * The agent calls this when loopAwaitInput returns SESSION_LOST.
 */
export class LoopReconnectTool implements vscode.LanguageModelTool<{
  sessionId: string;
}> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ sessionId: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sessionId = options.input?.sessionId;
    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("⚠️ Falta sessionId."),
      ]);
    }
    const result = loopReconnect(sessionId);
    if (!result.ok) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ No hay sesión persistida para sessionId=${sessionId}. El loop se perdió sin persistencia. Inicia un nuevo loop.`,
        ),
      ]);
    }
    this.log(`[LoopReconnect] sessionId=${sessionId} OK`);

    const parts = [
      `✅ **Loop reconectado** — sessionId=${sessionId}`,
      "",
      `**Objetivo original**: ${result.goal}`,
    ];

    if (result.summary) {
      parts.push("", "### Contexto restaurado:", result.summary);
    }

    parts.push(
      "",
      "---",
      "Ahora puedes continuar llamando `loopAwaitInput` con tu síntesis.",
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(parts.join("\n")),
    ]);
  }
}
