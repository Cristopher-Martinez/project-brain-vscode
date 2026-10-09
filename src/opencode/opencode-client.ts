/**
 * opencode-client — Thin REST client for a running OpenCode server.
 *
 * Uses the global fetch (Node 18+/22) so the CJS extension never imports the
 * ESM-only @opencode-ai/sdk at runtime. Route shapes verified against
 * @opencode-ai/sdk@1.15.12 generated types.
 */

import { log } from "../logger";
import {
  OpenCodeUnavailableError,
  type OpenCodeHealth,
  type OpenCodeModelRef,
} from "./opencode-types";

interface SessionInfo {
  id: string;
  title?: string;
}

interface PromptResponsePart {
  type: string;
  text?: string;
}

interface PromptResponse {
  info?: unknown;
  parts?: PromptResponsePart[];
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    throw new OpenCodeUnavailableError(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new OpenCodeUnavailableError(`POST ${path} → ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as T;
}

/** GET /global/health */
export async function health(baseUrl: string): Promise<OpenCodeHealth> {
  return getJson<OpenCodeHealth>(baseUrl, "/global/health");
}

/** GET /config/providers → list of provider ids. */
export async function listProviders(baseUrl: string): Promise<string[]> {
  const data = await getJson<{ providers?: Array<{ id: string }> }>(
    baseUrl,
    "/config/providers",
  );
  return (data.providers ?? []).map((p) => p.id).filter(Boolean);
}

/** POST /session → create a new session, returns its id. */
export async function createSession(baseUrl: string, title: string): Promise<string> {
  const session = await postJson<SessionInfo>(baseUrl, "/session", { title });
  if (!session?.id) {
    throw new OpenCodeUnavailableError("Session create returned no id");
  }
  return session.id;
}

/**
 * POST /session/{id}/message → send a prompt, return concatenated text reply.
 */
export async function promptSession(
  baseUrl: string,
  sessionId: string,
  model: OpenCodeModelRef,
  text: string,
): Promise<string> {
  const body = {
    model,
    parts: [{ type: "text", text }],
  };
  log(`[OpenCode] prompting ${model.providerID}/${model.modelID} on session ${sessionId}`);
  const res = await postJson<PromptResponse>(
    baseUrl,
    `/session/${encodeURIComponent(sessionId)}/message`,
    body,
  );
  const reply = (res.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  return reply;
}
