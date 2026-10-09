import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";

const LOOP_LEDGER_FILENAME = "loop-ledger.json";
const DEFAULT_REQUIRED_TOOL = "loopAwaitInput";
const DEFAULT_RESPONSE_MODE = "TOOL_ONLY";

export interface LoopLedger {
  state: "ACTIVE" | "BLOCKED" | "WAITING_USER" | "CLOSED";
  sessionId: string;
  goalDigest: string;
  requiredTool: string;
  toolPattern: string;
  responseMode: "TOOL_ONLY" | "TEXT_ALLOWED";
  round: number;
  checkpoint: string;
  pendingToolCall: boolean;
  epoch: number;
  updatedAt: string;
}

export interface LoopLedgerStateInput {
  state?: string;
  goal?: string;
  pendingSynthesis?: string;
  awaitingFeedback?: boolean;
  currentIteration?: { prompt?: string };
  iterations?: Array<{ synthesis?: string; prompt?: string }>;
  currentLoopIterations?: number;
  updatedAt?: number;
}

function getRepoRoot(repoRoot?: string): string | null {
  if (repoRoot) return repoRoot;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function getLoopLedgerPath(
  sessionId: string,
  repoRoot?: string,
): string | null {
  const root = getRepoRoot(repoRoot);
  if (!root) return null;
  return path.join(getLoopDir(root, sessionId), LOOP_LEDGER_FILENAME);
}

function normalizeIso(value?: number): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function truncate(value: string | undefined, max: number): string {
  if (!value) return "";
  return value.length <= max ? value : value.slice(0, max);
}

function mapLedgerState(state?: string, awaitingFeedback?: boolean): LoopLedger["state"] {
  if (state === "completed" || state === "idle") return "CLOSED";
  if (state === "disconnected") return "BLOCKED";
  if (awaitingFeedback || state === "awaiting") return "WAITING_USER";
  return "ACTIVE";
}

function mapResponseMode(state: LoopLedger["state"]): LoopLedger["responseMode"] {
  return state === "CLOSED" ? "TEXT_ALLOWED" : DEFAULT_RESPONSE_MODE;
}

function deriveRound(input: LoopLedgerStateInput): number {
  if (typeof input.currentLoopIterations === "number") {
    return input.currentLoopIterations;
  }
  const completed = input.iterations?.length ?? 0;
  return input.currentIteration ? completed + 1 : completed;
}

function deriveCheckpoint(input: LoopLedgerStateInput): string {
  if (input.pendingSynthesis) {
    return truncate(input.pendingSynthesis, 240);
  }

  const lastSynthesis = input.iterations
    ?.map((iteration) => iteration.synthesis)
    .filter((value): value is string => Boolean(value))
    .at(-1);

  if (lastSynthesis) {
    return truncate(lastSynthesis, 240);
  }

  if (input.currentIteration?.prompt) {
    return truncate(input.currentIteration.prompt, 160);
  }

  return "";
}

function getToolPattern(sessionId: string, existing?: LoopLedger | null): string {
  if (existing?.toolPattern) return existing.toolPattern;
  return `loopAwaitInput({ sessionId: "${sessionId}", synthesis: "..." })`;
}

function snapshot(ledger: Omit<LoopLedger, "epoch" | "updatedAt">): string {
  return JSON.stringify(ledger);
}

function computeEpoch(
  previous: LoopLedger | null,
  next: Omit<LoopLedger, "epoch" | "updatedAt">,
): number {
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
  const nextSnapshot = snapshot(next);
  return prevSnapshot === nextSnapshot ? previous.epoch : previous.epoch + 1;
}

export function readLoopLedger(
  sessionId: string,
  repoRoot?: string,
): LoopLedger | null {
  try {
    const ledgerPath = getLoopLedgerPath(sessionId, repoRoot);
    if (!ledgerPath || !fs.existsSync(ledgerPath)) return null;
    return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as LoopLedger;
  } catch {
    return null;
  }
}

export function writeLoopLedger(
  sessionId: string,
  ledger: LoopLedger,
  repoRoot?: string,
): LoopLedger | null {
  try {
    const ledgerPath = getLoopLedgerPath(sessionId, repoRoot);
    if (!ledgerPath) return null;
    const dir = path.dirname(ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    return ledger;
  } catch {
    return null;
  }
}

export function buildLoopLedger(
  sessionId: string,
  input: LoopLedgerStateInput,
  previous?: LoopLedger | null,
): LoopLedger {
  const ledgerState = mapLedgerState(input.state, input.awaitingFeedback);
  const nextBase = {
    state: ledgerState,
    sessionId,
    goalDigest: truncate(input.goal, 140),
    requiredTool:
      ledgerState === "CLOSED" ? "loopEnd" : DEFAULT_REQUIRED_TOOL,
    toolPattern: getToolPattern(sessionId, previous),
    responseMode: mapResponseMode(ledgerState),
    round: deriveRound(input),
    checkpoint: deriveCheckpoint(input),
    pendingToolCall: previous?.pendingToolCall ?? false,
  } satisfies Omit<LoopLedger, "epoch" | "updatedAt">;

  return {
    ...nextBase,
    epoch: computeEpoch(previous ?? null, nextBase),
    updatedAt: normalizeIso(input.updatedAt),
  };
}

export function syncLoopLedger(
  sessionId: string,
  input: LoopLedgerStateInput,
  repoRoot?: string,
): LoopLedger | null {
  const previous = readLoopLedger(sessionId, repoRoot);
  const next = buildLoopLedger(sessionId, input, previous);
  return writeLoopLedger(sessionId, next, repoRoot);
}

export function setLoopLedgerPendingToolCall(
  sessionId: string,
  pendingToolCall: boolean,
  repoRoot?: string,
): LoopLedger | null {
  const previous = readLoopLedger(sessionId, repoRoot);
  const base = previous ?? {
    state: "ACTIVE" as const,
    sessionId,
    goalDigest: "",
    requiredTool: DEFAULT_REQUIRED_TOOL,
    toolPattern: getToolPattern(sessionId, null),
    responseMode: DEFAULT_RESPONSE_MODE,
    round: 0,
    checkpoint: "",
    pendingToolCall: false,
    epoch: 0,
    updatedAt: normalizeIso(),
  };

  const nextBase = {
    state: base.state,
    sessionId: base.sessionId,
    goalDigest: base.goalDigest,
    requiredTool: base.requiredTool,
    toolPattern: base.toolPattern,
    responseMode: base.responseMode,
    round: base.round,
    checkpoint: base.checkpoint,
    pendingToolCall,
  } satisfies Omit<LoopLedger, "epoch" | "updatedAt">;

  return writeLoopLedger(
    sessionId,
    {
      ...nextBase,
      epoch: computeEpoch(previous ?? null, nextBase),
      updatedAt: normalizeIso(),
    },
    repoRoot,
  );
}