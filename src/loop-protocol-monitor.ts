import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";
import { readLoopLedger } from "./loop-ledger";

const LOOP_PROTOCOL_MONITOR_FILENAME = "loop-protocol-monitor.json";
const MAX_RECENT_VIOLATIONS = 10;

export type LoopProtocolOperatorAction = "resumeDisconnectedLoop" | "endLoop";

export type LoopProtocolViolationCode =
  | "COMPLIANCE_WARN"
  | "COMPLIANCE_NUDGE"
  | "EMPTY_SYNTHESIS"
  | "GATE_BLOCKED"
  | "LOOP_END_BLOCKED"
  | "SESSION_LOST"
  | "WRONG_SESSION_ID";

export interface LoopProtocolViolation {
  code: LoopProtocolViolationCode;
  severity: "warn" | "error";
  message: string;
  occurredAt: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface LoopProtocolViolationInput {
  code: LoopProtocolViolationCode;
  severity: "warn" | "error";
  message: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}

export interface LoopProtocolMonitorSnapshot {
  mode: "monitor-only" | "repair-blocking";
  sessionId: string;
  status: "healthy" | "warning" | "degraded";
  totalViolations: number;
  consecutiveViolations: number;
  lastHealthyAt?: string;
  lastViolation?: LoopProtocolViolation;
  recentViolations: LoopProtocolViolation[];
  repair?: {
    attempts: number;
    maxAttempts: number;
    lastAttemptAt: string;
    lastReason: string;
    blocking: boolean;
    recommendedAction: LoopProtocolOperatorAction;
    checkpoint?: string;
  };
  updatedAt: string;
}

export interface LoopProtocolRepairAttemptInput {
  reason: string;
  maxAttempts?: number;
  recommendedAction?: LoopProtocolOperatorAction;
}

function getRepoRoot(repoRoot?: string): string | null {
  if (repoRoot) return repoRoot;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeDetails(
  details?: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;

  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries) as Record<
    string,
    string | number | boolean | null
  >;
}

function buildDefaultSnapshot(sessionId: string): LoopProtocolMonitorSnapshot {
  return {
    mode: "monitor-only",
    sessionId,
    status: "healthy",
    totalViolations: 0,
    consecutiveViolations: 0,
    recentViolations: [],
    updatedAt: nowIso(),
  };
}

function deriveStatus(
  severity: LoopProtocolViolation["severity"] | undefined,
  consecutiveViolations: number,
  blockingRepair?: boolean,
): LoopProtocolMonitorSnapshot["status"] {
  if (blockingRepair) return "degraded";
  if (severity === "error") return "degraded";
  if (consecutiveViolations >= 3) return "degraded";
  if (consecutiveViolations > 0) return "warning";
  return "healthy";
}

function deriveRepairCheckpoint(
  sessionId: string,
  repoRoot?: string,
  previous?: LoopProtocolMonitorSnapshot,
): string | undefined {
  const checkpoint = readLoopLedger(sessionId, repoRoot)?.checkpoint?.trim();
  if (checkpoint) return checkpoint;
  return previous?.repair?.checkpoint;
}

export function getLoopProtocolMonitorPath(
  sessionId: string,
  repoRoot?: string,
): string | null {
  const root = getRepoRoot(repoRoot);
  if (!root) return null;
  return path.join(
    getLoopDir(root, sessionId),
    LOOP_PROTOCOL_MONITOR_FILENAME,
  );
}

export function readLoopProtocolMonitor(
  sessionId: string,
  repoRoot?: string,
): LoopProtocolMonitorSnapshot | null {
  try {
    const monitorPath = getLoopProtocolMonitorPath(sessionId, repoRoot);
    if (!monitorPath || !fs.existsSync(monitorPath)) return null;
    return JSON.parse(
      fs.readFileSync(monitorPath, "utf8"),
    ) as LoopProtocolMonitorSnapshot;
  } catch {
    return null;
  }
}

export function writeLoopProtocolMonitor(
  sessionId: string,
  snapshot: LoopProtocolMonitorSnapshot,
  repoRoot?: string,
): LoopProtocolMonitorSnapshot | null {
  try {
    const monitorPath = getLoopProtocolMonitorPath(sessionId, repoRoot);
    if (!monitorPath) return null;

    const dir = path.dirname(monitorPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(monitorPath, JSON.stringify(snapshot, null, 2), "utf8");
    return snapshot;
  } catch {
    return null;
  }
}

export function recordLoopProtocolViolation(
  sessionId: string,
  input: LoopProtocolViolationInput,
  repoRoot?: string,
): LoopProtocolMonitorSnapshot | null {
  const previous = readLoopProtocolMonitor(sessionId, repoRoot) ??
    buildDefaultSnapshot(sessionId);
  const violation: LoopProtocolViolation = {
    code: input.code,
    severity: input.severity,
    message: input.message,
    occurredAt: nowIso(),
    details: sanitizeDetails(input.details),
  };
  const recentViolations = [...previous.recentViolations, violation].slice(
    -MAX_RECENT_VIOLATIONS,
  );
  const consecutiveViolations = previous.consecutiveViolations + 1;
  const snapshot: LoopProtocolMonitorSnapshot = {
    ...previous,
    status: deriveStatus(
      input.severity,
      consecutiveViolations,
      previous.repair?.blocking,
    ),
    totalViolations: previous.totalViolations + 1,
    consecutiveViolations,
    lastViolation: violation,
    recentViolations,
    updatedAt: violation.occurredAt,
  };

  return writeLoopProtocolMonitor(sessionId, snapshot, repoRoot);
}

export function registerLoopProtocolRepairAttempt(
  sessionId: string,
  input: LoopProtocolRepairAttemptInput,
  repoRoot?: string,
): LoopProtocolMonitorSnapshot | null {
  const previous = readLoopProtocolMonitor(sessionId, repoRoot) ??
    buildDefaultSnapshot(sessionId);
  const repairAttemptAt = nowIso();
  const maxAttempts = Math.max(1, input.maxAttempts ?? previous.repair?.maxAttempts ?? 2);
  const attempts = Math.min(
    maxAttempts,
    (previous.repair?.attempts ?? 0) + 1,
  );
  const blocking = attempts >= maxAttempts;
  const snapshot: LoopProtocolMonitorSnapshot = {
    ...previous,
    mode: "repair-blocking",
    status: blocking ? "degraded" : "warning",
    repair: {
      attempts,
      maxAttempts,
      lastAttemptAt: repairAttemptAt,
      lastReason: input.reason,
      blocking,
      recommendedAction:
        input.recommendedAction ?? previous.repair?.recommendedAction ?? "resumeDisconnectedLoop",
      checkpoint: deriveRepairCheckpoint(sessionId, repoRoot, previous),
    },
    updatedAt: repairAttemptAt,
  };

  return writeLoopProtocolMonitor(sessionId, snapshot, repoRoot);
}

export function recordLoopProtocolSuccess(
  sessionId: string,
  repoRoot?: string,
): LoopProtocolMonitorSnapshot | null {
  const previous = readLoopProtocolMonitor(sessionId, repoRoot) ??
    buildDefaultSnapshot(sessionId);
  const healthyAt = nowIso();
  const snapshot: LoopProtocolMonitorSnapshot = {
    ...previous,
    mode: "monitor-only",
    status: "healthy",
    consecutiveViolations: 0,
    lastHealthyAt: healthyAt,
    repair: undefined,
    updatedAt: healthyAt,
  };

  return writeLoopProtocolMonitor(sessionId, snapshot, repoRoot);
}