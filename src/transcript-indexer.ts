/**
 * Transcript Indexer — Converts VS Code Copilot chat transcripts (JSONL)
 * into RAG-friendly markdown documents in .project-brain/memory/conversations/.
 *
 * Flow:
 *   1. Reads JSONL from {wsStorage}/github.copilot-chat/transcripts/
 *   2. Parses events (user messages, assistant responses, tools)
 *   3. Generates markdown with YAML frontmatter per conversation
 *   4. Writes to .project-brain/memory/conversations/ → auto-vectorizer picks them up
 *
 * Incremental: tracks processed files by mtime to avoid re-processing.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";
import {
  getTranscriptsDir,
  parseTranscript,
  type TranscriptSummary,
} from "./vscode-chat-reader";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TranscriptIndexEntry {
  mtime: number;
  processedAt: number;
}

interface TranscriptIndex {
  [chatSessionId: string]: TranscriptIndexEntry;
}

interface IndexResult {
  total: number;
  processed: number;
  skipped: number;
  errors: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONVERSATIONS_DIR = "conversations";
const INDEX_FILE = ".transcript-index.json";
const MAX_ASSISTANT_LENGTH = 500;
const MIN_CONVERSATION_TURNS = 2;
const MAX_FILES_PER_PASS = 5;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB — skip huge transcripts to avoid OOM

/** Yield the event loop to prevent watchdog kills */
function yieldTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class TranscriptIndexer {
  private readonly conversationsDir: string;
  private readonly indexPath: string;
  private index: TranscriptIndex = {};

  constructor(private readonly memoryDir: string) {
    this.conversationsDir = path.join(memoryDir, CONVERSATIONS_DIR);
    this.indexPath = path.join(this.conversationsDir, INDEX_FILE);
  }

  /**
   * Index all new/changed transcripts into markdown documents.
   * Returns stats about what was processed.
   */
  async indexAll(): Promise<IndexResult> {
    const result: IndexResult = {
      total: 0,
      processed: 0,
      skipped: 0,
      errors: 0,
    };

    const transcriptsDir = getTranscriptsDir();
    if (!transcriptsDir) {
      log("[TranscriptIndexer] No transcripts directory found — skipping");
      return result;
    }

    this.ensureConversationsDir();
    this.loadIndex();

    const files = this.listTranscriptFiles(transcriptsDir);
    result.total = files.length;

    let filesProcessed = 0;
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = path.join(transcriptsDir, file);

      try {
        const stat = fs.statSync(filePath);
        const mtime = stat.mtimeMs;

        // Skip if already processed and not modified
        if (this.index[sessionId]?.mtime === mtime) {
          result.skipped++;
          continue;
        }

        // Skip oversized files to prevent OOM
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          logWarn(`[TranscriptIndexer] Skipping ${sessionId} (${(stat.size / 1024 / 1024).toFixed(1)}MB > 2MB limit)`);
          result.skipped++;
          continue;
        }

        const transcript = parseTranscript(sessionId);
        if (!transcript || transcript.totalTurns < MIN_CONVERSATION_TURNS) {
          result.skipped++;
          continue;
        }

        const markdown = formatTranscriptMarkdown(transcript);
        const outPath = path.join(
          this.conversationsDir,
          `${sessionId}.md`,
        );
        fs.writeFileSync(outPath, markdown, "utf-8");

        this.index[sessionId] = { mtime, processedAt: Date.now() };
        result.processed++;
        filesProcessed++;

        // Yield event loop every file to prevent watchdog kill
        await yieldTick();

        // Batch limit — process remaining on next activation
        if (filesProcessed >= MAX_FILES_PER_PASS) {
          log(`[TranscriptIndexer] Batch limit reached (${MAX_FILES_PER_PASS}), deferring rest`);
          break;
        }
      } catch (err) {
        logWarn(`[TranscriptIndexer] Error processing ${sessionId}: ${err}`);
        result.errors++;
      }
    }

    this.saveIndex();

    log(
      `[TranscriptIndexer] Done: ${result.processed} processed, ` +
        `${result.skipped} skipped, ${result.errors} errors ` +
        `(${result.total} total)`,
    );

    return result;
  }

  /** Get the path to the conversations output directory */
  getOutputDir(): string {
    return this.conversationsDir;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private ensureConversationsDir(): void {
    if (!fs.existsSync(this.conversationsDir)) {
      fs.mkdirSync(this.conversationsDir, { recursive: true });
      // Self-contained gitignore — conversations are private user data
      const gitignorePath = path.join(this.conversationsDir, ".gitignore");
      fs.writeFileSync(gitignorePath, "# Auto-generated: chat transcripts are user-private\n*\n!.gitignore\n", "utf-8");
    }
  }

  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, "utf-8");
        this.index = JSON.parse(raw) as TranscriptIndex;
      }
    } catch {
      this.index = {};
    }
  }

  private saveIndex(): void {
    try {
      fs.writeFileSync(
        this.indexPath,
        JSON.stringify(this.index, null, 2),
        "utf-8",
      );
    } catch (err) {
      logWarn(`[TranscriptIndexer] Failed to save index: ${err}`);
    }
  }

  private listTranscriptFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }
}

// ─── Markdown formatting ────────────────────────────────────────────────────

/**
 * Convert a parsed transcript into a RAG-friendly markdown document.
 * Format: YAML frontmatter + turns as H2 sections.
 */
function formatTranscriptMarkdown(transcript: TranscriptSummary): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push("type: conversation");
  lines.push(`chatSessionId: "${transcript.chatSessionId}"`);
  lines.push(`date: "${transcript.startTime}"`);
  lines.push(`turns: ${transcript.totalTurns}`);
  if (transcript.toolsUsed.length > 0) {
    lines.push("tools:");
    for (const tool of transcript.toolsUsed) {
      lines.push(`  - ${simplifyToolName(tool)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# Conversation ${transcript.chatSessionId.substring(0, 8)}`);
  lines.push("");

  // Build turns from interleaved user/assistant messages
  const maxTurns = Math.min(
    transcript.userMessages.length,
    transcript.assistantMessages.length,
  );

  for (let i = 0; i < maxTurns; i++) {
    lines.push(`## Turn ${i + 1}`);
    lines.push("");

    // User message (strip protocol headers)
    const userMsg = cleanUserMessage(transcript.userMessages[i]);
    if (userMsg) {
      lines.push(`**User**: ${truncate(userMsg, 300)}`);
      lines.push("");
    }

    // Assistant response (strip tool calls, keep meaningful content)
    const assistantMsg = cleanAssistantMessage(
      transcript.assistantMessages[i],
    );
    if (assistantMsg) {
      lines.push(`**Assistant**: ${truncate(assistantMsg, MAX_ASSISTANT_LENGTH)}`);
      lines.push("");
    }
  }

  // Handle trailing user message without response
  if (transcript.userMessages.length > maxTurns) {
    const lastUser = cleanUserMessage(
      transcript.userMessages[transcript.userMessages.length - 1],
    );
    if (lastUser) {
      lines.push(`## Turn ${maxTurns + 1}`);
      lines.push("");
      lines.push(`**User**: ${truncate(lastUser, 300)}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Text cleaning helpers ──────────────────────────────────────────────────

/** Strip loop protocol headers and conversation attachments */
function cleanUserMessage(msg: string): string {
  return msg
    .replace(/^LOOP_SESSION\s*\[.*?\]\s*/i, "")
    .replace(/^\*\*Objetivo:\*\*\s*/i, "")
    .replace(/^Llama `loop`.*?para iniciar\.\s*/i, "")
    .replace(/^__FEEDBACK__\s*/i, "")
    .replace(
      /\[Attachment:.*?\]/g,
      "",
    )
    .trim();
}

/** Strip tool-call JSON, keep human-readable content */
function cleanAssistantMessage(msg: string): string {
  // Remove inline tool call blocks like ```json\n{...}\n```
  let cleaned = msg.replace(/```json\s*\{[\s\S]*?\}\s*```/g, "").trim();

  // Remove loopAwaitInput wrapper, extract synthesis
  const synthMatch = cleaned.match(
    /loopAwaitInput\([^,]+,\s*"([\s\S]+?)"\s*\)/,
  );
  if (synthMatch?.[1]) {
    cleaned = synthMatch[1];
  }

  // Remove any remaining function-call-like patterns
  cleaned = cleaned
    .replace(/^[a-zA-Z_]+\([\s\S]*?\)\s*$/gm, "")
    .trim();

  return cleaned;
}

/** Simplify tool names for display */
function simplifyToolName(name: string): string {
  return name
    .replace(/^projectBrain_/, "")
    .replace(/^mcp_rag-docs_/, "")
    .replace(/^mcp_github_/, "gh:")
    .replace(/^mcp_/, "");
}

/** Truncate with ellipsis */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}
