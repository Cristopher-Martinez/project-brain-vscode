import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getLoopDir } from "./brain-paths.mjs";

const LOOP_LEDGER_FILENAME = "loop-ledger.json";

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function truncate(value, max) {
  if (!value) return "";
  return value.length <= max ? value : value.slice(0, max);
}

function getToolPattern(sessionId, existing) {
  if (existing?.toolPattern) return existing.toolPattern;
  return `loopAwaitInput({ sessionId: "${sessionId}", synthesis: "..." })`;
}

function normalizeIso() {
  return new Date().toISOString();
}

function snapshot(ledger) {
  return JSON.stringify(ledger);
}

function computeEpoch(previous, next) {
  if (!previous) return 1;
  const prevSnapshot = snapshot({
    state: previous.state,
    sessionId: previous.sessionId,
    goalDigest: previous.goalDigest,
    requiredTool: previous.requiredTool,
    toolPattern: previous.toolPattern,
    responseMode: previous.responseMode,
    round: previous.round,
    checkpoint: previous.checkpoint,
    pendingToolCall: previous.pendingToolCall,
  });
  return prevSnapshot === snapshot(next) ? previous.epoch : previous.epoch + 1;
}

export function getLoopLedgerPath(cwd, sessionId) {
  return join(getLoopDir(cwd, sessionId), LOOP_LEDGER_FILENAME);
}

export function readLoopLedger(cwd, sessionId) {
  try {
    const fp = getLoopLedgerPath(cwd, sessionId);
    if (!existsSync(fp)) return null;
    return JSON.parse(stripBom(readFileSync(fp, "utf8")));
  } catch {
    return null;
  }
}

export function writeLoopLedger(cwd, sessionId, ledger) {
  try {
    const fp = getLoopLedgerPath(cwd, sessionId);
    const dir = dirname(fp);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fp, JSON.stringify(ledger, null, 2), "utf8");
    return ledger;
  } catch {
    return null;
  }
}

export function setLoopLedgerPendingToolCall(cwd, sessionId, pendingToolCall) {
  const previous = readLoopLedger(cwd, sessionId);
  const nextBase = {
    state: previous?.state || "ACTIVE",
    sessionId,
    goalDigest: truncate(previous?.goalDigest || "", 140),
    requiredTool: previous?.requiredTool || "loopAwaitInput",
    toolPattern: getToolPattern(sessionId, previous),
    responseMode: previous?.responseMode || "TOOL_ONLY",
    round: typeof previous?.round === "number" ? previous.round : 0,
    checkpoint: truncate(previous?.checkpoint || "", 240),
    pendingToolCall,
  };

  return writeLoopLedger(cwd, sessionId, {
    ...nextBase,
    epoch: computeEpoch(previous, nextBase),
    updatedAt: normalizeIso(),
  });
}