export interface GatewayToken {
  token: string; // pb_gw_<32 hex>
  label: string; // e.g. "telegram-bot"
  scopes: ("read" | "write" | "orchestrate" | "loop")[];
  createdAt: string;
  lastUsed?: string | null; // ISO timestamp, null = never used
  expiresAt?: string | null; // ISO timestamp, null = never expires
}

export interface RequestLogEntry {
  timestamp: string;
  tokenLabel: string;
  tool: string;
  status: "ok" | "error" | "denied";
  durationMs?: number;
}

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}
