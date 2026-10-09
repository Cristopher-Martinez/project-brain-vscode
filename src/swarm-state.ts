import * as vscode from "vscode";

export interface SwarmUiWorkerState {
  taskId: string;
  message?: string;
  success?: boolean;
  error?: string;
  model?: string;
  tier?: string;
  rounds?: number;
  toolCalls?: number;
  durationMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface SwarmUiState {
  running: boolean;
  goal?: string;
  concurrency?: number;
  startedAt?: number;
  updatedAt: number;
  summary?: string;
  workers: SwarmUiWorkerState[];
}

let swarmState: SwarmUiState = {
  running: false,
  updatedAt: Date.now(),
  workers: [],
};

const swarmEmitter = new vscode.EventEmitter<SwarmUiState>();
export const onDidChangeSwarmState = swarmEmitter.event;

export function getSwarmState(): SwarmUiState {
  return swarmState;
}

function setState(next: SwarmUiState): void {
  swarmState = next;
  swarmEmitter.fire(swarmState);
}

export function swarmStart(opts: {
  goal: string;
  concurrency: number;
  taskIds: string[];
}): void {
  const now = Date.now();
  setState({
    running: true,
    goal: opts.goal,
    concurrency: opts.concurrency,
    startedAt: now,
    updatedAt: now,
    summary: undefined,
    workers: opts.taskIds.map((taskId) => ({ taskId, message: "Starting..." })),
  });
}

export function swarmProgress(taskId: string, message: string): void {
  const now = Date.now();
  setState({
    ...swarmState,
    updatedAt: now,
    workers: upsertWorker(swarmState.workers, { taskId, message }),
  });
}

export function swarmComplete(opts: {
  summary: string;
  workers: SwarmUiWorkerState[];
}): void {
  const now = Date.now();
  setState({
    ...swarmState,
    running: false,
    updatedAt: now,
    summary: opts.summary,
    workers: opts.workers,
  });
}

export function swarmFail(error: string): void {
  const now = Date.now();
  setState({
    ...swarmState,
    running: false,
    updatedAt: now,
    summary: `Swarm failed: ${error}`,
  });
}

function upsertWorker(
  workers: SwarmUiWorkerState[],
  patch: SwarmUiWorkerState,
): SwarmUiWorkerState[] {
  const idx = workers.findIndex((w) => w.taskId === patch.taskId);
  if (idx === -1) return [...workers, patch];

  const next = workers.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}
