/**
 * opencode-engine — Parallel loop engine driven by OpenCode + OpenRouter.
 *
 * Mirrors the *pattern* of the Copilot loop engine (state map, EventEmitter,
 * persistence) but is fully independent. It NEVER imports loop-engine.ts.
 *
 * One shared `opencode serve` process hosts N sessions; each loop == one
 * session. Prompts are sent over REST and block until the model is idle, so
 * built-in tool calls (read/grep/...) resolve before the reply is returned.
 */

import * as vscode from "vscode";
import { log, logError, logWarn } from "../logger";
import { spawnOpenCodeServer } from "./opencode-server";
import { buildOpenCodeConfigContent } from "./opencode-config";
import { createSession, health, promptSession } from "./opencode-client";
import {
  clearOcLoop,
  getAllOcLoops,
  initOcPersistence,
  persistOcLoop,
} from "./opencode-persistence";
import {
  OpenCodeUnavailableError,
  type OpenCodeModelRef,
  type OpenCodeServerHandle,
  type OcLoopState,
  type OcLoopUiState,
} from "./opencode-types";

/** Dependencies injected by the extension host. */
export interface OcEngineDeps {
  /** Resolve the active workspace root. */
  getWorkspaceRoot: () => string | undefined;
  /** Resolve the provider API key (e.g. from the vault). */
  getApiKey: (workspaceRoot: string) => string | undefined;
  /** Optional explicit opencode binary path (config). */
  getBinaryPath?: () => string | undefined;
  /** Optional preferred server port (config); falsy/0 means auto-pick. */
  getServerPort?: () => number | undefined;
}

const activeLoops = new Map<string, OcLoopState>();
const emitter = new vscode.EventEmitter<OcLoopUiState>();
let sharedServer: OpenCodeServerHandle | undefined;
let webServer: OpenCodeServerHandle | undefined;
let deps: OcEngineDeps | undefined;

/** Fired whenever any OpenCode loop changes. */
export const onDidChangeOcLoopState = emitter.event;

/** Snapshot of all known loops, newest first. */
export function getAllOcLoopStates(): OcLoopState[] {
  return [...activeLoops.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Base URL of the shared server if it is currently running. */
export function getSharedServerUrl(): string | undefined {
  return sharedServer?.url;
}

/** Ensure the shared server is up and return its base URL (spawns if needed). */
export async function ensureSharedServerUrl(): Promise<string> {
  const root = requireDeps().getWorkspaceRoot();
  if (!root) {
    throw new OpenCodeUnavailableError("No workspace root for OpenCode server");
  }
  const server = await ensureServer(root);
  return server.url;
}

/** Ensure a dedicated `web` server (REST + web UI) is up; returns its URL. */
export async function ensureWebServerUrl(): Promise<string> {
  const root = requireDeps().getWorkspaceRoot();
  if (!root) {
    throw new OpenCodeUnavailableError("No workspace root for OpenCode web server");
  }
  if (webServer) {
    try {
      await health(webServer.url);
      return webServer.url;
    } catch {
      logWarn("[OpenCode] web server unhealthy; respawning");
      webServer = undefined;
    }
  }
  const apiKey = requireDeps().getApiKey(root);
  webServer = await spawnOpenCodeServer({
    cwd: root,
    mode: "web",
    port: preferredPort(),
    binaryPath: requireDeps().getBinaryPath?.(),
    env: buildServerEnv(root, apiKey),
  });
  log(`[OpenCode] web server ready at ${webServer.url}`);
  return webServer.url;
}

function emit(): void {
  emitter.fire({ loops: getAllOcLoopStates() });
}

function requireDeps(): OcEngineDeps {
  if (!deps) {
    throw new OpenCodeUnavailableError("OpenCode engine not initialized");
  }
  return deps;
}

/** Configured preferred port, or undefined when 0/unset (auto-pick). */
function preferredPort(): number | undefined {
  const port = requireDeps().getServerPort?.();
  return port && port > 0 ? port : undefined;
}

/**
 * Initialize the engine. Loads persisted loops (marked orphaned since the
 * server from the previous VS Code session is gone) and stores deps.
 */
export function initOcEngine(d: OcEngineDeps): void {
  deps = d;
  const root = d.getWorkspaceRoot();
  if (!root) {
    return;
  }
  initOcPersistence(root);
  for (const loop of getAllOcLoops(root)) {
    if (loop.status === "running" || loop.status === "awaiting") {
      loop.status = "orphaned";
    }
    activeLoops.set(loop.sessionId, loop);
  }
  if (activeLoops.size > 0) {
    log(`[OpenCode] loaded ${activeLoops.size} persisted loop(s)`);
    emit();
  }
}

/** Ensure a single shared server is running; spawn it if needed. */
async function ensureServer(workspaceRoot: string): Promise<OpenCodeServerHandle> {
  if (sharedServer) {
    try {
      await health(sharedServer.url);
      return sharedServer;
    } catch {
      logWarn("[OpenCode] shared server unhealthy; respawning");
      sharedServer = undefined;
    }
  }
  const apiKey = requireDeps().getApiKey(workspaceRoot);
  sharedServer = await spawnOpenCodeServer({
    cwd: workspaceRoot,
    port: preferredPort(),
    binaryPath: requireDeps().getBinaryPath?.(),
    env: buildServerEnv(workspaceRoot, apiKey),
  });
  log(`[OpenCode] shared server ready at ${sharedServer.url}`);
  return sharedServer;
}

/** Compose the spawn env: OpenRouter key + OpenCode config (MCP + identity). */
function buildServerEnv(
  workspaceRoot: string,
  apiKey: string | undefined,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (apiKey) {
    env.OPENROUTER_API_KEY = apiKey;
  }
  const config = buildOpenCodeConfigContent({ workspaceRoot });
  if (config) {
    env.OPENCODE_CONFIG_CONTENT = config;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Options for starting a loop. */
export interface StartOcLoopOptions {
  goal: string;
  model: OpenCodeModelRef;
}

/** Start a new OpenCode loop: create a session and run the first work round. */
export async function startOcLoop(opts: StartOcLoopOptions): Promise<string> {
  const root = requireDeps().getWorkspaceRoot();
  if (!root) {
    throw new OpenCodeUnavailableError("No workspace root for OpenCode loop");
  }
  const server = await ensureServer(root);
  const sessionId = await createSession(server.url, opts.goal.slice(0, 80) || "OpenCode loop");
  const now = Date.now();
  const state: OcLoopState = {
    sessionId,
    goal: opts.goal,
    model: opts.model,
    status: "running",
    rounds: [],
    serverUrl: server.url,
    createdAt: now,
    updatedAt: now,
  };
  activeLoops.set(sessionId, state);
  persistOcLoop(root, state);
  emit();
  await runRound(sessionId, opts.goal, "work");
  return sessionId;
}

/** Send a feedback follow-up into an existing loop. */
export async function sendOcFeedback(sessionId: string, feedback: string): Promise<void> {
  const state = activeLoops.get(sessionId);
  if (!state) {
    throw new OpenCodeUnavailableError(`Unknown OpenCode loop ${sessionId}`);
  }
  if (state.status === "orphaned") {
    throw new OpenCodeUnavailableError(
      `Loop ${sessionId} is orphaned (server gone). Start a new loop.`,
    );
  }
  await runRound(sessionId, feedback, "feedback");
}

/** Run one prompt round and record the result. */
async function runRound(
  sessionId: string,
  prompt: string,
  kind: "work" | "feedback",
): Promise<void> {
  const root = requireDeps().getWorkspaceRoot();
  const state = activeLoops.get(sessionId);
  if (!state || !root) {
    return;
  }
  state.status = "running";
  state.updatedAt = Date.now();
  emit();
  try {
    const reply = await promptSession(state.serverUrl, sessionId, state.model, prompt);
    state.rounds.push({ kind, prompt, reply, at: Date.now() });
    state.status = "awaiting";
    state.lastError = undefined;
  } catch (err) {
    const message = (err as Error).message;
    state.rounds.push({ kind, prompt, reply: "", at: Date.now(), error: message });
    state.status = "error";
    state.lastError = message;
    logError(`[OpenCode] round failed for ${sessionId}: ${message}`);
  }
  state.updatedAt = Date.now();
  persistOcLoop(root, state);
  emit();
}

/** End a loop cleanly (keeps history). */
export function endOcLoop(sessionId: string): void {
  const state = activeLoops.get(sessionId);
  if (!state) {
    return;
  }
  state.status = "ended";
  state.updatedAt = Date.now();
  const root = requireDeps().getWorkspaceRoot();
  if (root) {
    persistOcLoop(root, state);
  }
  emit();
}

/** Abort and forget a loop (removes persisted state). */
export function abortOcLoop(sessionId: string): void {
  const root = deps?.getWorkspaceRoot();
  activeLoops.delete(sessionId);
  if (root) {
    clearOcLoop(root, sessionId);
  }
  emit();
}

/** Stop the shared server. Call from extension deactivate(). */
export function stopOcServer(): void {
  for (const handle of [sharedServer, webServer]) {
    if (!handle) {
      continue;
    }
    try {
      handle.close();
    } catch (err) {
      logWarn(`[OpenCode] error closing server: ${(err as Error).message}`);
    }
  }
  sharedServer = undefined;
  webServer = undefined;
}
