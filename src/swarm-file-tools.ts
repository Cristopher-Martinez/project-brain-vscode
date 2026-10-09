// ─── Swarm File Tools ──────────────────────────────────────────────────
// Virtual file tool implementations for swarm workers.
// Workers use these instead of chat-participant-only tools.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  BINARY_EXTENSIONS,
  MAX_FILE_CHARS,
  MAX_FILE_SIZE_BYTES,
  MAX_GREP_RESULTS,
  MAX_GREP_FILES,
} from "./swarm-tool-defs";

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Resolve a relative path within the workspace.
 * Returns null if the path escapes the workspace root (security).
 * Normalizes backslashes to forward slashes before resolving so that
 * LLM-generated paths like "src\\file.ts" work on Linux/macOS too.
 */
export function resolveWsPath(
  relativePath: string,
): { abs: string; root: string } | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  const normalized = (relativePath || ".").replace(/\\/g, "/");
  const abs = path.resolve(root, normalized);
  // Security: must be exactly root or inside root + separator
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return { abs, root };
}

export function executeReadFile(input: {
  filePath?: string;
  startLine?: number;
  endLine?: number;
}): string {
  if (!input.filePath) return "Error: filePath is required";
  const resolved = resolveWsPath(input.filePath);
  if (!resolved) return "Error: invalid path or no workspace open";

  try {
    const stat = fs.statSync(resolved.abs);
    if (stat.isDirectory()) {
      return `Error: "${input.filePath}" is a directory. Use swarm_list_dir instead.`;
    }
    if (isBinaryFile(resolved.abs)) {
      return `Error: "${input.filePath}" is a binary file — cannot display contents.`;
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return (
        `Error: "${input.filePath}" is too large ` +
        `(${(stat.size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB). ` +
        `Use startLine/endLine to read specific ranges, or swarm_grep to search within it.`
      );
    }

    const content = fs.readFileSync(resolved.abs, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(1, input.startLine ?? 1);
    const end = Math.min(lines.length, input.endLine ?? lines.length);

    const selected = lines.slice(start - 1, end);
    const numbered = selected
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n");

    if (numbered.length > MAX_FILE_CHARS) {
      return (
        `File: ${input.filePath} (lines ${start}-${end} of ${lines.length}, TRUNCATED)\n` +
        `${numbered.substring(0, MAX_FILE_CHARS)}\n\n` +
        `[... truncated — use startLine/endLine for smaller ranges]`
      );
    }
    return `File: ${input.filePath} (lines ${start}-${end} of ${lines.length})\n${numbered}`;
  } catch (err: unknown) {
    return `Error reading "${input.filePath}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function executeListDir(input: { dirPath?: string }): string {
  const resolved = resolveWsPath(input.dirPath || ".");
  if (!resolved) return "Error: invalid path or no workspace open";

  try {
    const entries = fs.readdirSync(resolved.abs, { withFileTypes: true });
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const relDir =
      path.relative(resolved.root, resolved.abs).replace(/\\/g, "/") || ".";
    const listing = sorted
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
    return `Directory: ${relDir} (${entries.length} entries)\n${listing}`;
  } catch (err: unknown) {
    return `Error listing "${input.dirPath || "."}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeGrep(input: {
  pattern?: string;
  include?: string;
}): Promise<string> {
  if (!input.pattern) return "Error: pattern is required";
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return "Error: no workspace open";

  const include = input.include || "**/*.{ts,js,json,md}";
  const exclude =
    "{**/node_modules/**,**/dist/**,**/.git/**,**/trained_model/**}";

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, "i");
  } catch {
    regex = new RegExp(
      input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
  }

  const uris = await vscode.workspace.findFiles(
    include,
    exclude,
    MAX_GREP_FILES,
  );
  const results: string[] = [];

  for (const uri of uris) {
    if (results.length >= MAX_GREP_RESULTS) break;
    try {
      const content = fs.readFileSync(uri.fsPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const relPath = path.relative(root, uri.fsPath).replace(/\\/g, "/");
          results.push(
            `${relPath}:${i + 1}: ${lines[i].trimEnd().substring(0, 200)}`,
          );
          if (results.length >= MAX_GREP_RESULTS) break;
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  return results.length > 0
    ? `Found ${results.length} match(es) for "${input.pattern}":\n${results.join("\n")}`
    : `No matches found for "${input.pattern}" in ${include}`;
}
