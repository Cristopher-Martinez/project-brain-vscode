/**
 * MCP Gateway — Utilities (extracted to keep mcp-gateway.ts under 400 lines).
 * Pure functions: body parsing, token storage, security helpers.
 */

import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { logError, logWarn } from "./logger";
import type { GatewayToken } from "./mcp-gateway";

const STORAGE_KEY = "projectBrain.gateway.tokens";
const MAX_BODY_SIZE = 1_048_576; // 1 MB

// ─── Body Parser ──────────────────────────────────────────────────────────────

export async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size +=
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        logWarn(
          `[McpGateway] Body too large (${size} bytes), rejecting request`,
        );
        reject(new Error("Request body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        logWarn(`[McpGateway] Invalid JSON body received`);
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ─── Token Storage ────────────────────────────────────────────────────────────

export async function loadTokens(
  secretStorage: vscode.SecretStorage,
): Promise<GatewayToken[]> {
  try {
    const raw = await secretStorage.get(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GatewayToken[];
  } catch (err) {
    logError(`[McpGateway] Failed to load tokens from SecretStorage: ${err}`);
    return [];
  }
}

export async function saveTokens(
  secretStorage: vscode.SecretStorage,
  tokens: GatewayToken[],
): Promise<void> {
  await secretStorage.store(STORAGE_KEY, JSON.stringify(tokens));
}

// ─── Security Helpers ─────────────────────────────────────────────────────────

export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Path Traversal Guard ─────────────────────────────────────────────────────
// Used by mcp-gateway-tools.ts

export function guardMemoryPath(
  memoryDir: string,
  relativePath: string,
): string {
  const normalized = path
    .normalize(relativePath)
    .replace(/^(\.\.\/|\.\.\\)+/, "");
  const resolved = path.resolve(memoryDir, normalized);
  const base = memoryDir.endsWith(path.sep) ? memoryDir : memoryDir + path.sep;
  if (!resolved.startsWith(base) && resolved !== memoryDir) {
    logWarn(`[McpGateway] Path traversal blocked: ${relativePath}`);
    throw new Error(`[Gateway] Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}
