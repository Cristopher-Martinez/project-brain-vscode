/**
 * loop-gate-file.ts — File-based gate signaling between PreToolUse hook and
 * LoopAwaitInputTool handler.
 *
 * Problem: When a PreToolUse hook returns `continue: false` (deny),
 * VS Code shows a generic "Blocked by hook" message — the agent NEVER
 * sees the actual reason. This causes the agent to guess why it was
 * blocked, retry blindly, and eventually break the loop by writing
 * directly to the user.
 *
 * Solution: The hook writes the gate reason to `.project-brain/loops/pending-gate.json`
 * and returns `continue: true` (allow). The tool handler reads + deletes
 * the file BEFORE executing, and returns the gate message as a tool result.
 * The agent sees the reason and can act accordingly.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import { getLoopsDir } from "./brain-paths";

interface GateBlockData {
  sessionId: string;
  reason: string;
  timestamp: number;
}

/**
 * Read and consume the pending gate block file (if any).
 * Returns the gate data if present and recent (< 5 min), null otherwise.
 * The file is deleted after consumption (one-shot lifecycle).
 */
export function consumeGateBlock(): GateBlockData | null {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) return null;

  const fp = join(getLoopsDir(wsRoot), "pending-gate.json");
  if (!existsSync(fp)) return null;

  try {
    const raw = readFileSync(fp, "utf8");
    const data: GateBlockData = JSON.parse(raw);

    // Delete after reading — one-shot
    try {
      unlinkSync(fp);
    } catch {
      /* best-effort cleanup */
    }

    // Only honor recent gates (< 5 min)
    if (Date.now() - (data.timestamp || 0) > 5 * 60 * 1000) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
