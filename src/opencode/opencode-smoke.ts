/**
 * opencode-smoke — End-to-end diagnostic for the OpenCode subsystem.
 *
 * Boots a server, checks health, lists providers, and (if a provider key is
 * available) runs a one-shot prompt to prove a model responds via OpenRouter.
 * Fully decoupled from the Copilot loop engine.
 */

import { readVault } from "../vault-manager";
import { log, logError } from "../logger";
import { spawnOpenCodeServer } from "./opencode-server";
import { health, listProviders, createSession, promptSession } from "./opencode-client";
import {
  OpenCodeUnavailableError,
  type OpenCodeModelRef,
  type OpenCodeSmokeResult,
} from "./opencode-types";

export interface OpenCodeSmokeOptions {
  /** Workspace root (server cwd + vault location). */
  workspaceRoot: string;
  /** Model to test. Defaults to a cheap OpenRouter model. */
  model?: OpenCodeModelRef;
  /** Override the binary path (config setting). */
  binaryPath?: string;
  /** Optional log sink for raw server lines. */
  onLog?: (line: string) => void;
}

const DEFAULT_MODEL: OpenCodeModelRef = {
  providerID: "openrouter",
  modelID: "openai/gpt-4o-mini",
};

/** Locate the OpenRouter API key in the vault, if present. */
export function findOpenRouterKey(workspaceRoot: string): string | undefined {
  let entries;
  try {
    entries = readVault(workspaceRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const labelMatch = entry.label.toLowerCase().includes("openrouter");
    for (const [key, value] of Object.entries(entry.secrets)) {
      const trimmed = value?.trim();
      if (!trimmed) {
        continue;
      }
      const k = key.toUpperCase();
      // Match when the entry label OR the secret key name hints at OpenRouter.
      if (labelMatch || k.includes("OPENROUTER")) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** Run the full smoke test, returning a structured result (never throws). */
export async function runOpenCodeSmokeTest(
  opts: OpenCodeSmokeOptions,
): Promise<OpenCodeSmokeResult> {
  const started = Date.now();
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = findOpenRouterKey(opts.workspaceRoot);

  let server: { url: string; close: () => void } | undefined;
  try {
    server = await spawnOpenCodeServer({
      cwd: opts.workspaceRoot,
      binaryPath: opts.binaryPath,
      env: apiKey ? { OPENROUTER_API_KEY: apiKey } : undefined,
      onLog: opts.onLog,
    });

    const hp = await health(server.url);
    const providers = await listProviders(server.url);
    log(`[OpenCode] health=${hp.healthy} v${hp.version} providers=${providers.join(",")}`);

    if (!apiKey) {
      return {
        ok: true,
        serverVersion: hp.version,
        providers,
        elapsedMs: Date.now() - started,
        error: "Sin OPENROUTER_API_KEY en el vault: server OK pero no se probó prompt.",
      };
    }

    const sessionId = await createSession(server.url, "Project Brain smoke test");
    const reply = await promptSession(server.url, sessionId, model, "Responde solo con: PONG");

    return {
      ok: reply.length > 0,
      serverVersion: hp.version,
      providers,
      model: `${model.providerID}/${model.modelID}`,
      reply,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const message =
      err instanceof OpenCodeUnavailableError
        ? err.message
        : `Smoke test falló: ${(err as Error).message}`;
    logError(`[OpenCode] ${message}`);
    return { ok: false, error: message, elapsedMs: Date.now() - started };
  } finally {
    server?.close();
  }
}
