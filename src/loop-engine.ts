/**
 * Loop Engine — Multi-session feedback loop state management.
 * Brain HQ subscribes to EventEmitter for live UI updates.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { readAuditState, readCommitState } from "./commit-session-ops";
import { log } from "./logger";
import {
  createLoopConfig,
  incrementLoopIterations,
  readLoopConfig,
  updateLoopConfig,
} from "./loop-config";
import type { HistoryIteration } from "./loop-history";
import {
  appendIteration as appendHistoryIteration,
  initLoopHistory,
  updateLastIterationFeedback,
} from "./loop-history";
import {
  clearSessionMessages,
  getSessionMessages,
  sendMessage,
} from "./loop-mailbox";
import type { PersistedIteration } from "./loop-persistence";
import {
  buildReconnectSummary,
  clearPersistedSession,
  getAllPersistedSessions,
  getPersistedSession,
  initLoopPersistence,
  persistLoopSession,
} from "./loop-persistence";
import {
  removeActiveLoopSignal,
  updateLoopHeartbeat,
  writeActiveLoopSignal,
} from "./loop-signal";
import { syncLoopLedger } from "./loop-ledger";
import {
  readLoopProtocolMonitor,
  recordLoopProtocolSuccess,
  recordLoopProtocolViolation,
} from "./loop-protocol-monitor";
import type { LoopProtocolMonitorSnapshot } from "./loop-protocol-monitor";
import {
  buildComplianceWatchdogPlan,
  COMPLIANCE_BUSY_GRACE_MS,
  COMPLIANCE_MAILBOX_REMINDER_INTERVAL_MS,
  COMPLIANCE_WATCHDOG_SENDER_ID,
  COMPLIANCE_WATCHDOG_IGNORE_LABEL,
  buildComplianceMailboxReminder,
  shouldSuppressComplianceWarn,
} from "./loop-compliance-watchdog";

/** Heartbeat interval per session — keeps signal files fresh for hook staleness detection. */
const heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function startHeartbeat(sessionId: string): void {
  stopHeartbeat(sessionId); // clear any existing
  const timer = setInterval(
    () => updateLoopHeartbeat(sessionId),
    HEARTBEAT_INTERVAL_MS,
  );
  heartbeatIntervals.set(sessionId, timer);
}

function stopHeartbeat(sessionId: string): void {
  const timer = heartbeatIntervals.get(sessionId);
  if (timer) {
    clearInterval(timer);
    heartbeatIntervals.delete(sessionId);
  }
}

/** Stop ALL heartbeat intervals — called during extension deactivation. */
export function stopAllHeartbeats(): void {
  for (const [sid, timer] of heartbeatIntervals) {
    clearInterval(timer);
    log(
      `[LoopEngine] Stopped heartbeat for ${sid.substring(0, 8)} (deactivate)`,
    );
  }
  heartbeatIntervals.clear();
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LoopIteration {
  index: number;
  prompt: string;
  synthesis?: string;
  feedback?: string;
  /** Number of images attached in this iteration's feedback */
  imageCount?: number;
  startedAt: number;
  completedAt?: number;
}

export interface LoopUiState {
  sessionId: string | null;
  state:
    | "idle"
    | "spawning"
    | "active"
    | "awaiting"
    | "completed"
    | "disconnected";
  goal?: string;
  iterations: LoopIteration[];
  currentIteration?: LoopIteration;
  startedAt?: number;
  updatedAt: number;
  pendingSynthesis?: string;
  awaitingFeedback: boolean;
  branchIsolation?: {
    branchName: string;
    originalBranch: string;
    status: "active" | "completed" | "merged" | "discarded";
  };
  /** Whether commit-gate bypass is active */
  commitBypass?: boolean;
  /** Whether audit-gate bypass is active */
  auditBypass?: boolean;
  /** Max cycles before automatic migration (per-loop override) */
  maxCycles?: number;
  /** Current loop iteration count (synced from config file) */
  currentLoopIterations?: number;
  /** Runtime monitor for zero-trust loop protocol violations */
  protocolMonitor?: LoopProtocolMonitorSnapshot;
}

interface FeedbackEntry {
  resolve: (feedback: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const COMPLIANCE_BASE_MS = 90 * 1000; // 90 seconds — initial warn delay
const COMPLIANCE_MAX_MS = 12 * 60 * 1000; // 12 minutes — backoff cap
const CHECKPOINT_FILENAME = "execution-checkpoint.json";
const FEEDBACK_WAIT_PLACEHOLDER_MS = 2 ** 31 - 1;

// ─── State Maps + Emitter ───────────────────────────────────────────────────────────

const loopStates = new Map<string, LoopUiState>();
const loopSessionOpens = new Map<string, boolean>();
const feedbackResolvers = new Map<string, FeedbackEntry>();
const iterationCounters = new Map<string, number>();

/** Compliance watchdog timers per session */
interface ComplianceTimers {
  warn: ReturnType<typeof setTimeout>;
  mailbox?: ReturnType<typeof setInterval>;
  nudge?: ReturnType<typeof setTimeout>;
  currentDelay: number;
  nudgeCount: number;
  startedAt: number;
}
const complianceTimers = new Map<string, ComplianceTimers>();

/** Tracks last tool call timestamp per session (INC-04: activity detection) */
const lastToolCallTimestamp = new Map<string, number>();

/** Disconnect watchdog: auto-marks loop as disconnected after prolonged inactivity */
const DISCONNECT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Call this when the agent makes a tool call to signal activity. */
export function recordToolCallActivity(sessionId: string): void {
  lastToolCallTimestamp.set(sessionId, Date.now());
}

function startDisconnectWatchdog(sessionId: string): void {
  clearDisconnectWatchdog(sessionId);
  disconnectTimers.set(
    sessionId,
    setTimeout(() => {
      const state = loopStates.get(sessionId);
      if (!state || state.state !== "active") return;
      const lastActivity = lastToolCallTimestamp.get(sessionId) ?? 0;
      if (
        lastActivity > 0 &&
        Date.now() - lastActivity < DISCONNECT_THRESHOLD_MS
      ) {
        startDisconnectWatchdog(sessionId);
        return;
      }
      log(
        `[LoopEngine] DISCONNECT AUTO — no agent activity for 30min (${sessionId.substring(0, 8)})`,
      );
      markLoopDisconnected(sessionId);
    }, DISCONNECT_THRESHOLD_MS),
  );
}

function clearDisconnectWatchdog(sessionId: string): void {
  const timer = disconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(sessionId);
  }
}

const loopEmitter = new vscode.EventEmitter<LoopUiState>();
export const onDidChangeLoopState = loopEmitter.event;

function defaultState(): LoopUiState {
  return {
    sessionId: null,
    state: "idle",
    iterations: [],
    updatedAt: Date.now(),
    awaitingFeedback: false,
  };
}

export function getLoopState(sessionId: string): LoopUiState {
  const state = loopStates.get(sessionId);
  if (!state) return defaultState();

  const protocolMonitor = readLoopProtocolMonitor(sessionId) ?? state.protocolMonitor;
  if (!protocolMonitor || state.protocolMonitor === protocolMonitor) {
    return state;
  }

  const enriched = { ...state, protocolMonitor };
  loopStates.set(sessionId, enriched);
  return enriched;
}

export function getAllLoopStates(): Map<string, LoopUiState> {
  return loopStates;
}

function setState(sessionId: string, next: LoopUiState): void {
  const protocolMonitor = next.sessionId
    ? next.protocolMonitor ?? readLoopProtocolMonitor(sessionId) ?? undefined
    : undefined;
  const enriched = protocolMonitor ? { ...next, protocolMonitor } : next;
  loopStates.set(sessionId, enriched);
  syncLoopLedger(sessionId, enriched);
  loopEmitter.fire(enriched);
}

export function setLoopProtocolMonitor(
  sessionId: string,
  protocolMonitor?: LoopProtocolMonitorSnapshot,
): void {
  const current = loopStates.get(sessionId);
  if (!current) return;

  setState(sessionId, {
    ...current,
    protocolMonitor,
    updatedAt: Date.now(),
  });
}

/** Update commitBypass on the in-memory LoopUiState so it survives all state transitions. */
export function loopSetCommitBypass(sessionId: string, enabled: boolean): void {
  const current = loopStates.get(sessionId);
  if (!current) return;
  current.commitBypass = enabled;
  setState(sessionId, current);
  updateLoopConfig(sessionId, { commitBypass: enabled });
  log(`[LoopEngine] commitBypass set to ${enabled} for session ${sessionId}`);
}

/** Update auditBypass on the in-memory LoopUiState so it survives all state transitions. */
export function loopSetAuditBypass(sessionId: string, enabled: boolean): void {
  const current = loopStates.get(sessionId);
  if (!current) return;
  current.auditBypass = enabled;
  setState(sessionId, current);
  updateLoopConfig(sessionId, { auditBypass: enabled });
  log(`[LoopEngine] auditBypass set to ${enabled} for session ${sessionId}`);
}

/**
 * Persist full loop state to workspaceState for lossless reconnect.
 * Returns a Promise so critical paths (loopStart) can await guaranteed write.
 */
function persistCurrentState(sessionId: string): Promise<void> {
  const state = loopStates.get(sessionId);
  if (!state || state.state === "idle" || state.state === "completed") {
    return Promise.resolve();
  }
  const iterations: PersistedIteration[] = state.iterations.map((i) => ({
    index: i.index,
    prompt: i.prompt,
    synthesis: i.synthesis,
    feedback: i.feedback,
    startedAt: i.startedAt,
    completedAt: i.completedAt,
  }));
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return persistLoopSession({
    sessionId,
    goal: state.goal || "",
    iterationCount: iterationCounters.get(sessionId) || 0,
    startedAt: state.startedAt || Date.now(),
    persistedAt: Date.now(),
    iterations,
    state: state.state,
    pendingSynthesis: state.pendingSynthesis,
    awaitingFeedback: state.awaitingFeedback,
    maxCycles: state.maxCycles,
    wsRoot: wsRoot || undefined,
  });
}

// ─── Filesystem Checkpoint (crash recovery) ─────────────────────────────────

/** Get the checkpoint file path for the workspace, or null if no workspace. */
function getCheckpointPath(): string | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  const config = vscode.workspace.getConfiguration("projectBrain");
  const memFolder = config.get<string>("memoryFolder", ".project-brain/memory");
  return path.join(root, memFolder, "sessions", CHECKPOINT_FILENAME);
}

/**
 * Write execution checkpoint to disk. Survives crashes — the session-start
 * hook reads stale checkpoints and injects crash-recovery context.
 */
function writeCheckpointToFs(sessionId: string, synthesis?: string): void {
  try {
    const cpPath = getCheckpointPath();
    if (!cpPath) return;
    const dir = path.dirname(cpPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const state = loopStates.get(sessionId);
    if (!state) return;

    const checkpoint = {
      sessionId,
      goal: state.goal || "",
      lastSynthesis: synthesis || state.pendingSynthesis || "",
      iterations: state.iterations.slice(-5).map((i) => ({
        index: i.index,
        synthesis: (i.synthesis || "").slice(0, 500),
        feedback: (i.feedback || "").slice(0, 300),
      })),
      startedAt: state.startedAt
        ? new Date(state.startedAt).toISOString()
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in-progress",
    };
    fs.writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2), "utf8");
  } catch {
    /* non-fatal — best effort */
  }
}

/** Remove the checkpoint file (clean exit). */
function clearCheckpointFromFs(): void {
  try {
    const cpPath = getCheckpointPath();
    if (cpPath && fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  } catch {
    /* non-fatal */
  }
}

/** Clean up mailbox messages for a session. Best-effort, non-fatal. */
function cleanupMailbox(sessionId: string): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    try {
      clearSessionMessages(root, sessionId);
    } catch {
      /* non-fatal — TTL will prune eventually */
    }
  }
}

// ─── State Mutators ─────────────────────────────────────────────────────────

/** Optimistic state — HQ handler calls this BEFORE the agent connects. */
export function loopSpawn(sessionId: string, goal: string): void {
  log(
    `[LoopEngine] loopSpawn sessionId=${sessionId} goal="${goal.substring(0, 60)}"`,
  );
  // Create per-session config + history on spawn (earliest reliable entry point)
  const config = createLoopConfig(sessionId, goal);
  initLoopHistory(sessionId, goal);
  // Config file is source of truth; fallback to VS Code settings
  const spawnDefault = vscode.workspace
    .getConfiguration("projectBrain")
    .get<number>("loop.maxCycles", 15);
  const effectiveMax = config?.maxCycles ?? spawnDefault;
  setState(sessionId, {
    sessionId,
    state: "spawning",
    goal,
    iterations: [],
    currentIteration: undefined,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    awaitingFeedback: false,
    maxCycles: effectiveMax,
    currentLoopIterations: config?.currentLoopIterations ?? 0,
  });
  // Persist spawning state so it survives extension reload
  persistCurrentState(sessionId);
}

export async function loopStart(
  sessionId: string,
  goal: string,
): Promise<void> {
  iterationCounters.set(sessionId, 0);
  log(
    `[LoopEngine] loopStart sessionId=${sessionId} goal="${goal.substring(0, 60)}"`,
  );
  const maxCycles = vscode.workspace
    .getConfiguration("projectBrain")
    .get<number>("loop.maxCycles", 15);
  // Create per-session config + history files (idempotent, disk-first)
  const config = createLoopConfig(sessionId, goal);
  initLoopHistory(sessionId, goal);
  // Config file is source of truth for maxCycles; fallback to VS Code settings
  const effectiveMaxCycles = config?.maxCycles ?? maxCycles;

  setState(sessionId, {
    sessionId,
    state: "active",
    goal,
    iterations: [],
    currentIteration: undefined,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    awaitingFeedback: false,
    maxCycles: effectiveMaxCycles,
    currentLoopIterations: config?.currentLoopIterations ?? 0,
  });
  // Await persistence to guarantee session survives extension reload
  await persistCurrentState(sessionId);
  // Write signal file FIRST, then start heartbeat (heartbeat needs signal file to exist)
  writeActiveLoopSignal(sessionId, goal);
  startHeartbeat(sessionId);
  startDisconnectWatchdog(sessionId);
}

export function loopIterationStart(sessionId: string, prompt: string): number {
  const counter = (iterationCounters.get(sessionId) || 0) + 1;
  iterationCounters.set(sessionId, counter);
  const iteration: LoopIteration = {
    index: counter,
    prompt,
    startedAt: Date.now(),
  };
  const current = loopStates.get(sessionId) || defaultState();
  log(
    `[LoopEngine] iterationStart sessionId=${sessionId} iteration=${counter}`,
  );
  setState(sessionId, {
    ...current,
    state: "active",
    currentIteration: iteration,
    updatedAt: Date.now(),
    awaitingFeedback: false,
  });
  persistCurrentState(sessionId);
  return counter;
}

export function loopIterationComplete(
  sessionId: string,
  synthesis?: string,
): void {
  const current = loopStates.get(sessionId);
  if (!current?.currentIteration) {
    log(
      `[LoopEngine] iterationComplete SKIP — no currentIteration for sessionId=${sessionId}`,
    );
    return;
  }
  const completed: LoopIteration = {
    ...current.currentIteration,
    synthesis,
    completedAt: Date.now(),
  };
  log(
    `[LoopEngine] iterationComplete sessionId=${sessionId} idx=${completed.index}`,
  );
  setState(sessionId, {
    ...current,
    state: "awaiting",
    currentIteration: undefined,
    iterations: [...current.iterations, completed],
    updatedAt: Date.now(),
  });
  persistCurrentState(sessionId);

  // Append to per-session history.json
  const histEntry: HistoryIteration = {
    index: completed.index,
    prompt: completed.prompt,
    synthesis: completed.synthesis,
    feedback: completed.feedback,
    imageCount: completed.imageCount,
    startedAt: new Date(completed.startedAt).toISOString(),
    completedAt: completed.completedAt
      ? new Date(completed.completedAt).toISOString()
      : undefined,
  };
  appendHistoryIteration(sessionId, histEntry);

  // Increment currentLoopIterations in config file (source of truth for migration)
  const newCount = incrementLoopIterations(sessionId);
  // Sync to in-memory state so webview shows the correct count
  if (newCount > 0) {
    const s = loopStates.get(sessionId);
    if (s) {
      setState(sessionId, { ...s, currentLoopIterations: newCount });
    }
  }
}

export function loopEnd(sessionId: string, signal?: string): void {
  log(
    `[LoopEngine] loopEnd sessionId=${sessionId} signal=${signal || "__LOOP_ENDED__"}`,
  );
  clearFeedback(sessionId, signal || "__LOOP_ENDED__");
  clearComplianceTimers(sessionId);
  clearDisconnectWatchdog(sessionId);
  stopHeartbeat(sessionId);
  removeActiveLoopSignal(sessionId);
  cleanupMailbox(sessionId);
  clearPersistedSession(sessionId);
  clearCheckpointFromFs();
  const current = loopStates.get(sessionId) || defaultState();
  setState(sessionId, {
    ...current,
    state: "completed",
    updatedAt: Date.now(),
    awaitingFeedback: false,
    pendingSynthesis: undefined,
  });
}

/** Mark a loop as disconnected (chat session lost). Keeps state in memory for Resume. */
export function markLoopDisconnected(sessionId: string): void {
  const current = loopStates.get(sessionId);
  if (!current) return;
  stopHeartbeat(sessionId);
  clearDisconnectWatchdog(sessionId);
  clearComplianceTimers(sessionId);
  removeActiveLoopSignal(sessionId);
  setState(sessionId, {
    ...current,
    state: "disconnected",
    awaitingFeedback: false,
    updatedAt: Date.now(),
  });
  void persistCurrentState(sessionId);
  log(`[LoopEngine] Loop marked disconnected: ${sessionId.substring(0, 8)}`);
}

export function loopReset(sessionId: string): void {
  log(`[LoopEngine] loopReset sessionId=${sessionId}`);
  clearFeedback(sessionId, "__LOOP_ENDED__");
  clearComplianceTimers(sessionId);
  clearDisconnectWatchdog(sessionId);
  stopHeartbeat(sessionId);
  removeActiveLoopSignal(sessionId);
  cleanupMailbox(sessionId);
  clearPersistedSession(sessionId);
  clearCheckpointFromFs();
  iterationCounters.delete(sessionId);
  setState(sessionId, {
    sessionId: null,
    state: "idle",
    iterations: [],
    updatedAt: Date.now(),
    awaitingFeedback: false,
  });
  loopStates.delete(sessionId);
  loopSessionOpens.delete(sessionId);
}

/**
 * Cleanup loop state from memory after hibernation.
 * Does NOT clear persistence or mailbox — those are needed for resume.
 */
export function cleanupLoopSessionMemory(sessionId: string): void {
  // Stop heartbeat interval to prevent zombie signal writes
  stopHeartbeat(sessionId);
  // Signal final state to webview (session goes idle)
  setState(sessionId, {
    sessionId: null,
    state: "idle",
    iterations: [],
    updatedAt: Date.now(),
    awaitingFeedback: false,
  });
  // Remove from active loops map
  loopStates.delete(sessionId);
  loopSessionOpens.delete(sessionId);
  iterationCounters.delete(sessionId);
}

// ─── Max Cycles ─────────────────────────────────────────────────────────────

export function setLoopMaxCycles(sessionId: string, maxCycles: number): void {
  const current = loopStates.get(sessionId) || defaultState();
  setState(sessionId, { ...current, maxCycles, updatedAt: Date.now() });
  // Persist to config file (single source of truth)
  updateLoopConfig(sessionId, { maxCycles });
  log(
    `[LoopEngine] setMaxCycles sessionId=${sessionId} maxCycles=${maxCycles}`,
  );
}

// ─── Session gate (per session) ─────────────────────────────────────────────

export function isLoopSessionOpen(sessionId: string): boolean {
  return loopSessionOpens.get(sessionId) ?? false;
}

export function setLoopSessionOpen(sessionId: string, open: boolean): void {
  log(`[LoopEngine] setLoopSessionOpen sessionId=${sessionId} open=${open}`);
  loopSessionOpens.set(sessionId, open);
}

// ─── Feedback Loop (wait indefinitely for user feedback) ────────────────────

function clearFeedback(sessionId: string, resolveWith?: string): void {
  const entry = feedbackResolvers.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    feedbackResolvers.delete(sessionId);
    if (resolveWith !== undefined) {
      entry.resolve(resolveWith);
    }
  }
}

export function loopWaitForFeedback(
  sessionId: string,
  synthesis: string,
): Promise<string> {
  // Agent called loopAwaitInput — compliance achieved, cancel watchdogs
  clearComplianceTimers(sessionId);
  clearDisconnectWatchdog(sessionId);

  const current = loopStates.get(sessionId) || defaultState();
  const protocolMonitor = recordLoopProtocolSuccess(sessionId) ??
    current.protocolMonitor;
  log(`[LoopEngine] waitForFeedback sessionId=${sessionId}`);
  setState(sessionId, {
    ...current,
    state: "awaiting",
    pendingSynthesis: synthesis,
    awaitingFeedback: true,
    protocolMonitor,
    updatedAt: Date.now(),
  });
  persistCurrentState(sessionId);

  // Crash recovery: write checkpoint to filesystem so session-start hook
  // can inject it if this session dies before clean exit.
  writeCheckpointToFs(sessionId, synthesis);

  // Clear any existing resolver for this session
  clearFeedback(sessionId);

  return new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => {
        /* intentionally never fires */
      },
      FEEDBACK_WAIT_PLACEHOLDER_MS,
    );

    feedbackResolvers.set(sessionId, { resolve, timer });
  });
}

export function loopSendFeedback(
  sessionId: string,
  feedback: string,
  imageCount?: number,
): void {
  const entry = feedbackResolvers.get(sessionId);
  if (!entry) {
    log(
      `[LoopEngine] sendFeedback SKIP — no pending resolver for sessionId=${sessionId}`,
    );
    return;
  }

  clearTimeout(entry.timer);
  feedbackResolvers.delete(sessionId);
  log(
    `[LoopEngine] sendFeedback sessionId=${sessionId} feedback="${feedback.substring(0, 60)}" images=${imageCount ?? 0}`,
  );

  const current = loopStates.get(sessionId) || defaultState();
  setState(sessionId, {
    ...current,
    state: "active", // Agent is now processing feedback
    pendingSynthesis: undefined,
    awaitingFeedback: false,
    updatedAt: Date.now(),
  });

  // Record feedback + imageCount in the last iteration
  const updated = loopStates.get(sessionId) || defaultState();
  if (updated.iterations.length > 0) {
    const last = updated.iterations[updated.iterations.length - 1];
    const withFb = {
      ...last,
      feedback,
      ...(imageCount ? { imageCount } : {}),
    };
    setState(sessionId, {
      ...updated,
      iterations: [...updated.iterations.slice(0, -1), withFb],
      updatedAt: Date.now(),
    });
  }
  persistCurrentState(sessionId);

  // Update feedback in per-session history.json
  updateLastIterationFeedback(sessionId, feedback, imageCount);

  entry.resolve(feedback);

  // Start compliance watchdog — agent should call loopAwaitInput within 90s
  startComplianceWatchdog(sessionId);
  startDisconnectWatchdog(sessionId);
}

export function loopHasPendingFeedback(sessionId: string): boolean {
  return feedbackResolvers.has(sessionId);
}

export function hasActiveLoop(sessionId: string): boolean {
  const state = loopStates.get(sessionId);
  if (!state) return false;
  return (
    state.sessionId !== null &&
    state.state !== "completed" &&
    state.state !== "idle"
  );
}

/** Check if session was pre-spawned from HQ (optimistic state). */
export function isSpawningLoop(sessionId: string): boolean {
  const state = loopStates.get(sessionId);
  return state?.state === "spawning";
}

// ─── Compliance Watchdog ────────────────────────────────────────────────────
// Detects when agent forgets to call loopAwaitInput after receiving feedback.

function clearComplianceTimers(sessionId: string): void {
  const timers = complianceTimers.get(sessionId);
  if (timers) {
    clearTimeout(timers.warn);
    if (timers.mailbox) clearInterval(timers.mailbox);
    if (timers.nudge) clearTimeout(timers.nudge);
    complianceTimers.delete(sessionId);
  }
  lastToolCallTimestamp.delete(sessionId);
}

function hasUnreadWatchdogReminder(repoRoot: string, sessionId: string): boolean {
  return getSessionMessages(repoRoot, sessionId, 20).some(
    (message) =>
      message.from === COMPLIANCE_WATCHDOG_SENDER_ID &&
      message.to === sessionId &&
      !message.read &&
      (!message.status || message.status === "active"),
  );
}

function enqueueComplianceMailboxReminder(sessionId: string): void {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) return;
  if (hasUnreadWatchdogReminder(repoRoot, sessionId)) return;

  sendMessage(
    repoRoot,
    COMPLIANCE_WATCHDOG_SENDER_ID,
    sessionId,
    "warning",
    buildComplianceMailboxReminder(sessionId),
  );
  log(
    `[LoopEngine] COMPLIANCE MAILBOX reminder queued for ${sessionId.substring(0, 8)}`,
  );
}

async function reopenLoopChatFromWatchdog(sessionId: string): Promise<void> {
  const current = loopStates.get(sessionId);
  const goal = current?.goal ?? "Interactive feedback loop session";

  setLoopSessionOpen(sessionId, true);
  recordToolCallActivity(sessionId);

  try {
    await vscode.commands.executeCommand(
      "projectBrain.launchLoopSession",
      sessionId,
      goal,
    );
    log(
      `[LoopEngine] COMPLIANCE RECOVERY — relaunched loop chat ${sessionId.substring(0, 8)}`,
    );
    return;
  } catch (err) {
    log(
      `[LoopEngine] COMPLIANCE RECOVERY failed to relaunch ${sessionId.substring(0, 8)}: ${err}`,
    );
  }

  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query:
        `LOOP_SESSION [sessionId=${sessionId}]\n\n` +
        `**Objetivo:** ${goal}\n\n` +
        "Tu loop sigue activo. Reanuda el trabajo y termina por loopAwaitInput.",
    });
  } catch (err) {
    log(
      `[LoopEngine] COMPLIANCE RECOVERY fallback failed for ${sessionId.substring(0, 8)}: ${err}`,
    );
  }
}

function startComplianceWatchdog(sessionId: string): void {
  clearComplianceTimers(sessionId);

  const state: ComplianceTimers = {
    warn: undefined!,
    mailbox: undefined,
    currentDelay: COMPLIANCE_BASE_MS,
    nudgeCount: 0,
    startedAt: Date.now(),
  };

  function scheduleWarn(): void {
    const lastActivity = lastToolCallTimestamp.get(sessionId) ?? 0;
    if (
      shouldSuppressComplianceWarn({
        startedAt: state.startedAt,
        now: Date.now(),
        lastActivityAt: lastActivity,
      })
    ) {
      state.currentDelay = COMPLIANCE_BASE_MS; // reset on activity
    }

    state.warn = setTimeout(() => {
      if (!feedbackResolvers.has(sessionId) && hasActiveLoop(sessionId)) {
        const recentActivity = lastToolCallTimestamp.get(sessionId) ?? 0;
        if (
          shouldSuppressComplianceWarn({
            startedAt: state.startedAt,
            now: Date.now(),
            lastActivityAt: recentActivity,
          })
        ) {
          state.currentDelay = COMPLIANCE_BASE_MS;
          const remainingBusyGrace = Math.max(
            0,
            COMPLIANCE_BUSY_GRACE_MS - (Date.now() - state.startedAt),
          );
          if (remainingBusyGrace > COMPLIANCE_BASE_MS) {
            state.currentDelay = Math.min(remainingBusyGrace, COMPLIANCE_MAX_MS);
          }
          scheduleWarn(); // reschedule
          return;
        }

        log(
          `[LoopEngine] COMPLIANCE WARN — agent idle for ${Math.round(state.currentDelay / 1000)}s (${sessionId.substring(0, 8)})`,
        );
        const protocolMonitor = recordLoopProtocolViolation(sessionId, {
          code: "COMPLIANCE_WARN",
          severity: "warn",
          message:
            "El agente siguió activo en loop pero no llamó loopAwaitInput tras recibir feedback.",
          details: {
            delayMs: state.currentDelay,
            nudgeCount: state.nudgeCount,
          },
        });
        if (protocolMonitor) {
          setLoopProtocolMonitor(sessionId, protocolMonitor);
        }

        // Nudge up to 3 times with escalation
        if (state.nudgeCount < 3) {
          state.nudgeCount++;
          scheduleNudge();
        }

        // Exponential backoff
        state.currentDelay = Math.min(
          state.currentDelay * 2,
          COMPLIANCE_MAX_MS,
        );
        scheduleWarn(); // reschedule with backoff
      }
    }, state.currentDelay);
  }

  function scheduleNudge(): void {
    const level = state.nudgeCount;
    const plan = buildComplianceWatchdogPlan(level, sessionId);
    state.nudge = setTimeout(async () => {
      if (!feedbackResolvers.has(sessionId) && hasActiveLoop(sessionId)) {
        log(
          `[LoopEngine] COMPLIANCE NUDGE #${level} for ${sessionId.substring(0, 8)}`,
        );
        const protocolMonitor = recordLoopProtocolViolation(sessionId, {
          code: "COMPLIANCE_NUDGE",
          severity: level >= 3 ? "error" : "warn",
          message:
            level >= 3
              ? "El watchdog agotó los nudges del loop; intervención manual recomendada."
              : "Se envió un recordatorio automático porque el loop quedó sin síntesis.",
          details: { level },
        });
        if (protocolMonitor) {
          setLoopProtocolMonitor(sessionId, protocolMonitor);
        }
        const action = await vscode.window.showWarningMessage(
          plan.warningMessage,
          plan.primaryLabel,
          plan.secondaryLabel,
          COMPLIANCE_WATCHDOG_IGNORE_LABEL,
        );
        if (action === plan.primaryLabel) {
          state.currentDelay = COMPLIANCE_BASE_MS;
          try {
            await reopenLoopChatFromWatchdog(sessionId);
          } catch (err) {
            log(
              `[LoopEngine] Could not reopen loop chat for ${sessionId.substring(0, 8)}: ${err}`,
            );
          }
        } else if (action === plan.secondaryLabel) {
          markLoopDisconnected(sessionId);
        }
      }
    }, COMPLIANCE_BASE_MS * 2);
  }

  state.mailbox = setInterval(() => {
    if (!feedbackResolvers.has(sessionId) && hasActiveLoop(sessionId)) {
      enqueueComplianceMailboxReminder(sessionId);
    }
  }, COMPLIANCE_MAILBOX_REMINDER_INTERVAL_MS);

  scheduleWarn();
  complianceTimers.set(sessionId, state);
}

// ─── Init + Reconnect ─────────────────────────────────────────────────────────────────────

export function initLoopEngine(ctx: import("vscode").ExtensionContext): void {
  initLoopPersistence(ctx.workspaceState);

  // Initialize feedback watchdog with lazy deps (avoids circular imports)

  // ─── Auto-restore: hydrate in-memory Maps from persisted sessions ───
  // This ensures loops survive extension reloads (compile, deploy, crash).
  const persisted = getAllPersistedSessions();
  let restored = 0;
  for (const session of Object.values(persisted)) {
    // Only restore non-completed sessions
    if (session.state === "completed") continue;

    const iterations: LoopIteration[] = (session.iterations ?? []).map((i) => ({
      index: i.index,
      prompt: i.prompt,
      synthesis: i.synthesis,
      feedback: i.feedback,
      startedAt: i.startedAt,
      completedAt: i.completedAt,
    }));

    // After extension restart, agent connection is always lost.
    // Mark non-completed sessions as "disconnected" so user can reconnect.
    iterationCounters.set(session.sessionId, session.iterationCount);
    setState(session.sessionId, {
      sessionId: session.sessionId,
      state: "disconnected",
      goal: session.goal,
      iterations,
      currentIteration: undefined,
      startedAt: session.startedAt,
      updatedAt: Date.now(),
      pendingSynthesis: session.pendingSynthesis,
      awaitingFeedback: false,
      maxCycles: session.maxCycles,
      currentLoopIterations:
        readLoopConfig(session.sessionId)?.currentLoopIterations ?? 0,
    });
    restored++;
  }

  if (restored > 0) {
    log(`[LoopEngine] auto-restored ${restored} session(s) as disconnected (agent connection lost on restart)`);
  }
  log("[LoopEngine] persistence hydrated from workspaceState");
}

/**
 * Restores a lost session (extension restart) from persisted metadata.
 * Now performs LOSSLESS reconnect: full iteration history, pending synthesis,
 * and correct state are restored from workspaceState.
 */
export function loopReconnect(sessionId: string): {
  ok: boolean;
  goal?: string;
  summary?: string;
} {
  const persisted = getPersistedSession(sessionId);
  if (!persisted) {
    log(
      `[LoopEngine] loopReconnect MISS — no persisted session for ${sessionId}`,
    );
    return { ok: false };
  }
  // Restore full iterations (v2) or fallback to empty (v1 compat)
  const iterations: LoopIteration[] = (persisted.iterations ?? []).map((i) => ({
    index: i.index,
    prompt: i.prompt,
    synthesis: i.synthesis,
    feedback: i.feedback,
    startedAt: i.startedAt,
    completedAt: i.completedAt,
  }));

  // Restore correct state — if was awaiting, stay awaiting so UI shows synthesis
  const restoredState = persisted.state === "awaiting" ? "awaiting" : "active";

  iterationCounters.set(sessionId, persisted.iterationCount);
  // Restore commitBypass and auditBypass from state files (persisted on disk)
  let restoredBypass: boolean | undefined;
  let restoredAuditBypass: boolean | undefined;
  try {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const commitState = readCommitState(root, sessionId);
      restoredBypass = commitState?.commitBypass;
      const auditState = readAuditState(root, sessionId);
      restoredAuditBypass = auditState?.auditBypass;
    }
  } catch {
    /* non-fatal */
  }

  setState(sessionId, {
    sessionId,
    state: restoredState,
    goal: persisted.goal,
    iterations,
    currentIteration: undefined,
    startedAt: persisted.startedAt,
    updatedAt: Date.now(),
    pendingSynthesis: persisted.pendingSynthesis,
    awaitingFeedback: persisted.awaitingFeedback ?? false,
    maxCycles: persisted.maxCycles,
    commitBypass: restoredBypass,
    auditBypass: restoredAuditBypass,
    currentLoopIterations:
      readLoopConfig(sessionId)?.currentLoopIterations ?? 0,
  });

  // Re-establish the disk-backed active-loop signal so hooks can keep
  // enforcing loop protocol after reconnects and context compaction.
  writeActiveLoopSignal(sessionId, persisted.goal);
  startHeartbeat(sessionId);
  setLoopSessionOpen(sessionId, true);
  if (restoredState === "active") {
    startDisconnectWatchdog(sessionId);
  }

  const summary = buildReconnectSummary(persisted);
  log(
    `[LoopEngine] loopReconnect OK sessionId=${sessionId} ` +
      `goal="${persisted.goal.substring(0, 60)}" iterations=${iterations.length} state=${restoredState}`,
  );
  return { ok: true, goal: persisted.goal, summary };
}
