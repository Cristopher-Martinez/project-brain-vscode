// ─── MCP Gateway Tools — 14 tool definitions + handlers ─────────────────────
// Each tool maps to a service call inside the extension host.
// Separated from mcp-gateway.ts to respect the 400-line limit.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, logError, logWarn } from "./logger";
import {
  getAllLoopStates,
  getLoopState,
  loopSendFeedback,
  loopStart,
  setLoopSessionOpen,
} from "./loop-engine";
import type { GatewayDeps, GatewayToken } from "./mcp-gateway";
export { getToolDefinitions } from "./mcp-gateway-tool-defs";
import { guardMemoryPath } from "./mcp-gateway-utils";

// ─── Context passed to every tool handler ─────────────────────────────────────

export interface GatewayToolContext {
  deps: GatewayDeps;
  projectPath: string;
  token: GatewayToken;
}

// ─── Scope Guard ──────────────────────────────────────────────────────────────

function requireScope(
  token: GatewayToken,
  scope: "read" | "write" | "orchestrate" | "loop",
): void {
  if (!token.scopes.includes(scope)) {
    logWarn(
      `[McpGatewayTools] Scope denied: "${token.label}" lacks "${scope}"`,
    );
    throw new Error(`[Gateway] Token "${token.label}" lacks scope: ${scope}`);
  }
}

function ok(content: string): CallToolResult {
  return { content: [{ type: "text", text: content }] };
}

function error(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): Promise<CallToolResult> {
  log(
    `[McpGatewayTools] 🔧 Invoking tool: ${name} (token: ${ctx.token.label})`,
  );
  try {
    switch (name) {
      case "get_identity":
        return handleGetIdentity(ctx);
      case "get_user_profile":
        return handleGetUserProfile(ctx);
      case "search_memory":
        return await handleSearchMemory(args, ctx);
      case "get_context":
        return handleGetContext(args, ctx);
      case "write_memory":
        return handleWriteMemory(args, ctx);
      case "list_memory_files":
        return handleListMemoryFiles(ctx);
      case "get_opinions":
        return handleGetOpinions(args, ctx);
      case "get_project_overview":
        return handleGetProjectOverview(ctx);
      case "create_loop":
        return handleCreateLoop(args, ctx);
      case "send_loop_feedback":
        return handleSendLoopFeedback(args, ctx);
      case "get_loop_status":
        return handleGetLoopStatus(args, ctx);
      case "list_active_sessions":
        return handleListActiveSessions(ctx);
      case "orchestrate":
        return await handleOrchestrate(args, ctx);
      case "get_session_handoff":
        return handleGetSessionHandoff(ctx);
      default:
        logWarn(`[McpGatewayTools] Unknown tool requested: ${name}`);
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    logError(`[McpGatewayTools] ${name}: ${err}`);
    return error(String(err));
  }
}

// ─── Individual Handlers ──────────────────────────────────────────────────────

function handleGetIdentity(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const { identityManager } = ctx.deps;
  if (!identityManager)
    return ok(JSON.stringify({ error: "IdentityManager not available" }));
  const identity = identityManager.loadIdentity();
  const soul = identityManager.loadSoul();
  return ok(JSON.stringify({ identity, soul }, null, 2));
}

function handleGetUserProfile(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const profilePath = path.join(ctx.deps.memoryPath, "10_USER_PROFILE.md");
  if (!fs.existsSync(profilePath)) return ok("User profile not found.");
  return ok(fs.readFileSync(profilePath, "utf-8"));
}

async function handleSearchMemory(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): Promise<CallToolResult> {
  requireScope(ctx.token, "read");
  const query = String(args.query ?? "");
  const topK = Number(args.topK ?? 5);
  const category = args.category ? String(args.category) : undefined;
  const topic = args.topic ? String(args.topic) : undefined;
  if (!ctx.deps.mcpManager) return ok("MCPManager not available.");
  const results = await ctx.deps.mcpManager.searchMemory(query, topK, { category, topic });
  return ok(results);
}

function handleGetContext(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): CallToolResult {
  requireScope(ctx.token, "read");
  const aspect = String(args.aspect ?? "");
  const knownFiles: Record<string, string> = {
    overview: "00_PROJECT_OVERVIEW.md",
    architecture: "01_ARCHITECTURE.md",
    codemap: "02_CODE_MAP.md",
    dependencies: "03_DEPENDENCIES.md",
    learnings: "04_LEARNINGS.md",
    troubleshooting: "05_TROUBLESHOOTING.md",
    session: "07_SESSION_HANDOFF.md",
    user: "10_USER_PROFILE.md",
    opinions: "14_OPINIONS.md",
    boot: "BOOT.md",
  };

  const filename =
    knownFiles[aspect.toLowerCase()] ??
    (aspect.endsWith(".md") ? aspect : `${aspect}.md`);
  const resolved = guardMemoryPath(ctx.deps.memoryPath, filename);
  if (!fs.existsSync(resolved)) return ok(`Memory file not found: ${filename}`);
  return ok(fs.readFileSync(resolved, "utf-8"));
}

function handleWriteMemory(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): CallToolResult {
  requireScope(ctx.token, "write");
  const file = String(args.file ?? "");
  const content = String(args.content ?? "");
  if (!file || !content) return error("file and content are required");

  const resolved = guardMemoryPath(ctx.deps.memoryPath, file);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const entry = `\n\n<!-- gateway write ${timestamp} -->\n${content}`;
  fs.appendFileSync(resolved, entry, "utf-8");
  log(`[McpGateway] write_memory: ${file}`);
  return ok(`Appended to ${file}`);
}

function handleListMemoryFiles(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const files = fs
    .readdirSync(ctx.deps.memoryPath)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return ok(JSON.stringify(files, null, 2));
}

function handleGetOpinions(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): CallToolResult {
  requireScope(ctx.token, "read");
  const { opinionBank } = ctx.deps;
  if (!opinionBank) return ok("OpinionBank not available.");
  const domain = args.domain ? String(args.domain) : undefined;
  const limit = Number(args.limit ?? 20);
  const opinions = opinionBank.getOpinions(domain).slice(0, limit);
  return ok(JSON.stringify(opinions, null, 2));
}

function handleGetProjectOverview(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const bootPath = path.join(ctx.deps.memoryPath, "BOOT.md");
  if (!fs.existsSync(bootPath)) return ok("BOOT.md not found.");
  return ok(fs.readFileSync(bootPath, "utf-8"));
}

async function handleCreateLoop(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): Promise<CallToolResult> {
  requireScope(ctx.token, "loop");
  const goal = String(args.goal ?? "");
  if (!goal) return error("goal is required");
  const sessionId = `gw_loop_${Date.now()}`;
  await loopStart(sessionId, goal);
  setLoopSessionOpen(sessionId, true);
  log(`[McpGateway] Loop created: ${sessionId}`);
  return ok(JSON.stringify({ sessionId, goal, status: "active" }));
}

function handleSendLoopFeedback(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): CallToolResult {
  requireScope(ctx.token, "loop");
  const sessionId = String(args.sessionId ?? "");
  const feedback = String(args.feedback ?? "");
  if (!sessionId || !feedback)
    return error("sessionId and feedback are required");
  loopSendFeedback(sessionId, feedback);
  return ok(`Feedback sent to loop ${sessionId}`);
}

function handleGetLoopStatus(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): CallToolResult {
  requireScope(ctx.token, "read");
  const sessionId = String(args.sessionId ?? "");
  if (!sessionId) return error("sessionId is required");
  const state = getLoopState(sessionId);
  return ok(JSON.stringify(state, null, 2));
}

function handleListActiveSessions(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const loops: Record<string, unknown>[] = [];
  getAllLoopStates().forEach((state, id) => {
    if (state.state !== "idle" && state.state !== "completed") {
      const { sessionId: _s, ...rest } = state;
      loops.push({ sessionId: id, ...rest });
    }
  });
  return ok(JSON.stringify({ loops, count: loops.length }, null, 2));
}

async function handleOrchestrate(
  args: Record<string, unknown>,
  ctx: GatewayToolContext,
): Promise<CallToolResult> {
  requireScope(ctx.token, "orchestrate");
  const goal = String(args.goal ?? "");
  if (!goal) return error("goal is required");
  if (!ctx.deps.orchestrationManager)
    return error("OrchestrationManager not available");

  // Gate: require explicit confirmation from VS Code UI
  const action = await vscode.window.showWarningMessage(
    `[MCP Gateway] External client "${ctx.token.label}" wants to orchestrate:\n"${goal}"`,
    { modal: true },
    "Allow",
  );
  if (action !== "Allow") return ok("Orchestration cancelled by user.");

  log(`[McpGateway] Orchestration approved: ${goal}`);
  return ok(`Orchestration approved. Goal: "${goal}"`);
}

function handleGetSessionHandoff(ctx: GatewayToolContext): CallToolResult {
  requireScope(ctx.token, "read");
  const handoffPath = path.join(ctx.deps.memoryPath, "07_SESSION_HANDOFF.md");
  if (!fs.existsSync(handoffPath)) return ok("Session handoff not found.");
  return ok(fs.readFileSync(handoffPath, "utf-8"));
}
