/**
 * auto-loop-task-memory — Per-session memory store for the Auto Loop Bridge.
 *
 * Persists:
 *  - objective & approved decisions
 *  - rejected suggestions
 *  - PM chat summaries per synthesis
 *  - business context
 *
 * Storage: file-based JSON in .project-brain/loops/{sessionId}/task-memory.json
 * Follows the same persistence pattern as commit-state.json.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError } from "./logger";
import { getLoopDir } from "./brain-paths";
import {
  BridgeDecision,
  BridgeTaskMemoryData,
} from "./auto-loop-bridge-types";

const TASK_MEMORY_FILENAME = "task-memory.json";

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create an empty task memory for a new bridge session.
 */
export function createEmptyTaskMemory(
  sessionId: string,
  objective: string
): BridgeTaskMemoryData {
  return {
    sessionId,
    objective,
    approvedDecisions: [],
    rejectedSuggestions: [],
    pmChatSummaries: {},
    businessContext: "",
    updatedAt: Date.now(),
  };
}

// ── Persistence ──────────────────────────────────────────────────

function getTaskMemoryPath(repoRoot: string, sessionId: string): string {
  return path.join(getLoopDir(repoRoot, sessionId), TASK_MEMORY_FILENAME);
}

/**
 * Load task memory from disk. Returns null if not found.
 */
export function loadTaskMemory(
  repoRoot: string,
  sessionId: string
): BridgeTaskMemoryData | null {
  const filePath = getTaskMemoryPath(repoRoot, sessionId);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BridgeTaskMemoryData;
  } catch (err) {
    logError(`[TaskMemory] Failed to load for ${sessionId}: ${err}`);
    return null;
  }
}

/**
 * Save task memory to disk. Creates loop dir if needed.
 */
export function saveTaskMemory(
  repoRoot: string,
  data: BridgeTaskMemoryData
): boolean {
  const loopDir = getLoopDir(repoRoot, data.sessionId);
  const filePath = path.join(loopDir, TASK_MEMORY_FILENAME);
  try {
    if (!fs.existsSync(loopDir)) {
      fs.mkdirSync(loopDir, { recursive: true });
    }
    data.updatedAt = Date.now();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    log(`[TaskMemory] Saved for session ${data.sessionId}`);
    return true;
  } catch (err) {
    logError(`[TaskMemory] Failed to save for ${data.sessionId}: ${err}`);
    return false;
  }
}

// ── Mutations ────────────────────────────────────────────────────

/**
 * Record an approved decision in task memory.
 */
export function addDecision(
  data: BridgeTaskMemoryData,
  decision: BridgeDecision
): BridgeTaskMemoryData {
  return {
    ...data,
    approvedDecisions: [...data.approvedDecisions, decision],
    updatedAt: Date.now(),
  };
}

/**
 * Record a rejected suggestion summary.
 */
export function addRejection(
  data: BridgeTaskMemoryData,
  summary: string
): BridgeTaskMemoryData {
  return {
    ...data,
    rejectedSuggestions: [...data.rejectedSuggestions, summary],
    updatedAt: Date.now(),
  };
}

/**
 * Update the PM chat summary for a given synthesis.
 */
export function updatePmChatSummary(
  data: BridgeTaskMemoryData,
  synthesisId: string,
  summary: string
): BridgeTaskMemoryData {
  return {
    ...data,
    pmChatSummaries: { ...data.pmChatSummaries, [synthesisId]: summary },
    updatedAt: Date.now(),
  };
}

/**
 * Set or update business context.
 */
export function setBusinessContext(
  data: BridgeTaskMemoryData,
  context: string
): BridgeTaskMemoryData {
  return {
    ...data,
    businessContext: context,
    updatedAt: Date.now(),
  };
}

/**
 * Build a compact decisions summary for PM context assembly.
 * Returns a short text block with the last N approved decisions.
 */
export function buildDecisionsSummary(
  data: BridgeTaskMemoryData,
  maxDecisions: number = 10
): string {
  const recent = data.approvedDecisions.slice(-maxDecisions);
  if (recent.length === 0) {
    return "No approved decisions yet.";
  }
  return recent
    .map(
      (d, i) =>
        `${i + 1}. [${new Date(d.approvedAt).toISOString().slice(0, 16)}] ${d.summary}`
    )
    .join("\n");
}
