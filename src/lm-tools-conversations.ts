/**
 * Conversation History LM Tools — Search and browse past chat conversations.
 *
 * The TranscriptIndexer writes conversation markdown to .project-brain/memory/conversations/.
 * This tool provides three modes:
 *   - "list"     — List all conversations with metadata (date, turns, tools)
 *   - "search"   — Text search across conversation content
 *   - "temporal"  — Filter by date (e.g., "yesterday", "last week", "2026-02-20")
 *
 * Semantic search is covered by the existing searchMemory tool (conversations
 * are auto-vectorized since they live inside .project-brain/memory/).
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchConversationsInput {
  /** Search mode: list | search | temporal */
  mode: "list" | "search" | "temporal";
  /** Query string for search/temporal modes */
  query?: string;
  /** Max results to return */
  limit?: number;
}

interface ConversationMeta {
  chatSessionId: string;
  date: string;
  turns: number;
  tools: string[];
  filePath: string;
  preview: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONVERSATIONS_SUBDIR = "conversations";
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
const MAX_PREVIEW_LENGTH = 150;

// ─── Tool Class ─────────────────────────────────────────────────────────────

export class SearchConversationsTool
  implements vscode.LanguageModelTool<SearchConversationsInput>
{
  private readonly conversationsDir: string;

  constructor(
    private readonly memoryPath: string,
    private readonly logFn: (msg: string) => void,
  ) {
    this.conversationsDir = path.join(memoryPath, CONVERSATIONS_SUBDIR);
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchConversationsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { mode, query, limit = 10 } = options.input;
    this.logFn(`[searchConversations] mode=${mode} query="${query ?? ""}" limit=${limit}`);

    try {
      const conversations = this.loadConversations();

      if (conversations.length === 0) {
        return this.textResult(
          "No conversations indexed yet. They are generated automatically " +
            "from your Copilot chat history on extension activation.",
        );
      }

      let results: ConversationMeta[];
      switch (mode) {
        case "search":
          results = this.searchMode(conversations, query ?? "", limit);
          break;
        case "temporal":
          results = this.temporalMode(conversations, query ?? "", limit);
          break;
        case "list":
        default:
          results = this.listMode(conversations, limit);
          break;
      }

      return this.textResult(this.formatResults(results, mode, query));
    } catch (err) {
      this.logFn(`[searchConversations] error: ${err}`);
      return this.textResult(`Error searching conversations: ${err}`);
    }
  }

  // ─── Modes ──────────────────────────────────────────────────────────

  private listMode(conversations: ConversationMeta[], limit: number): ConversationMeta[] {
    return conversations
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
  }

  private searchMode(
    conversations: ConversationMeta[],
    query: string,
    limit: number,
  ): ConversationMeta[] {
    if (!query) return this.listMode(conversations, limit);

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = conversations
      .map((conv) => {
        const content = this.readConversationContent(conv.filePath).toLowerCase();
        let score = 0;
        for (const term of terms) {
          const count = (content.match(new RegExp(escapeRegex(term), "gi")) ?? []).length;
          score += count;
        }
        return { conv, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.conv);
  }

  private temporalMode(
    conversations: ConversationMeta[],
    query: string,
    limit: number,
  ): ConversationMeta[] {
    const range = parseTemporalQuery(query);
    if (!range) {
      return conversations
        .filter((c) => c.date.includes(query))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, limit);
    }

    return conversations
      .filter((c) => {
        const t = new Date(c.date).getTime();
        return t >= range.from && t <= range.to;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
  }

  // ─── Data loading ───────────────────────────────────────────────────

  private loadConversations(): ConversationMeta[] {
    if (!fs.existsSync(this.conversationsDir)) return [];

    const files = fs
      .readdirSync(this.conversationsDir)
      .filter((f) => f.endsWith(".md"));

    return files
      .map((f) => this.parseConversationFile(path.join(this.conversationsDir, f)))
      .filter((c): c is ConversationMeta => c !== null);
  }

  private parseConversationFile(filePath: string): ConversationMeta | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const fmMatch = content.match(FRONTMATTER_REGEX);
      if (!fmMatch) return null;

      const fm = fmMatch[1];
      const chatSessionId = extractYamlValue(fm, "chatSessionId") ?? path.basename(filePath, ".md");
      const date = extractYamlValue(fm, "date") ?? "";
      const turns = parseInt(extractYamlValue(fm, "turns") ?? "0", 10);
      const tools = extractYamlList(fm, "tools");

      // Extract first user message as preview
      const preview = extractFirstUserMessage(content);

      return { chatSessionId, date, turns, tools, filePath, preview };
    } catch {
      return null;
    }
  }

  private readConversationContent(filePath: string): string {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  // ─── Formatting ─────────────────────────────────────────────────────

  private formatResults(
    results: ConversationMeta[],
    mode: string,
    query?: string,
  ): string {
    if (results.length === 0) {
      const suffix = query ? ` matching "${query}"` : "";
      return `No conversations found${suffix}.`;
    }

    const header = this.formatHeader(mode, query, results.length);
    const items = results.map((c) => this.formatEntry(c)).join("\n");

    return `${header}\n\n${items}`;
  }

  private formatHeader(mode: string, query: string | undefined, count: number): string {
    switch (mode) {
      case "search":
        return `## 🔍 Search Results — ${count} conversation(s) matching "${query}"`;
      case "temporal":
        return `## 📅 Conversations — ${count} result(s) for "${query}"`;
      default:
        return `## 💬 Recent Conversations — ${count} total`;
    }
  }

  private formatEntry(conv: ConversationMeta): string {
    const dateStr = formatDateFriendly(conv.date);
    const toolsStr = conv.tools.length > 0
      ? ` | Tools: ${conv.tools.slice(0, 5).join(", ")}${conv.tools.length > 5 ? "..." : ""}`
      : "";
    const previewStr = conv.preview
      ? `\n  > ${truncate(conv.preview, MAX_PREVIEW_LENGTH)}`
      : "";

    return (
      `- **${dateStr}** — ${conv.turns} turns${toolsStr}` +
      ` _(${conv.chatSessionId.substring(0, 8)}...)_` +
      previewStr
    );
  }

  private textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}

// ─── Temporal parsing ───────────────────────────────────────────────────────

interface TimeRange {
  from: number;
  to: number;
}

function parseTemporalQuery(query: string): TimeRange | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const q = query.toLowerCase().trim();

  // "today" / "hoy"
  if (q === "today" || q === "hoy") {
    return { from: today.getTime(), to: now.getTime() };
  }

  // "yesterday" / "ayer"
  if (q === "yesterday" || q === "ayer") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: yesterday.getTime(), to: today.getTime() };
  }

  // "last week" / "semana pasada" / "esta semana"
  if (q === "last week" || q.includes("semana pasada")) {
    const from = new Date(today);
    from.setDate(from.getDate() - 14);
    const to = new Date(today);
    to.setDate(to.getDate() - 7);
    return { from: from.getTime(), to: to.getTime() };
  }
  if (q === "this week" || q.includes("esta semana")) {
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    return { from: from.getTime(), to: now.getTime() };
  }

  // "N days ago" / "hace N días"
  const daysAgoEn = q.match(/^(\d+)\s*days?\s*ago$/);
  const daysAgoEs = q.match(/^hace\s+(\d+)\s*d[ií]as?$/);
  const daysMatch = daysAgoEn || daysAgoEs;
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10);
    const from = new Date(today);
    from.setDate(from.getDate() - n);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: from.getTime(), to: to.getTime() };
  }

  // "last N days" / "últimos N días"
  const lastNEn = q.match(/^last\s+(\d+)\s*days?$/);
  const lastNEs = q.match(/^[uú]ltimos?\s+(\d+)\s*d[ií]as?$/);
  const lastNMatch = lastNEn || lastNEs;
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1], 10);
    const from = new Date(today);
    from.setDate(from.getDate() - n);
    return { from: from.getTime(), to: now.getTime() };
  }

  // ISO date: "2026-02-20"
  const isoMatch = q.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch) {
    const from = new Date(isoMatch[1]);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: from.getTime(), to: to.getTime() };
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractYamlValue(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m"));
  return match?.[1]?.trim();
}

function extractYamlList(yaml: string, key: string): string[] {
  const sectionMatch = yaml.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, "m"));
  if (!sectionMatch) return [];
  return sectionMatch[1]
    .split("\n")
    .map((line) => line.replace(/^\s+-\s+/, "").trim())
    .filter(Boolean);
}

function extractFirstUserMessage(content: string): string {
  const match = content.match(/\*\*User\*\*:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

function formatDateFriendly(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;

    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return isoDate;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
