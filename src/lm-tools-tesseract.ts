/**
 * RememberThis LM Tool — Tesseract temporal self-mailbox.
 *
 * Allows the agent to write self-reminders that survive context compaction.
 * Notes are scored (relevancy × recency × importance) and the top-scoring
 * ones are periodically re-injected via PostToolUse hook.
 *
 * Part of the Tesseract system inspired by MemGPT/Letta, Mem0, and
 * Stanford's Generative Agents.
 *
 * @module lm-tools-tesseract
 * @since 2026-03-02
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ─── Input Schema ───────────────────────────────────────────────────────────

export interface RememberThisInput {
  note: string;
  importance?: number;
}

// ─── Tool Class ─────────────────────────────────────────────────────────────

/**
 * RememberThisTool — Write temporal self-reminders to the Tesseract mailbox.
 *
 * These notes:
 * 1. Survive context compaction (PreCompact saves them to payload)
 * 2. Get re-injected periodically (PostToolUse knowledge refresh)
 * 3. Are scored by relevancy × recency × importance
 * 4. Promote to permanent opinions when they prove valuable
 */
export class RememberThisTool implements vscode.LanguageModelTool<RememberThisInput> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RememberThisInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { note, importance = 0.7 } = options.input;

    if (!note || note.trim().length < 5) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Note too short — minimum 5 characters.",
        ),
      ]);
    }

    const sessionsDir = path.join(this.memoryPath, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    // Extract lightweight entities from note text
    const entities = extractEntitiesFromNote(note);

    // Write to temporal mailbox (JSONL format)
    const mailboxPath = path.join(sessionsDir, "temporal-mailbox.jsonl");
    const noteId = `tn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const clampedImportance = Math.max(0, Math.min(1, importance));

    const entry = {
      id: noteId,
      text: note.slice(0, 400),
      importance: clampedImportance,
      timestamp: Date.now(),
      entities,
      hits: 0,
      promoted: false,
    };

    // Read existing, enforce cap (max 20), evict lowest-scored if needed
    const existing = readMailboxEntries(mailboxPath);
    existing.push(entry);

    let evicted = 0;
    let final = existing;
    const MAX_NOTES = 20;

    if (existing.length > MAX_NOTES) {
      const scored = existing.map((n) => ({
        note: n,
        score: computeNoteScore(n),
      }));
      scored.sort((a, b) => b.score - a.score);
      final = scored.slice(0, MAX_NOTES).map((s) => s.note);
      evicted = existing.length - MAX_NOTES;
    }

    const content = final.map((n) => JSON.stringify(n)).join("\n") + "\n";
    fs.writeFileSync(mailboxPath, content, "utf8");

    this.log(
      `[Tesseract] Note saved: "${note.slice(0, 60)}..." (importance: ${clampedImportance}, entities: ${entities.length})`,
    );

    const msg = `📬 Noted! "${note.slice(0, 80)}${note.length > 80 ? "..." : ""}" saved to temporal mailbox (importance: ${(clampedImportance * 100).toFixed(0)}%). Active notes: ${final.length}${evicted > 0 ? ` (${evicted} low-scored evicted)` : ""}.`;

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}

// ─── Helpers (duplicated lightly from temporal-mailbox.mjs for CJS context) ─

interface MailboxEntry {
  id: string;
  text: string;
  importance: number;
  timestamp: number;
  entities: string[];
  hits: number;
  promoted: boolean;
}

function readMailboxEntries(mailboxPath: string): MailboxEntry[] {
  try {
    if (!fs.existsSync(mailboxPath)) return [];
    const now = Date.now();
    const TTL_MS = 2 * 60 * 60 * 1000;
    return fs
      .readFileSync(mailboxPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MailboxEntry;
        } catch {
          return null;
        }
      })
      .filter(
        (n): n is MailboxEntry =>
          n !== null && !n.promoted && now - n.timestamp < TTL_MS,
      );
  } catch {
    return [];
  }
}

function computeNoteScore(note: MailboxEntry): number {
  const TTL_MS = 2 * 60 * 60 * 1000;
  const relevancy = Math.min(note.hits / 5, 1.0);
  const ageMs = Date.now() - note.timestamp;
  const recency = Math.max(0, 1 - ageMs / TTL_MS);
  return 0.4 * relevancy + 0.3 * recency + 0.3 * note.importance;
}

function extractEntitiesFromNote(text: string): string[] {
  const entities = new Set<string>();

  const fileMatches = text.match(/[\w\-./]+\.\w{1,5}/g) || [];
  for (const f of fileMatches) {
    if (f.length > 3 && f.length < 80) entities.add(f);
  }

  const funcMatches = text.match(/\b[\w]+(?:\.[\w]+)?\(\)/g) || [];
  for (const f of funcMatches) entities.add(f.replace("()", ""));

  const backtickMatches = text.match(/`([^`]+)`/g) || [];
  for (const b of backtickMatches) {
    const clean = b.replace(/`/g, "").trim();
    if (clean.length > 2 && clean.length < 60) entities.add(clean);
  }

  return [...entities].slice(0, 10);
}
