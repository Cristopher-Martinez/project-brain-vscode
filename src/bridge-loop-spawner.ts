/**
 * bridge-loop-spawner — Shared loop spawn+launch logic for bridge handlers.
 *
 * Used by: createAutoLoopBridgeSession (new loop mode) and reconnectAutoLoopWorker.
 * Avoids duplication of setLoopSessionOpen → loopSpawn → launchLoopSession pattern.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { loopSpawn, loopReset, getLoopState, setLoopSessionOpen } from "./loop-engine";
import { updateLoopConfig } from "./loop-config";
import { updateBridgeWorkerLoopSessionId } from "./auto-loop-bridge-manager";

export interface SpawnLoopResult {
  newLoopId: string;
  goal: string;
  launched: boolean;
  error?: string;
}

/**
 * Spawn a brand-new loop from the bridge and launch a chat session for it.
 */
export async function spawnNewLoopFromBridge(
  goal: string,
  log: (msg: string) => void,
): Promise<SpawnLoopResult> {
  const newLoopId = crypto.randomUUID();
  log(`[BridgeLoopSpawner] Spawning NEW loop: ${newLoopId.slice(0, 8)} goal="${goal.substring(0, 60)}"`);

  setLoopSessionOpen(newLoopId, true);
  loopSpawn(newLoopId, goal);

  try {
    await vscode.commands.executeCommand(
      "projectBrain.launchLoopSession",
      newLoopId,
      goal,
      false,
    );
    return { newLoopId, goal, launched: true };
  } catch (err) {
    log(`[BridgeLoopSpawner] Launch failed: ${err}`);
    return {
      newLoopId,
      goal,
      launched: false,
      error: `Failed to launch loop: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/**
 * Reconnect a bridge session by resetting the old loop and spawning a fresh one.
 */
export async function reconnectLoopFromBridge(
  bridgeSessionId: string,
  oldLoopId: string,
  log: (msg: string) => void,
): Promise<SpawnLoopResult> {
  const oldState = getLoopState(oldLoopId);
  const goal = oldState.goal ?? oldLoopId;
  const lastSynthesis = oldState.iterations?.[oldState.iterations.length - 1]?.synthesis;

  loopReset(oldLoopId);

  const newLoopId = crypto.randomUUID();
  const originalHistoryPath = `.project-brain/loops/${oldLoopId}/history.json`;
  const reconnectGoal =
    `[RECONEXIÓN] Objetivo original: ${goal}` +
    `\nPRIMERA ACCIÓN OBLIGATORIA: llama hydrateLoopContext({ sessionId: "${newLoopId}", mode: "summary" }) antes de responder.` +
    `\nRuta exacta del historial del loop original: ${originalHistoryPath}` +
    `\nIMPORTANTE: Lee ESE archivo para ver todas las iteraciones previas. No uses el history.json del loop nuevo de reconexión.` +
    `${lastSynthesis ? `\nÚltima síntesis: ${lastSynthesis.substring(0, 300)}` : ""}`;

  setLoopSessionOpen(newLoopId, true);
  loopSpawn(newLoopId, reconnectGoal);
  updateLoopConfig(newLoopId, { sourceSessionId: oldLoopId });
  updateBridgeWorkerLoopSessionId(bridgeSessionId, newLoopId);

  log(`[BridgeLoopSpawner] Reconnect: ${newLoopId.substring(0, 8)} from ${oldLoopId.substring(0, 8)} (bridge=${bridgeSessionId.slice(0, 8)})`);

  try {
    await vscode.commands.executeCommand(
      "projectBrain.launchLoopSession",
      newLoopId,
      reconnectGoal,
      false,
    );
    return { newLoopId, goal: reconnectGoal, launched: true };
  } catch (err) {
    log(`[BridgeLoopSpawner] Reconnect launch failed: ${err}`);
    return {
      newLoopId,
      goal: reconnectGoal,
      launched: false,
      error: `Reconnect launch failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}
