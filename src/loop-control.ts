/**
 * Loop Control — STRAT-8
 *
 * Pause/Resume + User→Loop urgent messaging.
 *
 * Problem:
 *   User wants to send an urgent message to a running loop, or
 *   pause the loop while composing a long message without killing it.
 *
 * Design:
 *   - Pause/Resume: in-memory Map<sessionId, Promise resolver>
 *     When paused, `loopAwaitInput` blocks on a gate Promise before returning.
 *   - User messages: routed through loop-mailbox with priority="urgent"
 *     and from="user". Feedback injection shows urgent messages FIRST.
 *
 * The gate works like a traffic light:
 *   🟢 Running → gate is open (resolved Promise)
 *   🔴 Paused  → gate is a pending Promise; agent blocks at loopAwaitInput
 *   User unpauses → gate resolves → agent continues
 */

import * as vscode from "vscode";
import { log } from "./logger";
import {
  sendMessage,
  readMessages,
  formatUnreadMessages,
} from "./loop-mailbox";
import type { LoopMessage } from "./loop-mailbox";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LoopControlState = "running" | "paused";

interface PauseGate {
  state: LoopControlState;
  resolve?: () => void;
  promise?: Promise<void>;
  pausedAt?: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

const pauseGates = new Map<string, PauseGate>();

const controlEmitter = new vscode.EventEmitter<{
  sessionId: string;
  state: LoopControlState;
}>();
export const onDidChangeLoopControl = controlEmitter.event;

// ─── Pause / Resume ────────────────────────────────────────────────────────

/**
 * Pause a loop. The agent will block at the next `loopAwaitInput` call
 * until resumed. If already paused, this is a no-op.
 */
export function pauseLoop(sessionId: string): void {
  const existing = pauseGates.get(sessionId);
  if (existing?.state === "paused") {
    log(`[LoopControl] Already paused: ${sessionId.substring(0, 8)}`);
    return;
  }

  let resolveGate: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });

  pauseGates.set(sessionId, {
    state: "paused",
    resolve: resolveGate!,
    promise,
    pausedAt: Date.now(),
  });

  controlEmitter.fire({ sessionId, state: "paused" });
  log(`[LoopControl] ⏸️ PAUSED loop ${sessionId.substring(0, 8)}`);
}

/**
 * Resume a paused loop. The agent unblocks and continues processing.
 */
export function resumeLoop(sessionId: string): void {
  const gate = pauseGates.get(sessionId);
  if (!gate || gate.state !== "paused") {
    log(
      `[LoopControl] Not paused, nothing to resume: ${sessionId.substring(0, 8)}`,
    );
    return;
  }

  const duration = gate.pausedAt ? Date.now() - gate.pausedAt : 0;
  gate.resolve?.();
  pauseGates.set(sessionId, { state: "running" });

  controlEmitter.fire({ sessionId, state: "running" });
  log(
    `[LoopControl] ▶️ RESUMED loop ${sessionId.substring(0, 8)} (paused ${Math.round(duration / 1000)}s)`,
  );
}

/**
 * Toggle pause/resume for a loop session.
 */
export function togglePause(sessionId: string): LoopControlState {
  const gate = pauseGates.get(sessionId);
  if (gate?.state === "paused") {
    resumeLoop(sessionId);
    return "running";
  } else {
    pauseLoop(sessionId);
    return "paused";
  }
}

/**
 * Check if a loop is paused.
 */
export function isLoopPaused(sessionId: string): boolean {
  return pauseGates.get(sessionId)?.state === "paused";
}

/**
 * Wait at the pause gate (called inside loopAwaitInput flow).
 * If the loop is running, returns immediately. If paused, blocks until resumed.
 */
export async function waitAtPauseGate(sessionId: string): Promise<void> {
  const gate = pauseGates.get(sessionId);
  if (!gate || gate.state !== "paused" || !gate.promise) {
    return; // Not paused — pass through
  }

  log(
    `[LoopControl] Agent waiting at pause gate: ${sessionId.substring(0, 8)}`,
  );
  await gate.promise;
  log(
    `[LoopControl] Agent released from pause gate: ${sessionId.substring(0, 8)}`,
  );
}

/**
 * Clean up pause state for a session (called on finalize).
 */
export function cleanupLoopControl(sessionId: string): void {
  const gate = pauseGates.get(sessionId);
  if (gate?.state === "paused") {
    gate.resolve?.(); // Unblock any waiting agent
  }
  pauseGates.delete(sessionId);
}

// ─── User → Loop Messages ──────────────────────────────────────────────────

const USER_SENDER_ID = "__user__";

/**
 * Send an urgent message from the user to a specific loop session.
 * These messages get priority display in the agent's feedback injection.
 */
export function sendUserMessage(
  repoRoot: string,
  targetSessionId: string,
  content: string,
): LoopMessage {
  const msg = sendMessage(
    repoRoot,
    USER_SENDER_ID,
    targetSessionId,
    "warning",
    content,
  );
  log(
    `[LoopControl] 🚨 User → Loop ${targetSessionId.substring(0, 8)}: ${content.substring(0, 80)}`,
  );
  return msg;
}

/**
 * Broadcast an urgent message from the user to ALL active loops.
 */
export function broadcastUserMessage(
  repoRoot: string,
  content: string,
): LoopMessage {
  const msg = sendMessage(repoRoot, USER_SENDER_ID, null, "broadcast", content);
  log(`[LoopControl] 🚨 User → ALL LOOPS: ${content.substring(0, 80)}`);
  return msg;
}

/**
 * Read unread messages for a session, separating user-urgent from regular.
 * Returns { urgent, regular } where urgent are from the user.
 */
export function readMessagesWithPriority(
  repoRoot: string,
  sessionId: string,
): { urgent: LoopMessage[]; regular: LoopMessage[] } {
  const all = readMessages(repoRoot, sessionId);
  const urgent = all.filter((m) => m.from === USER_SENDER_ID);
  const regular = all.filter((m) => m.from !== USER_SENDER_ID);
  return { urgent, regular };
}

/**
 * Format urgent + regular messages for injection into feedback.
 * Urgent messages appear FIRST with a 🚨 prefix.
 * NOW with explicit call-to-action to prevent invisible mailbox.
 */
export function formatPrioritizedMessages(
  urgent: LoopMessage[],
  regular: LoopMessage[],
): string {
  const parts: string[] = [];
  const total = urgent.length + regular.length;

  if (total === 0) {
    return "";
  }

  // Header
  parts.push("");
  parts.push(`📬 MAILBOX — ${total} mensaje(s) pendiente(s):`);

  // Urgent messages (from user) — show first
  if (urgent.length > 0) {
    parts.push("");
    parts.push(`🚨 **URGENTE DEL USUARIO (${urgent.length}):**`);
    for (const m of urgent.slice(0, 3)) {
      parts.push(`  → ${m.content}`);
    }
    parts.push("**PRIORIZA esto sobre lo que estés haciendo.**");
  }

  // Regular messages (from other loops)
  if (regular.length > 0) {
    parts.push("");
    const msgLines = regular.slice(0, 5).map((m, i) => {
      const from = m.from.substring(0, 8);
      const icon = m.type === "warning" ? "⚠️" : m.type === "finding" ? "🔍" : m.type === "question" ? "❓" : m.type === "answer" ? "💬" : m.type === "broadcast" ? "📢" : "🔒";
      return `  ${i + 1}. ${icon} de loop ${from}: "${m.content.substring(0, 120)}"`;
    });
    parts.push(`**Mensajes de otros loops (${regular.length}):**`);
    parts.push(...msgLines);
    if (regular.length > 5) {
      parts.push(`  ... y ${regular.length - 5} más`);
    }
  }

  // Explicit call-to-action
  parts.push("");
  parts.push(`⚙️ **ACCIÓN REQUERIDA ANTES DE CONTINUAR:**`);
  parts.push(`• Para leer/marcar como leído: loopMail({ action: "read" })`);
  parts.push(`• Para responder a un mensaje: loopMail({ action: "reply", targetId: "..." })`);
  parts.push(`• Para enviar a otro loop: loopMail({ action: "send", to: "sessionId", content: "...", type: "finding" })`);
  parts.push("");
  parts.push(`🔴 NO proceses el feedback del usuario hasta revisar el mailbox.`);
  parts.push("");

  return parts.join("\n");
}

/**
 * Check if the user sender ID matches.
 */
export function isUserMessage(msg: LoopMessage): boolean {
  return msg.from === USER_SENDER_ID;
}
