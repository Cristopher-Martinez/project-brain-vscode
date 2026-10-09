/**
 * Brain HQ — Extracted helpers (HTML generation + project stats).
 * Scanner logic lives in brain-hq-scanner.ts.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// Re-export scanner types and functions for backward compatibility
export type { MemoryFileInfo } from "./brain-hq-scanner";
export { scanMemoryDir, scanDocsRootDir } from "./brain-hq-scanner";

// ─── React HTML ─────────────────────────────────────────────────────────────

export function generateReactHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const distUri = vscode.Uri.joinPath(extensionUri, "dist", "webview-ui");
  const scriptFileUri = vscode.Uri.joinPath(distUri, "index.js");
  const cssFileUri = vscode.Uri.joinPath(distUri, "index.css");

  // VS Code webviews can be aggressively cached (same URI => old CSS/JS).
  // Use a stable cache buster derived from file mtimes so updates are visible
  // after compile/deploy, without forcing reloads on every refresh.
  const assetTag = getAssetsCacheBusterTag([scriptFileUri, cssFileUri]);

  const scriptUri = webview
    .asWebviewUri(scriptFileUri)
    .with({ query: `v=${assetTag}` });
  const cssUri = webview
    .asWebviewUri(cssFileUri)
    .with({ query: `v=${assetTag}` });
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} blob: data:;"/>
  <link rel="stylesheet" href="${cssUri}"/>
  <title>Brain HQ</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getAssetsCacheBusterTag(assetUris: vscode.Uri[]): string {
  const stamp = assetUris
    .map((assetUri) => {
      try {
        return fs.statSync(assetUri.fsPath).mtimeMs.toString(36);
      } catch {
        return "missing";
      }
    })
    .join("-");

  return stamp || "static";
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// ─── Project Stats (cached) ────────────────────────────────────────────────

export interface ProjectStats {
  memoryFiles: number;
  opinions: number;
  skills: number;
  agentName: string;
  agentEmoji: string;
  agentCreature: string;
  branch: string;
}

export interface ProjectStatsDeps {
  memoryPath: string;
  workspaceFsPath: string;
  opinionCount: number;
  loadIdentity?: () =>
    | { name?: string; emoji?: string; creature?: string }
    | null
    | undefined;
}

const STATS_TTL_MS = 30_000;
let cachedStats: ProjectStats | null = null;
let cachedStatsTs = 0;

export function getProjectStats(deps: ProjectStatsDeps): ProjectStats {
  const now = Date.now();
  if (cachedStats && now - cachedStatsTs < STATS_TTL_MS) return cachedStats;

  let memoryFiles = 0;
  let skills = 0;
  try {
    if (fs.existsSync(deps.memoryPath)) {
      memoryFiles = fs
        .readdirSync(deps.memoryPath)
        .filter((e) => e.endsWith(".md")).length;
    }
    const skillsDir = path.join(deps.memoryPath, "skills");
    if (fs.existsSync(skillsDir)) {
      skills = fs.readdirSync(skillsDir).filter((e) => {
        const p = path.join(skillsDir, e);
        return fs.statSync(p).isDirectory();
      }).length;
    }
  } catch {
    /* ignore */
  }

  let agentName = "Brain";
  let agentEmoji = "\uD83E\uDDE0";
  let agentCreature = "AI Assistant";
  try {
    const identity = deps.loadIdentity?.();
    if (identity) {
      agentName = identity.name || agentName;
      agentEmoji = identity.emoji || agentEmoji;
      agentCreature = identity.creature || agentCreature;
    }
  } catch {
    /* ignore */
  }

  let branch = "unknown";
  try {
    const headPath = path.join(deps.workspaceFsPath, ".git", "HEAD");
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, "utf-8").trim();
      branch = head.startsWith("ref: refs/heads/")
        ? head.replace("ref: refs/heads/", "")
        : head.substring(0, 8);
    }
  } catch {
    /* ignore */
  }

  cachedStats = {
    memoryFiles,
    opinions: deps.opinionCount,
    skills,
    agentName,
    agentEmoji,
    agentCreature,
    branch,
  };
  cachedStatsTs = now;
  return cachedStats;
}

/** Invalidate the project stats cache (call after identity or memory changes). */
export function invalidateProjectStatsCache(): void {
  cachedStats = null;
  cachedStatsTs = 0;
}

// ─── Conversation History ───────────────────────────────────────────────────

export interface ConversationHistoryEntry {
  chatSessionId: string;
  date: string;
  turns: number;
  tools: string[];
  preview: string;
  filePath: string;
}

const FM_REGEX = /^---\n([\s\S]*?)\n---/;

function yamlVal(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function yamlList(fm: string, key: string): string[] {
  const idx = fm.indexOf(`${key}:`);
  if (idx === -1) return [];
  const after = fm.slice(idx);
  const items: string[] = [];
  const lines = after.split("\n").slice(1);
  for (const line of lines) {
    const m = line.match(/^\s+-\s+(.+)$/);
    if (m) items.push(m[1].trim());
    else if (!line.match(/^\s*$/)) break;
  }
  return items;
}

function firstUserMsg(content: string): string {
  const bodyStart = content.indexOf("---", content.indexOf("---") + 3);
  const body = bodyStart > 0 ? content.slice(bodyStart + 3) : content;
  const m = body.match(
    /##\s+.*?User[^]*?\n\n([\s\S]*?)(?:\n##|\n---|\n\*\*|$)/i,
  );
  return m?.[1]?.trim().slice(0, 150) ?? body.trim().slice(0, 150);
}

function parseConvFile(filePath: string): ConversationHistoryEntry | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fmMatch = content.match(FM_REGEX);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    return {
      chatSessionId:
        yamlVal(fm, "chatSessionId") ?? path.basename(filePath, ".md"),
      date: yamlVal(fm, "date") ?? "",
      turns: parseInt(yamlVal(fm, "turns") ?? "0", 10),
      tools: yamlList(fm, "tools"),
      preview: firstUserMsg(content),
      filePath,
    };
  } catch {
    return null;
  }
}

export function loadConversationHistory(
  memoryPath: string,
): ConversationHistoryEntry[] {
  const dir = path.join(memoryPath, "conversations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseConvFile(path.join(dir, f)))
    .filter((c): c is ConversationHistoryEntry => c !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function searchConversationHistoryEntries(
  memoryPath: string,
  query: string,
  mode: "search" | "temporal",
): ConversationHistoryEntry[] {
  const all = loadConversationHistory(memoryPath);
  if (mode === "temporal") return filterTemporal(all, query);
  return filterByText(all, query);
}

function filterByText(
  convs: ConversationHistoryEntry[],
  query: string,
): ConversationHistoryEntry[] {
  if (!query.trim()) return convs;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return convs
    .map((c) => {
      const hay =
        `${c.preview} ${c.tools.join(" ")} ${c.chatSessionId}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.c);
}

function filterTemporal(
  convs: ConversationHistoryEntry[],
  query: string,
): ConversationHistoryEntry[] {
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const q = query.toLowerCase().trim();
  let from: Date | null = null;
  let to = now;

  if (q === "today" || q === "hoy") {
    from = startOfDay(now);
  } else if (q === "yesterday" || q === "ayer") {
    const y = startOfDay(now);
    y.setDate(y.getDate() - 1);
    from = y;
    to = startOfDay(now);
  } else if (q === "this week" || q === "esta semana") {
    const d = startOfDay(now);
    d.setDate(d.getDate() - d.getDay());
    from = d;
  } else {
    const daysMatch = q.match(
      /(?:last|últimos?|hace)\s*(\d+)\s*(?:days?|días?|d)/i,
    );
    if (daysMatch) {
      const d = startOfDay(now);
      d.setDate(d.getDate() - parseInt(daysMatch[1], 10));
      from = d;
    }
  }

  if (!from) {
    // Try direct date substring match
    return convs.filter((c) => c.date.includes(query));
  }

  const ft = from.getTime();
  const tt = to.getTime();
  return convs.filter((c) => {
    const t = new Date(c.date).getTime();
    return t >= ft && t <= tt;
  });
}
