import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  constantTimeCompare,
  loadTokens,
  saveTokens,
} from "./mcp-gateway-utils";
import type {
  GatewayToken,
  RateLimitEntry,
  RequestLogEntry,
} from "./mcp-gateway-types";

export async function generateGatewayToken(
  secretStorage: vscode.SecretStorage,
  label: string,
  scopes: GatewayToken["scopes"],
  expiresInDays: number | undefined,
  log: (msg: string) => void,
): Promise<string> {
  const raw = crypto.randomBytes(16).toString("hex");
  const token = `pb_gw_${raw}`;
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
    : null;
  const entry: GatewayToken = {
    token,
    label,
    scopes,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    expiresAt,
  };
  const existing = await loadTokens(secretStorage);
  existing.push(entry);
  await saveTokens(secretStorage, existing);
  log(
    `[McpGateway] Token created: "${label}" (scopes: ${scopes.join(",")}) pb_gw_${raw.slice(0, 4)}...`,
  );
  return token;
}

export async function listGatewayTokens(
  secretStorage: vscode.SecretStorage,
): Promise<Omit<GatewayToken, "token">[]> {
  const tokens = await loadTokens(secretStorage);
  return tokens.map(({ label, scopes, createdAt, lastUsed, expiresAt }) => ({
    label,
    scopes,
    createdAt,
    lastUsed: lastUsed ?? null,
    expiresAt: expiresAt ?? null,
  }));
}

export async function revokeGatewayToken(
  secretStorage: vscode.SecretStorage,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  const tokens = await loadTokens(secretStorage);
  const filtered = tokens.filter((t) => t.label !== label);
  await saveTokens(secretStorage, filtered);
  log(
    `[McpGateway] Token revoked: "${label}" (${tokens.length - filtered.length} removed)`,
  );
}

export function pushGatewayRequestLog(
  requestLog: RequestLogEntry[],
  entry: RequestLogEntry,
  maxEntries: number,
): void {
  requestLog.unshift(entry);
  if (requestLog.length > maxEntries) {
    requestLog.length = maxEntries;
  }
}

export async function validateGatewayToken(
  req: { headers: Record<string, string | string[] | undefined> },
  secretStorage: vscode.SecretStorage,
  logWarn: (msg: string) => void,
): Promise<GatewayToken | null> {
  const authHeader = req.headers.authorization;
  const rawValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!rawValue?.startsWith("Bearer ")) return null;
  const provided = rawValue.slice(7).trim();
  if (!provided.startsWith("pb_gw_")) return null;

  const tokens = await loadTokens(secretStorage);
  for (const stored of tokens) {
    if (!constantTimeCompare(provided, stored.token)) continue;
    if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
      logWarn(
        `[McpGateway] Token expired: "${stored.label}" (expired ${stored.expiresAt})`,
      );
      return null;
    }
    stored.lastUsed = new Date().toISOString();
    void saveTokens(secretStorage, tokens);
    return stored;
  }
  return null;
}

export function checkGatewayRateLimit(
  rateLimitMap: Map<string, RateLimitEntry>,
  ip: string,
  rateLimit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  return ++entry.count <= rateLimit;
}
