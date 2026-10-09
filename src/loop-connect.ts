/**
 * Loop Connect — Unified loop creation/connection from any context.
 *
 * Provides:
 *   - `showLoopPicker()` — QuickPick: list active, spawning, hibernated loops + "Create new"
 *   - `connectToLoop(sessionId)` — Connect to an existing loop by ID
 *   - `createAndLaunchLoop(goal)` — Create a new loop and launch Brain mode chat
 *   - `handleLoopSlashCommand()` — Enhanced @brain /loop handler
 */

import * as crypto from "crypto";
import * as vscode from "vscode";
import { log } from "./logger";
import { getAllLoopStates, loopSpawn, setLoopSessionOpen } from "./loop-engine";
import { listHibernatedLoops } from "./loop-hibernate";
import { getAllPersistedSessions } from "./loop-persistence";
import { writeActiveLoopSignal } from "./loop-signal";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LoopPickItem extends vscode.QuickPickItem {
  sessionId: string;
  goal: string;
  loopKind: "active" | "spawning" | "hibernated" | "interrupted" | "new";
}

interface HandlerContext {
  log: (msg: string) => void;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Create a new loop session and launch a Brain mode chat with it.
 * Returns the generated sessionId.
 */
export async function createAndLaunchLoop(goal: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  loopSpawn(sessionId, goal);
  setLoopSessionOpen(sessionId, true);

  log(
    `[LoopConnect] Created loop ${sessionId.substring(0, 8)}, goal="${goal.substring(0, 60)}"`,
  );

  await vscode.commands.executeCommand(
    "projectBrain.launchLoopSession",
    sessionId,
    goal,
  );

  return sessionId;
}

/**
 * Connect to an existing loop by sessionId.
 * Spawns the loop state (if not already spawned) and launches Brain mode chat.
 */
export async function connectToLoop(
  sessionId: string,
  goal?: string,
): Promise<void> {
  // Try to get goal from persisted sessions or active state
  const resolvedGoal = goal ?? resolveGoal(sessionId);

  loopSpawn(sessionId, resolvedGoal);
  setLoopSessionOpen(sessionId, true);
  writeActiveLoopSignal(sessionId, resolvedGoal);

  log(
    `[LoopConnect] Connecting to loop ${sessionId.substring(0, 8)}, goal="${resolvedGoal.substring(0, 60)}"`,
  );

  await vscode.commands.executeCommand(
    "projectBrain.launchLoopSession",
    sessionId,
    resolvedGoal,
  );
}

// ─── QuickPick ──────────────────────────────────────────────────────────────

/** Show a QuickPick with all discoverable loops + "Create new" option. */
export async function showLoopPicker(): Promise<void> {
  const items = buildLoopPickItems();

  if (items.length === 0) {
    // No existing loops — go straight to creating a new one
    const goal = await vscode.window.showInputBox({
      placeHolder: "Objetivo del loop...",
      prompt: "¿Cuál es el objetivo del nuevo loop?",
    });
    if (goal?.trim()) {
      await createAndLaunchLoop(goal.trim());
    }
    return;
  }

  // Add "Create new" at the top
  const newItem: LoopPickItem = {
    label: "$(add) Crear nuevo loop",
    description: "Genera un nuevo sessionId y abre un chat",
    sessionId: "",
    goal: "",
    loopKind: "new",
  };

  const picked = await vscode.window.showQuickPick<LoopPickItem>(
    [newItem, ...items],
    {
      placeHolder: "Selecciona un loop existente o crea uno nuevo",
      title: "🔁 Loop Connect",
    },
  );

  if (!picked) return;

  if (picked.loopKind === "new") {
    const goal = await vscode.window.showInputBox({
      placeHolder: "Objetivo del loop...",
      prompt: "¿Cuál es el objetivo del nuevo loop?",
    });
    if (goal?.trim()) {
      await createAndLaunchLoop(goal.trim());
    }
    return;
  }

  await connectToLoop(picked.sessionId, picked.goal);
}

// ─── @brain /loop Handler ───────────────────────────────────────────────────

/**
 * Enhanced handler for `@brain /loop` slash command.
 *
 * - `/loop` (no args)         → QuickPick of available loops
 * - `/loop <uuid>`            → Connect to that specific loop
 * - `/loop <goal text>`       → Create new loop with that goal
 */
export async function handleLoopSlashCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  ctx: HandlerContext,
): Promise<vscode.ChatResult> {
  const prompt = request.prompt.trim();

  // Case 1: No args → show picker
  if (!prompt) {
    await showLoopPicker();
    stream.markdown(
      "🔁 Se abrió el selector de loops. Si seleccionaste uno, se abrirá un nuevo chat en Brain mode.\n",
    );
    return { metadata: {} };
  }

  // Case 2: UUID → connect to existing
  if (UUID_RE.test(prompt)) {
    const persisted = getAllPersistedSessions()[prompt];
    const active = getAllLoopStates().get(prompt);
    const goal = active?.goal ?? persisted?.goal ?? "Reconnected loop session";

    stream.markdown(
      `🔁 Conectando al loop \`${prompt.substring(0, 8)}...\`\n\n` +
        `**Objetivo:** ${goal}\n`,
    );

    await connectToLoop(prompt, goal);
    ctx.log(`[/loop] Connected to existing loop: ${prompt}`);
    return { metadata: { loopConnected: true, sessionId: prompt } };
  }

  // Case 3: Text → create new loop with this as goal
  const sessionId = await createAndLaunchLoop(prompt);
  ctx.log(
    `[/loop] Created new loop: ${sessionId}, goal="${prompt.substring(0, 60)}"`,
  );

  stream.markdown(
    `## 🔁 Loop iniciado\n\n` +
      `**Objetivo:** ${prompt}\n\n` +
      `**Session:** \`${sessionId}\`\n\n` +
      "Se abrió un nuevo chat en Brain mode con el protocolo de loop.\n",
  );

  return { metadata: { loopStarted: true, sessionId } };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function resolveGoal(sessionId: string): string {
  const active = getAllLoopStates().get(sessionId);
  if (active?.goal) return active.goal;

  const persisted = getAllPersistedSessions()[sessionId];
  if (persisted?.goal) return persisted.goal;

  return "Reconnected loop session";
}

function buildLoopPickItems(): LoopPickItem[] {
  const items: LoopPickItem[] = [];
  const seen = new Set<string>();

  // 1. Active/spawning loops (in-memory)
  for (const [sid, state] of getAllLoopStates()) {
    if (state.state === "completed") continue;
    seen.add(sid);
    const icon =
      state.state === "spawning"
        ? "$(loading~spin)"
        : state.state === "awaiting"
          ? "$(bell)"
          : "$(play)";
    items.push({
      label: `${icon} ${sid.substring(0, 8)}...`,
      description: `[${state.state}] ${state.goal ?? ""}`.substring(0, 80),
      detail: state.startedAt
        ? `Iniciado: ${new Date(state.startedAt).toLocaleString()} | Rondas: ${state.iterations.length}`
        : undefined,
      sessionId: sid,
      goal: state.goal ?? "Loop session",
      loopKind: state.state === "spawning" ? "spawning" : "active",
    });
  }

  // 2. Persisted but not live (interrupted)
  for (const [sid, session] of Object.entries(getAllPersistedSessions())) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    items.push({
      label: `$(warning) ${sid.substring(0, 8)}...`,
      description: `[interrumpido] ${session.goal ?? ""}`.substring(0, 80),
      detail: `Rondas: ${session.iterationCount} | Persistido: ${new Date(session.persistedAt).toLocaleString()}`,
      sessionId: sid,
      goal: session.goal ?? "Interrupted loop",
      loopKind: "interrupted",
    });
  }

  // 3. Hibernated loops (filesystem)
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (repoRoot) {
    for (const h of listHibernatedLoops(repoRoot)) {
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      items.push({
        label: `$(archive) ${h.sessionId.substring(0, 8)}...`,
        description: `[hibernado] ${h.goal}`.substring(0, 80),
        detail: `Ronda: ${h.currentRound} | Hibernado: ${new Date(h.hibernatedAt).toLocaleString()}`,
        sessionId: h.sessionId,
        goal: h.goal,
        loopKind: "hibernated",
      });
    }
  }

  return items;
}
