/**
 * VS Code Chat Reader — Extract conversation data from VS Code chat sessions
 *
 * VS Code stores chat sessions as JSONL files in:
 *   {workspaceStorage}/{wsId}/chatSessions/{sessionId}.jsonl
 *
 * The JSONL uses a patch-based format:
 *   - Line 0 (kind: 0) → Session snapshot (sessionId, requests[], creationDate)
 *   - kind: 1           → Simple key-value patches (k: ["key"], v: value)
 *   - kind: 2           → Array patches (k: ["requests"], v: [requestObj])
 *                          or (k: ["requests", N, "response"], v: [responseItems])
 *
 * Response items have their own `kind` field:
 *   - undefined/"markdownContent" → Text content (value field)
 *   - "thinking"                  → Reasoning/thinking blocks
 *   - "toolInvocationSerialized"  → Tool call with toolId, resultDetails
 *   - "inlineReference"           → File/symbol references
 *   - "textEditGroup"             → File edits
 *
 * This module reads these sessions to build rich summaries for hibernated loops.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A request object as stored in a chat session JSONL */
interface ChatRequest {
  requestId: string;
  timestamp: string;
  message?: { text: string; parts?: unknown[] };
  agent?: { name: string; id: string };
  modelId?: string;
  response?: ResponseItem[];
}

/** Response item kinds within a request's response array */
interface ResponseItem {
  kind?: string;
  value?: string;
  toolId?: string;
  invocationMessage?: string;
  resultDetails?: { input?: string; output?: unknown[] };
}

/** JSONL line: kind 0 = session snapshot */
interface JournalSnapshot {
  kind: 0;
  v: {
    version: number;
    sessionId: string;
    creationDate: string;
    customTitle?: string;
    requests: ChatRequest[];
  };
}

/** JSONL line: kind 1 = simple k/v patch */
interface JournalKVPatch {
  kind: 1;
  k: string[];
  v: unknown;
}

/** JSONL line: kind 2 = array/path patch */
interface JournalArrayPatch {
  kind: 2;
  k: (string | number)[];
  v: unknown[];
  i?: number;
}

type JournalLine = JournalSnapshot | JournalKVPatch | JournalArrayPatch;

export interface TranscriptSummary {
  chatSessionId: string;
  startTime: string;
  userMessages: string[];
  assistantMessages: string[];
  toolsUsed: string[];
  totalTurns: number;
}

// ─── Module state ───────────────────────────────────────────────────────────

let _workspaceStorageRoot: string | null = null;

/**
 * Initialize with the workspace storage root directory.
 * Call from extension.ts with: `path.dirname(context.storageUri.fsPath)`
 * This gives us the workspace-specific storage dir (e.g., .../workspaceStorage/{hash}/)
 * where chatSessions/ lives as a sibling to extension storage dirs.
 */
export function setWorkspaceStorageRoot(wsStorageRoot: string): void {
  _workspaceStorageRoot = wsStorageRoot;
  log(`[ChatReader] Workspace storage root: ${wsStorageRoot}`);
}

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Get the chatSessions directory for the current workspace.
 * VS Code stores sessions at: {workspaceStorage}/{wsId}/chatSessions/
 */
export function getTranscriptsDir(): string | null {
  if (!_workspaceStorageRoot) {
    logWarn("[ChatReader] Workspace storage root not set");
    return null;
  }
  const dir = path.join(_workspaceStorageRoot, "chatSessions");
  return fs.existsSync(dir) ? dir : null;
}

// ─── Transcript search ─────────────────────────────────────────────────────

/**
 * Find the chat session file that contains a specific loop session.
 * Searches JSONL files for the loop session ID in user message text.
 *
 * Returns the VS Code chat session ID if found, null otherwise.
 */
export function findTranscriptForLoop(loopSessionId: string): string | null {
  const dir = getTranscriptsDir();
  if (!dir) return null;

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

    // Sort by mtime descending — most recent first for faster match
    const sorted = files
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const { name } of sorted) {
      const filePath = path.join(dir, name);
      const content = fs.readFileSync(filePath, "utf-8");

      // Quick string search before parsing — fast path
      if (!content.includes(loopSessionId)) continue;

      // Verify it's in a user message (request patch)
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as JournalLine;
          if (parsed.kind !== 2) continue;
          // Check request patches: k=["requests"], v contains message.text
          if (parsed.k.length === 1 && parsed.k[0] === "requests") {
            const req = (parsed.v as ChatRequest[])[0];
            if (req?.message?.text?.includes(loopSessionId)) {
              return name.replace(".jsonl", "");
            }
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
  } catch (err) {
    logWarn(`[ChatReader] Error searching chat sessions: ${err}`);
  }

  return null;
}

// ─── Transcript parsing ─────────────────────────────────────────────────────

/**
 * Parse a chat session JSONL file into a structured summary.
 * Reconstructs user messages and responses from the patch-based format.
 */
export function parseTranscript(
  chatSessionId: string,
): TranscriptSummary | null {
  const dir = getTranscriptsDir();
  if (!dir) return null;

  const filePath = path.join(dir, `${chatSessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const summary: TranscriptSummary = {
      chatSessionId,
      startTime: "",
      userMessages: [],
      assistantMessages: [],
      toolsUsed: [],
      totalTurns: 0,
    };

    const toolSet = new Set<string>();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as JournalLine;

        if (parsed.kind === 0) {
          // Snapshot: extract creation date
          summary.startTime = parsed.v.creationDate || "";
        } else if (parsed.kind === 2) {
          processArrayPatch(parsed, summary, toolSet);
        }
        // kind 1 patches are metadata (title, inputState) — skip
      } catch {
        /* skip malformed lines */
      }
    }

    summary.toolsUsed = [...toolSet];
    return summary;
  } catch (err) {
    logWarn(`[ChatReader] Error parsing chat session: ${err}`);
    return null;
  }
}

/** Process a kind=2 array patch to extract messages and tools */
function processArrayPatch(
  patch: JournalArrayPatch,
  summary: TranscriptSummary,
  toolSet: Set<string>,
): void {
  // New request: k=["requests"], v=[requestObj]
  if (patch.k.length === 1 && patch.k[0] === "requests") {
    const req = (patch.v as ChatRequest[])[0];
    if (req?.message?.text) {
      summary.userMessages.push(req.message.text);
      summary.totalTurns++;
    }
    return;
  }

  // Response content: k=["requests", N, "response"], v=[responseItems]
  if (patch.k.length === 3 && patch.k[2] === "response") {
    const items = patch.v as ResponseItem[];
    for (const item of items) {
      extractFromResponseItem(item, summary, toolSet);
    }
  }
}

/** Extract text content and tool names from a single response item */
function extractFromResponseItem(
  item: ResponseItem,
  summary: TranscriptSummary,
  toolSet: Set<string>,
): void {
  if (item.kind === "toolInvocationSerialized" && item.toolId) {
    toolSet.add(item.toolId);
    return;
  }

  // Text content: kind is undefined (markdownContent) — the actual response text
  if (!item.kind && item.value && typeof item.value === "string") {
    const text = item.value.trim();
    if (text.length > 10) {
      summary.assistantMessages.push(text);
    }
  }
  // Skip "thinking", "inlineReference", "textEditGroup"
}

// ─── Summary building ───────────────────────────────────────────────────────

/**
 * Build a rich summary from a transcript for hibernate display.
 * Extracts the conversation flow: user requests → key assistant responses.
 *
 * @param loopSessionId The loop's internal session ID
 * @returns A markdown-formatted summary, or null if transcript not found
 */
export function buildTranscriptSummary(loopSessionId: string): string | null {
  const chatSessionId = findTranscriptForLoop(loopSessionId);
  if (!chatSessionId) return null;

  const transcript = parseTranscript(chatSessionId);
  if (!transcript) return null;

  return formatSummaryFromTranscript(transcript);
}

/**
 * Format a TranscriptSummary into an AI-optimized structured context block.
 *
 * Designed for LLM consumption during resume: the agent should be able to
 * understand what happened, what was decided, and what's pending — without
 * needing to re-read files or search memory.
 */
function formatSummaryFromTranscript(transcript: TranscriptSummary): string {
  const clean = transcript.userMessages.map(stripLoopHeader);
  const parts: string[] = [];

  // 1. Objective — first user message is typically the goal
  if (clean.length > 0) {
    parts.push(`Objetivo: ${truncate(clean[0], 300)}`);
  }

  // 2. User evolution — subsequent messages show how the goal evolved
  if (clean.length > 1) {
    const evolution = clean
      .slice(1)
      .filter((m) => m.length > 10)
      .map((m) => `- ${truncate(m, 150)}`);
    if (evolution.length > 0) {
      parts.push(`Feedback del usuario:\n${evolution.slice(-5).join("\n")}`);
    }
  }

  // 3. Last meaningful state — what the agent was doing/concluded
  const lastMeaningful = findLastMeaningfulResponse(
    transcript.assistantMessages,
  );
  if (lastMeaningful) {
    parts.push(`Último estado del agente: ${truncate(lastMeaningful, 500)}`);
  }

  // 4. Tools used — grouped by category for quick context
  if (transcript.toolsUsed.length > 0) {
    const simplified = transcript.toolsUsed
      .map(simplifyToolName)
      .filter((t) => t.length > 0);
    const unique = [...new Set(simplified)];
    if (unique.length > 0) {
      parts.push(`Herramientas usadas: ${unique.join(", ")}`);
    }
  }

  // 5. Session metrics (compact)
  parts.push(
    `Sesión: ${transcript.totalTurns} turnos, ${transcript.userMessages.length} msgs usuario`,
  );

  return parts.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip LOOP_SESSION protocol headers from user messages.
 */
function stripLoopHeader(msg: string): string {
  // Remove "LOOP_SESSION [sessionId=...]\n**Objetivo:** " prefix
  const stripped = msg
    .replace(/^LOOP_SESSION\s*\[.*?\]\s*/i, "")
    .replace(/^\*\*Objetivo:\*\*\s*/i, "")
    .replace(/^Llama `loop`.*?para iniciar\.\s*/i, "")
    .replace(/^__FEEDBACK__\s*/i, "")
    .trim();
  return stripped || msg.trim();
}

/**
 * Find the last assistant response that contains meaningful content
 * (not just tool calls or protocol messages).
 */
function findLastMeaningfulResponse(responses: string[]): string | null {
  for (let i = responses.length - 1; i >= 0; i--) {
    const r = responses[i];
    // Skip empty or very short responses
    if (!r || r.length < 20) continue;
    // Skip responses that are just loopAwaitInput calls
    if (r.startsWith("loopAwaitInput(")) {
      // Extract the synthesis part from loopAwaitInput(sessionId, "synthesis")
      const synthMatch = r.match(/loopAwaitInput\([^,]+,\s*"(.+)"\s*\)$/s);
      if (synthMatch?.[1]) {
        return synthMatch[1];
      }
      continue;
    }
    return r;
  }
  return null;
}

/**
 * Simplify a tool name for display.
 * e.g. "projectBrain_toolbox" → "toolbox", "mcp_rag-docs_search_memory" → "search_memory"
 */
function simplifyToolName(name: string): string {
  // Remove common prefixes
  return name
    .replace(/^projectBrain_/, "")
    .replace(/^mcp_rag-docs_/, "")
    .replace(/^mcp_github_/, "gh:")
    .replace(/^mcp_/, "");
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}
