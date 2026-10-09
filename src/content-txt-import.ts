import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ensureProjectBrainDirs, getMemoryDirWithFallback } from "./brain-paths";

const CONVERSATIONS_DIR = "conversations";
const SIGNAL_LINE_LIMIT = 12;
const PREVIEW_LINE_LIMIT = 6;
const MAX_LINE_LENGTH = 220;
const SESSION_ID_REGEX = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
const TOOL_HINT_REGEX = /\b(loopAwaitInput|loopEnd|hydrateLoopContext|searchMemory|commitCheckpoint|projectBrain_toolbox|projectBrain_awaken|searchConversations|loopReconnect|loopMail)\b/g;
const SIGNAL_PATTERNS = [
  /\b(error|fail|exception|trace|blocked)\b/i,
  /\b(fix|root cause|solution|resolved|regression)\b/i,
  /\b(todo|next|pending|follow-up|follow up)\b/i,
  /\b(loop|sessionid|session id|provider|model|persist)\b/i,
];

export interface ImportContentTxtResult {
  outputPath: string;
  sourcePath: string;
  sessionIds: string[];
  toolHints: string[];
  signalLines: number;
}

export interface ContentTxtPickerApi {
  showOpenDialog(
    options: vscode.OpenDialogOptions,
  ): Thenable<readonly vscode.Uri[] | undefined>;
}

export async function pickContentTxtFile(
  dialogApi: ContentTxtPickerApi = vscode.window,
): Promise<string | undefined> {
  const selection = await dialogApi.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Importar chat",
    filters: {
      "Chat text": ["txt", "md", "log"],
      "All Files": ["*"],
    },
  });

  return selection?.[0]?.fsPath;
}

export function importContentTxtFile(
  repoRoot: string,
  sourcePath: string,
): ImportContentTxtResult {
  ensureProjectBrainDirs(repoRoot);

  if (!fs.existsSync(sourcePath)) {
    throw new Error("We could not find that file anymore.");
  }

  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error("Please choose a text file, not a folder.");
  }

  const raw = fs.readFileSync(sourcePath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("That file is empty, so there is nothing useful to import.");
  }

  const memoryDir = getMemoryDirWithFallback(repoRoot);
  const conversationsDir = path.join(memoryDir, CONVERSATIONS_DIR);
  fs.mkdirSync(conversationsDir, { recursive: true });

  const timestamp = new Date();
  const docId = `manual-content-${formatFileStamp(timestamp)}`;
  const outputPath = path.join(conversationsDir, `${docId}.md`);

  const normalizedLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sessionIds = uniqueMatches(trimmed, SESSION_ID_REGEX).slice(0, 10);
  const toolHints = uniqueMatches(trimmed, TOOL_HINT_REGEX).slice(0, 12);
  const signalLines = collectSignalLines(normalizedLines);
  const headPreview = normalizedLines.slice(0, PREVIEW_LINE_LIMIT);
  const tailPreview = normalizedLines.slice(-PREVIEW_LINE_LIMIT);

  const markdown = buildImportedMarkdown({
    docId,
    sourcePath,
    importedAt: timestamp,
    rawChars: trimmed.length,
    totalLines: normalizedLines.length,
    sessionIds,
    toolHints,
    signalLines,
    headPreview,
    tailPreview,
  });

  fs.writeFileSync(outputPath, markdown, "utf8");

  const gitignorePath = path.join(conversationsDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      "# Auto-generated: imported conversation summaries are user-private\n*\n!.gitignore\n",
      "utf8",
    );
  }

  return {
    outputPath,
    sourcePath,
    sessionIds,
    toolHints,
    signalLines: signalLines.length,
  };
}

function buildImportedMarkdown(input: {
  docId: string;
  sourcePath: string;
  importedAt: Date;
  rawChars: number;
  totalLines: number;
  sessionIds: string[];
  toolHints: string[];
  signalLines: string[];
  headPreview: string[];
  tailPreview: string[];
}): string {
  const lines: string[] = [
    "---",
    `chatSessionId: \"${yamlEscape(input.docId)}\"`,
    `date: \"${input.importedAt.toISOString()}\"`,
    "turns: 0",
    `tools: [${input.toolHints.map((tool) => `\"${yamlEscape(tool)}\"`).join(", ")}]`,
    `sourceFile: \"${yamlEscape(normalizePath(input.sourcePath))}\"`,
    'importKind: "manual-content-txt"',
    "---",
    "",
    `# Imported Chat Note ${input.docId}`,
    "",
    "This note was created from a manually selected `content.txt`. The raw file is not injected into live context and is not treated as the source of truth.",
    "",
    "## Overview",
    "",
    `- Imported at: ${input.importedAt.toISOString()}`,
    `- Source file: ${normalizePath(input.sourcePath)}`,
    `- Raw chars: ${input.rawChars}`,
    `- Non-empty lines: ${input.totalLines}`,
    `- Detected session IDs: ${input.sessionIds.length}`,
    `- Detected tool hints: ${input.toolHints.length}`,
    `- Signal lines kept: ${input.signalLines.length}`,
  ];

  if (input.sessionIds.length > 0) {
    lines.push("", "## Session IDs", "");
    for (const sessionId of input.sessionIds) {
      lines.push(`- ${sessionId}`);
    }
  }

  if (input.toolHints.length > 0) {
    lines.push("", "## Tool Hints", "");
    for (const tool of input.toolHints) {
      lines.push(`- ${tool}`);
    }
  }

  if (input.signalLines.length > 0) {
    lines.push("", "## Signal Lines", "");
    for (const line of input.signalLines) {
      lines.push(`- ${line}`);
    }
  }

  lines.push("", "## Head Preview", "");
  for (const line of input.headPreview) {
    lines.push(`- ${sanitizeLine(line)}`);
  }

  lines.push("", "## Tail Preview", "");
  for (const line of input.tailPreview) {
    lines.push(`- ${sanitizeLine(line)}`);
  }

  return lines.join("\n") + "\n";
}

function collectSignalLines(lines: string[]): string[] {
  const matches = lines
    .filter((line) => SIGNAL_PATTERNS.some((pattern) => pattern.test(line)))
    .slice(0, SIGNAL_LINE_LIMIT)
    .map((line) => sanitizeLine(line));

  if (matches.length > 0) {
    return matches;
  }

  return lines.slice(0, SIGNAL_LINE_LIMIT).map((line) => sanitizeLine(line));
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern) ?? [];
  return [...new Set(matches.map((match) => match.trim()))];
}

function sanitizeLine(line: string): string {
  const squashed = line.replace(/\s+/g, " ").trim();
  return squashed.length <= MAX_LINE_LENGTH
    ? squashed
    : `${squashed.slice(0, MAX_LINE_LENGTH - 3)}...`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function yamlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

function formatFileStamp(value: Date): string {
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  const hh = String(value.getHours()).padStart(2, "0");
  const mi = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}