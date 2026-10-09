/**
 * opencode-types — Shared types for the OpenCode Loops subsystem.
 *
 * This subsystem is fully decoupled from the Copilot-based loop engine.
 * It talks to a headless `opencode serve` process over its REST API so the
 * extension (CJS) never has to import the ESM-only @opencode-ai/sdk at runtime.
 */

/** A handle to a running OpenCode server process. */
export interface OpenCodeServerHandle {
  /** Base URL, e.g. http://127.0.0.1:4096 */
  url: string;
  /** The port the server is listening on. */
  port: number;
  /** Stop the server process. Idempotent. */
  close: () => void;
}

/** Options for spawning an OpenCode server. */
export interface OpenCodeSpawnOptions {
  /** Working directory for the server (usually the workspace root). */
  cwd: string;
  /** Hostname to bind. Defaults to 127.0.0.1. */
  hostname?: string;
  /** Explicit port. When omitted, a free port is chosen. */
  port?: number;
  /** Extra env vars (e.g. provider API keys) merged over process.env. */
  env?: Record<string, string>;
  /**
   * Explicit path to the `opencode` binary. When omitted, resolution order is:
   * node_modules/.bin → PATH → `npx opencode-ai`.
   */
  binaryPath?: string;
  /** Max ms to wait for the "listening" line before failing. Default 60000. */
  startupTimeoutMs?: number;
  /** Optional sink for raw server log lines. */
  onLog?: (line: string) => void;
  /**
   * Server subcommand. "serve" = headless REST only. "web" = REST + web UI
   * served on the same port (embeddable in a webview iframe). Default "serve".
   */
  mode?: "serve" | "web";
}

/** Health payload from GET /global/health. */
export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

/** A model reference understood by OpenCode. */
export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

/** Result of the diagnostic smoke test. */
export interface OpenCodeSmokeResult {
  ok: boolean;
  serverVersion?: string;
  providers?: string[];
  model?: string;
  reply?: string;
  error?: string;
  elapsedMs: number;
}

/** Thrown when the OpenCode binary or server cannot be reached. */
export class OpenCodeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Loop Engine (Phase 1) — parallel, decoupled from the Copilot loop engine.
// ---------------------------------------------------------------------------

/** Lifecycle status of an OpenCode loop. */
export type OcLoopStatus =
  | "running" // a prompt is in flight
  | "awaiting" // waiting for user feedback
  | "ended" // closed cleanly
  | "error" // last round failed
  | "orphaned"; // server gone after reload; needs respawn

/** One exchange in an OpenCode loop (a prompt + the model's reply). */
export interface OcLoopRound {
  /** "work" = goal/iteration prompt, "feedback" = user-driven follow-up. */
  kind: "work" | "feedback";
  /** The prompt text sent to the model. */
  prompt: string;
  /** The model's concatenated text reply. */
  reply: string;
  /** Epoch ms when the round completed. */
  at: number;
  /** Set when the round failed. */
  error?: string;
}

/** Serializable state of a single OpenCode loop. */
export interface OcLoopState {
  sessionId: string;
  goal: string;
  model: OpenCodeModelRef;
  status: OcLoopStatus;
  rounds: OcLoopRound[];
  /** Base URL of the server hosting this session (for reconnection). */
  serverUrl: string;
  createdAt: number;
  updatedAt: number;
  /** Set when status is "error". */
  lastError?: string;
}

/** State pushed to the UI when an OpenCode loop changes. */
export interface OcLoopUiState {
  loops: OcLoopState[];
}
