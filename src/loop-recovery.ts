/**
 * Loop Recovery — Detect and restore interrupted loop sessions.
 *
 * On extension activation, scans workspaceState for loops that were
 * active/awaiting when VS Code closed. Offers the user to resume
 * or discard them. Also provides utilities for mid-session recovery
 * when the LLM gets "canceled by server" during an active loop.
 *
 * Three recovery vectors:
 * 1. Startup notification — detected on activate
 * 2. Chat followup — detected on LLM cancellation
 * 3. Brain HQ — shows interrupted loops in a recoverable state
 */

import * as vscode from "vscode";
import { log } from "./logger";
import {
  loopReconnect,
  getAllLoopStates,
} from "./loop-engine";
import {
  getAllPersistedSessions,
  clearPersistedSession,
  buildReconnectSummary,
} from "./loop-persistence";
import type { PersistedLoopSession } from "./loop-persistence";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InterruptedLoop {
  sessionId: string;
  goal: string;
  iterationCount: number;
  lastSynthesis?: string;
  state: string;
  startedAt: number;
  persistedAt: number;
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Scan workspaceState for loop sessions that were active when the extension
 * died. Returns sessions not currently loaded in memory (i.e., orphaned).
 */
export function detectInterruptedLoops(): InterruptedLoop[] {
  const persisted = getAllPersistedSessions();
  const inMemory = getAllLoopStates();
  const interrupted: InterruptedLoop[] = [];

  for (const [sessionId, session] of Object.entries(persisted)) {
    // Skip if already loaded in memory (live session)
    if (inMemory.has(sessionId)) continue;
    // Skip completed sessions (shouldn't be persisted, but defensive)
    if (session.state === "completed") continue;

    interrupted.push({
      sessionId,
      goal: session.goal,
      iterationCount: session.iterationCount,
      lastSynthesis: session.pendingSynthesis,
      state: session.state ?? "unknown",
      startedAt: session.startedAt,
      persistedAt: session.persistedAt,
    });
  }

  // Sort by most recent first
  interrupted.sort((a, b) => b.persistedAt - a.persistedAt);
  log(
    `[LoopRecovery] Detected ${interrupted.length} interrupted loop(s) in workspaceState`,
  );
  return interrupted;
}

// ─── Startup Notification ───────────────────────────────────────────────────

/**
 * Show a VS Code notification for interrupted loops.
 * Called during extension activation. Fire-and-forget.
 */
export async function showInterruptedLoopNotification(
  interrupted: InterruptedLoop[],
): Promise<void> {
  if (interrupted.length === 0) return;

  const count = interrupted.length;
  const firstGoal = interrupted[0].goal.substring(0, 60);
  const iters = interrupted[0].iterationCount;

  const message =
    count === 1
      ? `🔁 Loop interrumpido detectado: "${firstGoal}" (${iters} iteraciones). ¿Reanudar?`
      : `🔁 ${count} loops interrumpidos detectados. ¿Quieres ver la lista?`;

  const pick = await vscode.window.showWarningMessage(
    message,
    "Reanudar",
    "Ver en Brain HQ",
    "Descartar",
  );

  if (pick === "Reanudar") {
    if (count === 1) {
      await resumeInterruptedLoop(interrupted[0].sessionId);
    } else {
      // Multiple loops — let user pick
      const picked = await pickInterruptedLoop(interrupted);
      if (picked) {
        await resumeInterruptedLoop(picked);
      }
    }
  } else if (pick === "Ver en Brain HQ") {
    void vscode.commands.executeCommand("projectBrain.openBrainHQ", "loops");
  } else if (pick === "Descartar") {
    for (const loop of interrupted) {
      clearPersistedSession(loop.sessionId);
    }
    log(`[LoopRecovery] Discarded ${count} interrupted loop(s)`);
  }
}

// ─── QuickPick for Multiple Interrupted Loops ───────────────────────────────

async function pickInterruptedLoop(
  loops: InterruptedLoop[],
): Promise<string | undefined> {
  interface LoopPickItem extends vscode.QuickPickItem {
    sessionId: string;
  }

  const items: LoopPickItem[] = loops.map((loop) => ({
    label: `🔁 ${loop.sessionId.substring(0, 8)}`,
    description: (loop.goal || "(sin objetivo)").substring(0, 60),
    detail: `${loop.iterationCount} iteraciones | Estado: ${loop.state} | ${formatAge(loop.persistedAt)}`,
    sessionId: loop.sessionId,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Selecciona un loop para reanudar",
    title: "Loops Interrumpidos",
  });

  return picked?.sessionId;
}

// ─── Resume ─────────────────────────────────────────────────────────────────

/**
 * Reconnect an interrupted loop and spawn a chat session to continue it.
 * Uses the same reconnect + spawn pattern as hibernate resume.
 */
export async function resumeInterruptedLoop(
  sessionId: string,
): Promise<boolean> {
  // Step 1: Reconnect from persisted state
  const result = loopReconnect(sessionId);
  if (!result.ok) {
    log(`[LoopRecovery] Could not reconnect session ${sessionId}`);
    void vscode.window.showErrorMessage(
      `No se pudo restaurar el loop ${sessionId.substring(0, 8)}.`,
    );
    clearPersistedSession(sessionId);
    return false;
  }

  // Step 2: Build resume prompt
  const resumePrompt = [
    `LOOP_SESSION [sessionId=${sessionId}]`,
    `**Objetivo:** ${result.goal}`,
    ``,
    `## Contexto de reconexión (loop interrumpido)`,
    result.summary ?? "(sin resumen disponible)",
    ``,
    `⚡ FAST RESUME — Este loop fue interrumpido (recarga/crash).`,
    `0. FIRST call \`tool_search_tool_regex({ pattern: "projectBrain" })\` to load loop tools.`,
    `1. Then call \`loop\` con sessionId="${sessionId}" y goal="${result.goal}" para retomar.`,
    `NO hagas búsquedas de memoria ni re-lectura innecesaria. Tu contexto está completo arriba.`,
  ].join("\n");

  // Step 3: Spawn chat
  await spawnRecoveryChat(resumePrompt, sessionId);
  log(
    `[LoopRecovery] ☀️ Resumed interrupted loop ${sessionId.substring(0, 8)}`,
  );
  return true;
}

// ─── Mid-Session Recovery Info ──────────────────────────────────────────────

/**
 * Check if there's an active loop that was interrupted by a cancellation.
 * Returns recovery info for the followup provider.
 */
export function getLoopRecoveryInfo(): InterruptedLoop | null {
  const persisted = getAllPersistedSessions();
  const inMemory = getAllLoopStates();

  for (const [sessionId, session] of Object.entries(persisted)) {
    // Find sessions that are persisted as active but have no live feedback resolver
    if (
      session.state === "active" ||
      session.state === "awaiting" ||
      session.state === "spawning"
    ) {
      // If it's in memory but completed or idle, it's not recoverable
      const memState = inMemory.get(sessionId);
      if (memState && (memState.state === "completed" || memState.state === "idle")) {
        continue;
      }
      return {
        sessionId,
        goal: session.goal,
        iterationCount: session.iterationCount,
        lastSynthesis: session.pendingSynthesis,
        state: session.state ?? "unknown",
        startedAt: session.startedAt,
        persistedAt: session.persistedAt,
      };
    }
  }
  return null;
}

// ─── Spawn Chat (shared with loop-commands.ts pattern) ──────────────────────

async function spawnRecoveryChat(
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
      `[LoopRecovery] Chat spawned in "${brainModeName}" mode for ${sessionId.substring(0, 8)}`,
    );
    return;
  } catch (err) {
    log(`[LoopRecovery] Strategy 1 failed: ${err}`);
  }

  // Strategy 2: newChat with agentMode
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat", {
      inputValue: prompt,
      agentMode: true,
      isPartialQuery: false,
    });
    log("[LoopRecovery] Chat spawned via agent mode fallback");
    return;
  } catch (err) {
    log(`[LoopRecovery] Strategy 2 failed: ${err}`);
  }

  // Strategy 3: clipboard fallback
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage(
      `☀️ Loop ${sessionId.substring(0, 8)} restaurado. ` +
        `Prompt copiado al clipboard — pégalo en el chat en modo Brain.`,
    );
  } catch (err) {
    log(`[LoopRecovery] All strategies failed: ${err}`);
    void vscode.window.showErrorMessage(
      `No se pudo abrir el chat para reanudar el loop ${sessionId.substring(0, 8)}.`,
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 1) return "hace <1min";
  if (minutes < 60) return `hace ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.floor(hours / 24)}d`;
}
