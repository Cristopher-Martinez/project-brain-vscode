/**
 * Bridge session state persistence.
 * Saves/loads full session snapshots to .project-brain/loops/{sessionId}/bridge-state.json
 */
import * as fs from "fs";
import * as path from "path";
import {
  AutoLoopBridgeSessionState,
  BridgeSynthesis,
  PmChatMessage,
  PmSuggestionResult,
  BridgeTaskMemoryData,
  PMProviderConfig,
} from "./auto-loop-bridge-types";
import { getBridgeStatePath, getLoopsDir } from "./brain-paths";
import { log, logError, logWarn } from "./logger";

export interface BridgeSessionSnapshot {
  state: AutoLoopBridgeSessionState;
  syntheses: BridgeSynthesis[];
  pmChatMessages: Record<string, PmChatMessage[]>;
  lastSuggestions: Record<string, PmSuggestionResult>;
  taskMemory: BridgeTaskMemoryData;
  pmProviderConfig: PMProviderConfig;
  repoRoot: string;
  identityPrompt?: string;
  savedAt: number;
}

export function saveBridgeSnapshot(
  repoRoot: string,
  snapshot: BridgeSessionSnapshot,
): void {
  try {
    const filePath = getBridgeStatePath(repoRoot, snapshot.state.sessionId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err) {
    logError(`[BridgeStateStore] save failed: ${err}`);
  }
}

export function loadBridgeSnapshot(
  repoRoot: string,
  sessionId: string,
): BridgeSessionSnapshot | null {
  try {
    const filePath = getBridgeStatePath(repoRoot, sessionId);
    if (!fs.existsSync(filePath)) { return null; }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BridgeSessionSnapshot;
  } catch (err) {
    logWarn(`[BridgeStateStore] load failed for ${sessionId}: ${err}`);
    return null;
  }
}

export function listPersistedBridgeSessions(repoRoot: string): string[] {
  try {
    const loopsDir = getLoopsDir(repoRoot);
    if (!fs.existsSync(loopsDir)) { return []; }
    const entries = fs.readdirSync(loopsDir, { withFileTypes: true });
    const sessionIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const stateFile = path.join(loopsDir, entry.name, "bridge-state.json");
      if (fs.existsSync(stateFile)) {
        sessionIds.push(entry.name);
      }
    }
    return sessionIds;
  } catch (err) {
    logWarn(`[BridgeStateStore] list failed: ${err}`);
    return [];
  }
}

export function deleteBridgeSnapshot(
  repoRoot: string,
  sessionId: string,
): void {
  try {
    const filePath = getBridgeStatePath(repoRoot, sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    logWarn(`[BridgeStateStore] delete failed for ${sessionId}: ${err}`);
  }
}