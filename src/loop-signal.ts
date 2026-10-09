/**
 * Loop signal file management — per-session signal files for hook detection.
 *
 * MULTI-LOOP: Each loop gets its own signal file (active-loop-{sessionId}.json)
 * plus a legacy single file (active-loop.json) for backward compatibility.
 *
 * Written by LoopTool, read by hooks (PostToolUse, SessionStart, PreCompact, etc.)
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log as centralLog } from "./logger";
import { getMemoryDirWithFallback } from "./brain-paths";

function getSignalDir(): string | undefined {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) return undefined;
  const memDir = getMemoryDirWithFallback(wsRoot);
  return path.join(memDir, "sessions");
}

/**
 * Write per-session signal file so hooks can detect this specific loop.
 * Also writes legacy file for backward compat with older hook versions.
 */
/** Max age (1h) before a signal file is considered stale — reduced from 4h to prevent ghost loops */
const SIGNAL_STALE_MS = 1 * 60 * 60 * 1000;

/** Remove signal files from other sessions that are stale (>4h). */
function cleanStaleSignals(dir: string, currentSessionId: string): void {
  try {
    const files = fs.readdirSync(dir).filter(
      f => f.startsWith("active-loop-") && f.endsWith(".json"),
    );
    for (const f of files) {
      if (f === `active-loop-${currentSessionId}.json`) continue;
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > SIGNAL_STALE_MS) {
          fs.unlinkSync(fp);
          centralLog(`[Loop] Cleaned stale signal: ${f}`);
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* dir read failure — non-fatal */ }
}

export function writeActiveLoopSignal(sessionId: string, goal: string): void {
  const dir = getSignalDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });

    // Clean stale signals from old sessions before writing
    cleanStaleSignals(dir, sessionId);

    const signal = { sessionId, goal, startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString() };
    const payload = JSON.stringify(signal, null, 2);

    // Per-session file (multi-loop safe)
    const perSessionPath = path.join(dir, `active-loop-${sessionId}.json`);
    fs.writeFileSync(perSessionPath, payload, "utf-8");

    // Legacy single file (backward compat)
    const legacyPath = path.join(dir, "active-loop.json");
    fs.writeFileSync(legacyPath, payload, "utf-8");

    centralLog(`[Loop] Signal file written for ${sessionId.substring(0, 8)}`);
  } catch (err) {
    centralLog(`[Loop] Signal file write failed (non-fatal): ${err}`);
  }
}

/**
 * Remove signal files when loop ends.
 * Removes per-session file always, legacy file only if it matches this session.
 */
/**
 * Update heartbeat timestamp on the signal file without rewriting the whole thing.
 * Called periodically by LoopEngine to indicate the session is still alive.
 */
export function updateLoopHeartbeat(sessionId: string): void {
  const dir = getSignalDir();
  if (!dir) return;
  const fp = path.join(dir, `active-loop-${sessionId}.json`);
  try {
    if (!fs.existsSync(fp)) return;
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    data.lastHeartbeat = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

export function removeActiveLoopSignal(sessionId: string): void {
  const dir = getSignalDir();
  if (!dir) return;
  try {
    // Remove per-session file
    const perSessionPath = path.join(dir, `active-loop-${sessionId}.json`);
    if (fs.existsSync(perSessionPath)) {
      fs.unlinkSync(perSessionPath);
    }

    // Remove legacy file only if it belongs to this session
    const legacyPath = path.join(dir, "active-loop.json");
    if (fs.existsSync(legacyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
        if (data.sessionId === sessionId) {
          fs.unlinkSync(legacyPath);
        }
      } catch { /* if can't read, leave it — TTL will clean up */ }
    }

    centralLog(`[Loop] Signal removed for ${sessionId.substring(0, 8)}`);
  } catch { /* non-fatal */ }
}
