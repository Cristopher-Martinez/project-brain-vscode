// MCP Gateway — HTTP server exposing project memory to external MCP clients.
// Security: localhost-only, scoped Bearer tokens, rate limiting, Host validation.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import type { AgentIdentityManager } from "./agent-identity";
import { log, logError, logWarn } from "./logger";
import { getToolDefinitions, handleToolCall } from "./mcp-gateway-tools";
import type {
  GatewayToken,
  RateLimitEntry,
  RequestLogEntry,
} from "./mcp-gateway-types";
export type { GatewayToken, RequestLogEntry } from "./mcp-gateway-types";
import { parseBody } from "./mcp-gateway-utils";
import {
  checkGatewayRateLimit,
  generateGatewayToken,
  listGatewayTokens,
  pushGatewayRequestLog,
  revokeGatewayToken,
  validateGatewayToken,
} from "./mcp-gateway-runtime";
import type { MCPManager } from "./mcp-manager";
import type { OpinionBank } from "./opinion-bank";
import type { OrchestrationManager } from "./orchestration-manager";

export interface GatewayDeps {
  identityManager?: AgentIdentityManager;
  opinionBank?: OpinionBank;
  orchestrationManager?: OrchestrationManager;
  memoryPath: string;
  workspaceFolder: vscode.WorkspaceFolder;
  mcpManager?: MCPManager;
  secretStorage: vscode.SecretStorage;
  log: (msg: string) => void;
}

const DEFAULT_PORT = 3200;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_LOG_ENTRIES = 50;
const STOP_TIMEOUT_MS = 3_000;

export class McpGateway {
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private httpServer: http.Server | null = null;
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private requestLog: RequestLogEntry[] = [];
  private readonly port: number;
  private readonly deps: GatewayDeps;

  constructor(deps: GatewayDeps, port?: number) {
    this.deps = deps;
    this.port = port ?? DEFAULT_PORT;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.httpServer) {
      log(`[McpGateway] Already running on port ${this.port}`);
      return;
    }

    const server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        logError(`[McpGateway] Unhandled error: ${err}`);
        if (!res.headersSent) res.writeHead(500).end("Internal Server Error");
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    server.unref(); // Don't block extension host shutdown
    this.httpServer = server;
    log(`[McpGateway] 🟢 Listening on http://127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    log(
      `[McpGateway] 🔴 Stopping server (${this.transports.size} active sessions)...`,
    );

    // Close all active transports first
    for (const [id, transport] of this.transports) {
      try {
        await transport.close?.();
      } catch (err) {
        logWarn(`[McpGateway] Transport ${id} close error: ${err}`);
      }
      this.transports.delete(id);
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.httpServer?.closeAllConnections?.();
        this.httpServer = null;
        resolve();
      }, STOP_TIMEOUT_MS);

      this.httpServer!.close(() => {
        clearTimeout(timeout);
        this.httpServer = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.httpServer?.listening ?? false;
  }

  getPort(): number {
    return this.port;
  }

  getSessionCount(): number {
    return this.transports.size;
  }

  // ─── Token Management ────────────────────────────────────────────────────────

  async generateToken(
    label: string,
    scopes: GatewayToken["scopes"],
    expiresInDays?: number,
  ): Promise<string> {
    return generateGatewayToken(
      this.deps.secretStorage,
      label,
      scopes,
      expiresInDays,
      log,
    );
  }

  async listTokens(): Promise<Omit<GatewayToken, "token">[]> {
    return listGatewayTokens(this.deps.secretStorage);
  }

  async revokeToken(label: string): Promise<void> {
    await revokeGatewayToken(this.deps.secretStorage, label, log);
  }

  // ─── Request Log ──────────────────────────────────────────────────────────────

  logRequest(entry: RequestLogEntry): void {
    pushGatewayRequestLog(this.requestLog, entry, MAX_LOG_ENTRIES);
  }

  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  // ─── Request Router ───────────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // 1. Host validation (anti DNS-rebinding)
    if (!this.validateHost(req)) {
      logWarn(
        `[McpGateway] Host validation failed: ${req.headers.host} — possible DNS rebinding`,
      );
      res.writeHead(403).end("Forbidden");
      return;
    }

    // 2. Health endpoint — no auth, minimal info
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("OK");
      return;
    }

    // 2b. Info endpoint — no auth, tool catalog for discovery
    if (req.method === "GET" && req.url === "/info") {
      const tools = getToolDefinitions().map((t) => ({
        name: t.name,
        description: t.description,
      }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          tools,
          version: "1.0.0",
          protocol: "MCP 2024-11-05",
        }),
      );
      return;
    }

    // 3. Status endpoint — requires auth
    if (req.method === "GET" && req.url === "/status") {
      const token = await this.validateToken(req);
      if (!token) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      const status = {
        running: true,
        port: this.port,
        sessions: this.transports.size,
      };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(status));
      return;
    }

    // 4. Auth required for all MCP endpoints
    const token = await this.validateToken(req);
    if (!token) {
      logWarn(`[McpGateway] 🔒 Unauthorized request: ${req.method} ${req.url}`);
      res
        .writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcp-gateway"' })
        .end("Unauthorized");
      return;
    }

    // 5. Rate limiting
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!this.checkRateLimit(ip)) {
      logWarn(
        `[McpGateway] Rate limit exceeded for ${ip} (>${RATE_LIMIT} req/${RATE_WINDOW_MS}ms)`,
      );
      res
        .writeHead(429, { "X-RateLimit-Limit": String(RATE_LIMIT) })
        .end("Too Many Requests");
      return;
    }

    // 6. MCP Protocol routing
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/") {
      await this.handleMcpPost(req, res, token);
    } else if (req.method === "GET" && url === "/") {
      await this.handleMcpSse(req, res);
    } else if (req.method === "DELETE" && url === "/") {
      await this.handleMcpDelete(req, res);
    } else {
      logWarn(`[McpGateway] 404 Not Found: ${req.method} ${url}`);
      res.writeHead(404).end("Not Found");
    }
  }

  // ─── MCP Method Handlers ──────────────────────────────────────────────────────

  private async handleMcpPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: GatewayToken,
  ): Promise<void> {
    const body = await parseBody(req);

    if (isInitializeRequest(body)) {
      // New session: create fresh Server + Transport pair
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const mcpServer = this.createMcpServer(token);
      await mcpServer.connect(transport);

      // handleRequest generates the sessionId — must store AFTER
      await transport.handleRequest(req, res, body);

      const sessionId = transport.sessionId;
      if (sessionId) {
        this.transports.set(sessionId, transport);
        transport.onclose = () => this.transports.delete(sessionId);
        log(
          `[McpGateway] 📡 New MCP session: ${sessionId} (token: ${token.label})`,
        );
      }
    } else {
      // Existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const transport = sessionId ? this.transports.get(sessionId) : undefined;
      if (!transport) {
        logWarn(
          `[McpGateway] Session not found for POST: ${sessionId ?? "none"}`,
        );
        res.writeHead(404).end("Session not found");
        return;
      }
      await transport.handleRequest(req, res, body);
    }
  }

  private async handleMcpSse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? this.transports.get(sessionId) : undefined;
    if (!transport) {
      logWarn(`[McpGateway] SSE session not found: ${sessionId ?? "none"}`);
      res.writeHead(404).end("Session not found");
      return;
    }
    await transport.handleRequest(req, res);
  }

  private async handleMcpDelete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? this.transports.get(sessionId) : undefined;
    if (!transport) {
      logWarn(`[McpGateway] DELETE session not found: ${sessionId ?? "none"}`);
      res.writeHead(404).end("Session not found");
      return;
    }
    await transport.handleRequest(req, res);
    this.transports.delete(sessionId!);
    log(`[McpGateway] 🗑️ Session terminated: ${sessionId}`);
  }

  // ─── MCP Server Factory ───────────────────────────────────────────────────────

  private createMcpServer(token: GatewayToken): Server {
    const mcpServer = new Server(
      { name: "project-brain-gateway", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getToolDefinitions(),
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const start = Date.now();
      const result = await handleToolCall(
        name,
        (args as Record<string, unknown>) ?? {},
        {
          deps: this.deps,
          projectPath: this.deps.workspaceFolder.uri.fsPath,
          token,
        },
      );
      this.logRequest({
        timestamp: new Date().toISOString(),
        tokenLabel: token.label,
        tool: name,
        status: result.isError ? "error" : "ok",
        durationMs: Date.now() - start,
      });
      return result;
    });

    return mcpServer;
  }

  // ─── Security ─────────────────────────────────────────────────────────────────

  private validateHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host?.split(":")[0];
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  private async validateToken(
    req: http.IncomingMessage,
  ): Promise<GatewayToken | null> {
    return validateGatewayToken(
      req as unknown as { headers: Record<string, string | string[] | undefined> },
      this.deps.secretStorage,
      logWarn,
    );
  }

  private checkRateLimit(ip: string): boolean {
    return checkGatewayRateLimit(
      this.rateLimitMap,
      ip,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
  }
}
