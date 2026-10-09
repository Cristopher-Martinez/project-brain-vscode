import {
  registerLoopProtocolRepairAttempt,
  type LoopProtocolMonitorSnapshot,
  type LoopProtocolOperatorAction,
} from "./loop-protocol-monitor";
import { setLoopProtocolMonitor } from "./loop-engine";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface LoopProtocolRepairResult {
  snapshot: LoopProtocolMonitorSnapshot | null;
  attempt: number;
  maxAttempts: number;
  blocking: boolean;
  checkpoint?: string;
}

export interface LoopProtocolRepairMessageOptions {
  title: string;
  summary: string;
  retryInstruction: string;
  blockedInstruction: string;
}

export function attemptLoopProtocolRepair(
  sessionId: string,
  reason: string,
  recommendedAction: LoopProtocolOperatorAction = "resumeDisconnectedLoop",
): LoopProtocolRepairResult {
  const snapshot = registerLoopProtocolRepairAttempt(sessionId, {
    reason,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    recommendedAction,
  });

  if (snapshot) {
    setLoopProtocolMonitor(sessionId, snapshot);
  }

  return {
    snapshot,
    attempt: snapshot?.repair?.attempts ?? 1,
    maxAttempts: snapshot?.repair?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    blocking: snapshot?.repair?.blocking ?? false,
    checkpoint: snapshot?.repair?.checkpoint,
  };
}

export function formatLoopProtocolRepairMessage(
  repair: LoopProtocolRepairResult,
  options: LoopProtocolRepairMessageOptions,
): string {
  const checkpointLine = repair.checkpoint
    ? `\nCheckpoint: ${repair.checkpoint}`
    : "";

  if (repair.blocking) {
    return [
      `🛑 ${options.title}`,
      "",
      options.summary,
      "",
      `Reparación automática agotada (${repair.attempt}/${repair.maxAttempts}).${checkpointLine}`,
      "",
      options.blockedInstruction,
    ].join("\n");
  }

  return [
    `⚠️ ${options.title}`,
    "",
    options.summary,
    "",
    `Reintento guiado ${repair.attempt}/${repair.maxAttempts}.${checkpointLine}`,
    "",
    options.retryInstruction,
  ].join("\n");
}