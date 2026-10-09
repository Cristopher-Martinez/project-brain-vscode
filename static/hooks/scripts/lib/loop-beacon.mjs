import { readLoopLedger } from "./loop-ledger.mjs";

function truncate(value, max) {
  if (!value) return "";
  return value.length <= max ? value : value.slice(0, max);
}

function buildFallbackLedger(sessionId, fallback = {}) {
  const state = fallback.state || "ACTIVE";
  const requiredTool = fallback.requiredTool || "loopAwaitInput";
  return {
    state,
    sessionId,
    goalDigest: truncate(fallback.goal || fallback.goalDigest || "", 140),
    requiredTool,
    toolPattern:
      fallback.toolPattern ||
      `loopAwaitInput({ sessionId: "${sessionId}", synthesis: "..." })`,
    responseMode:
      fallback.responseMode || (state === "CLOSED" ? "TEXT_ALLOWED" : "TOOL_ONLY"),
    round: typeof fallback.round === "number" ? fallback.round : 0,
    checkpoint: truncate(fallback.checkpoint || "", 180),
    pendingToolCall: Boolean(fallback.pendingToolCall),
    epoch: typeof fallback.epoch === "number" ? fallback.epoch : 1,
  };
}

function resolveLedger(cwd, sessionId, fallback) {
  return readLoopLedger(cwd, sessionId) || buildFallbackLedger(sessionId, fallback);
}

export function compileLoopBeacon(cwd, sessionId, fallback = {}) {
  const ledger = resolveLedger(cwd, sessionId, fallback);
  const checkpoint = ledger.checkpoint || "No checkpoint available.";
  const goal = ledger.goalDigest || "(no goal)";
  const startedAt = fallback.startedAt ? `\nSTARTED=${fallback.startedAt}` : "";

  return [
    "<<LOOP_RESUME_V1>>",
    `STATE=${ledger.state}`,
    `SESSION_ID=${ledger.sessionId}`,
    `TOOL=${ledger.requiredTool}`,
    `MODE=${ledger.responseMode}`,
    `GOAL=${goal}`,
    `ROUND=${ledger.round}`,
    `CHECKPOINT=${checkpoint}`,
    `EPOCH=${ledger.epoch}`,
    `PENDING_TOOL_CALL=${ledger.pendingToolCall ? "true" : "false"}`,
    `TOOL_PATTERN=${ledger.toolPattern}` + startedAt,
    "<<END_LOOP_RESUME>>",
    `Emit exactly one tool call to ${ledger.requiredTool} using SESSION_ID=${ledger.sessionId}. Do NOT output free text.`,
  ].join("\n");
}

export function compileCompactLoopHint(cwd, sessionId, fallback = {}) {
  const ledger = resolveLedger(cwd, sessionId, fallback);
  const goal = truncate(ledger.goalDigest || "(no goal)", 80);
  return `SESSION=${ledger.sessionId} STATE=${ledger.state} TOOL=${ledger.requiredTool} MODE=${ledger.responseMode} EPOCH=${ledger.epoch} GOAL=${goal}`;
}

export function buildLoopProtocolContext(cwd, loop) {
  return compileLoopBeacon(cwd, loop.sessionId, {
    state: "ACTIVE",
    goal: loop.goal,
    startedAt: loop.startedAt,
  });
}

export function buildMultiLoopProtocolContext(cwd, loops) {
  if (!Array.isArray(loops) || loops.length === 0) return "";
  if (loops.length === 1) {
    return buildLoopProtocolContext(cwd, loops[0]);
  }

  const loopLines = loops.map((loop) =>
    compileCompactLoopHint(cwd, loop.sessionId, {
      state: "ACTIVE",
      goal: loop.goal,
      startedAt: loop.startedAt,
    }),
  );

  return [
    "<<LOOP_REGISTRY_V1>>",
    `COUNT=${loops.length}`,
    ...loopLines,
    "<<END_LOOP_REGISTRY>>",
    'Use YOUR loop sessionId. All output remains tool-only via loopAwaitInput(YOUR_SESSION_ID, synthesis).',
  ].join("\n");
}