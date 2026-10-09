/**
 * Loop Context Relay � Migration orchestrator.
 *
 * When a loop reaches maxCycles, this module hibernates the current
 * loop (reusing loop-hibernate) and spawns a new chat session that
 * auto-resumes via STRAT-9.
 *
 * @module loop-migration
 */
import * as vscode from "vscode";
import { log, logWarn } from "./logger";
import { readLoopConfig, resetLoopIterations } from "./loop-config";
import { getLoopState } from "./loop-engine";
import type { HibernatedLoop } from "./loop-hibernate";
import { hibernateLoop } from "./loop-hibernate";
import { readLoopHistory } from "./loop-history";

// ─── Migration lock (prevents double-migration race condition) ───────────────
const migrationInProgress = new Set<string>();

// ─── Config ──────────────────────────────────────────────────────────────────

export function getDefaultMaxCycles(): number {
  return vscode.workspace
    .getConfiguration("projectBrain")
    .get<number>("loop.maxCycles", 15);
}

// ─── Migration check ─────────────────────────────────────────────────────────

export function needsMigration(sessionId: string): boolean {
  const state = getLoopState(sessionId);
  if (!state) return false;
  // Check if auto-migration is disabled in config
  const config = readLoopConfig(sessionId);
  if (config?.autoMigrate === false) return false;
  // Source of truth: config.currentLoopIterations (persisted to disk)
  // Fallback: state.iterations.length (in-memory) for backwards compat
  const currentIter = config?.currentLoopIterations ?? state.iterations.length;
  const effectiveMax = config?.maxCycles ?? getDefaultMaxCycles();
  return currentIter >= effectiveMax;
}

// ─── Migration prompt ────────────────────────────────────────────────────────

/** Build a condensed summary of the last N iterations from history.json. */
function buildHistorySummary(sessionId: string, maxEntries = 3): string {
  const history = readLoopHistory(sessionId);
  if (!history || history.iterations.length === 0) {
    return "(sin historial previo)";
  }
  const recent = history.iterations.slice(-maxEntries);
  return recent
    .map((it) => {
      const syn = it.synthesis
        ? it.synthesis.substring(0, 200).replace(/\n/g, " ")
        : "(sin síntesis)";
      const fb = it.feedback
        ? it.feedback.substring(0, 100).replace(/\n/g, " ")
        : "(sin feedback)";
      return `  [Iter ${it.index}] Síntesis: ${syn}${it.synthesis && it.synthesis.length > 200 ? "..." : ""}\n    Feedback: ${fb}${it.feedback && it.feedback.length > 100 ? "..." : ""}`;
    })
    .join("\n");
}

function buildMigrationPrompt(
  pendingFeedback: string,
  snapshot: HibernatedLoop,
): string {
  const sid = snapshot.sessionId;
  const goal = snapshot.goal || "Continuar trabajo del loop anterior";
  const branch = snapshot.branchName || "(sin branch)";
  const lastSynthesis = snapshot.lastSynthesis
    ? snapshot.lastSynthesis.substring(0, 500)
    : "(sin s\u00EDntesis previa)";
  const historySummary = buildHistorySummary(sid);

  return [
    `LOOP_SESSION [sessionId=${sid}]`,
    `Objetivo: ${goal}`,
    "",
    "\u2600\uFE0F FAST RESUME \u2014 Sesi\u00F3n migrada por agotamiento de contexto",
    `Objetivo original: ${goal}`,
    `Iteraciones completadas: ${snapshot.currentRound}`,
    `Branch: ${branch}`,
    "",
    "\u00DAltima s\u00EDntesis antes de migrar:",
    lastSynthesis,
    "",
    "Feedback pendiente del usuario:",
    pendingFeedback,
    "",
    "\uD83D\uDDC2\uFE0F Resumen de iteraciones recientes:",
    historySummary,
    "",
    "\u26A1 FAST RESUME \u2014 Tu contexto est\u00E1 completo arriba.",
    "NO necesitas buscar en memoria ni re-leer archivos.",
    "Ve DIRECTO a procesar y llama loopAwaitInput con tu plan de acci\u00F3n.",
    "",
    "\u26A1 FAST RESUME:",
    '0. FIRST call tool_search_tool_regex({ pattern: "projectBrain" }) to load loop tools.',
    "",
    `1. Then call loop(sessionId="${sid}", action="start", goal="${goal}"). MANDATORY: include sessionId="${sid}" in the tool call parameters.`,
    "NO hagas b\u00FAsquedas de memoria ni re-lectura innecesaria. Tu contexto est\u00E1 completo arriba.",
    "",
    `\uD83D\uDCDC Si necesitas m\u00E1s contexto sobre iteraciones anteriores, lee el historial completo: \`.project-brain/loops/${sid}/history.json\``,
  ].join("\n");
}

// ─── Execute migration ──────────────────────────────────────────────────────

export async function executeMigration(
  sessionId: string,
  pendingFeedback: string,
): Promise<boolean> {
  // Guard: prevent double-migration race condition
  if (migrationInProgress.has(sessionId)) {
    log(
      `[Migration] Already in progress for ${sessionId.substring(0, 8)} — skipping`,
    );
    return false;
  }
  migrationInProgress.add(sessionId);
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "🔄 Migrando loop...",
      },
      async () => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        if (!wsRoot) {
          logWarn("[Migration] No workspace root");
          return false;
        }

        // 1. Hibernate the loop — saves snapshot to disk, cleans up signal
        const snapshot = hibernateLoop(wsRoot, sessionId);
        if (!snapshot) {
          logWarn("[Migration] hibernateLoop returned null");
          return false;
        }

        // 2. Build prompt for the new session (uses STRAT-9 auto-resume)
        const prompt = buildMigrationPrompt(pendingFeedback, snapshot);

        // 3. Reset currentLoopIterations in config before spawning new session
        resetLoopIterations(sessionId);

        // 4. Spawn new chat session — agent will call loop() and
        //    STRAT-9 will auto-detect the hibernated snapshot
        await spawnMigrationSession(prompt);

        log(
          `[Migration] ✅ ${sessionId.substring(0, 8)} hibernated+spawned ` +
            `(${snapshot.currentRound} rounds)`,
        );
        return true;
      },
    );
  } catch (err) {
    logWarn(`[Migration] Error: ${err}`);
    return false;
  } finally {
    migrationInProgress.delete(sessionId);
  }
}

// ─── Chat spawner ────────────────────────────────────────────────────────────

async function spawnMigrationSession(prompt: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const brainModeName = config.get<string>("chatModeName", "?? Brain");

  // Strategy 1: newChat ? delay ? open in Brain mode (matches /spawn pattern)
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: prompt,
      mode: brainModeName,
      isPartialQuery: false,
    });
    return;
  } catch {
    // fallthrough
  }

  // Strategy 2: newChat with agentMode
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat", {
      inputValue: prompt,
      agentMode: true,
      isPartialQuery: false,
    });
    return;
  } catch {
    // fallthrough
  }

  // Strategy 3: bare new chat (last resort)
  await vscode.commands.executeCommand("workbench.action.chat.newChat");
}
