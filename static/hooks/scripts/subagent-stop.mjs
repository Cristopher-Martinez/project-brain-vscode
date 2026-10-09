#!/usr/bin/env node
/**
 * SubagentStop hook — Tracking + cleanup + mailbox processing.
 * Responsibilities:
 *   1. Log completion to sessions/subagent-tracking.jsonl (pairs with SubagentStart)
 *   2. Calculate duration if start entry exists
 *   3. Track success/failure rates by agent_type for analytics
 *   4. Process learning mailbox → staging JSONL (idempotent)
 * I/O Contract:
 *   stdin  → { agent_id, agent_type, stop_hook_active, cwd, sessionId, timestamp }
 *   stdout → { continue, hookSpecificOutput?: { decision?, reason? } }
 * NOTE: This hook does NOT receive the subagent's output/results.
 *       We can only track metadata (timing, agent_type).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { guardedHook } from "./lib/hook-guard.mjs";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";

/** Format milliseconds into human-readable duration */
function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

guardedHook("subagent-stop", async (input) => {
  const { MAILBOX_MAX_BYTES, MAILBOX_MAX_LINES } =
    await import("./lib/constants.mjs");
  const { isContentSafe, sanitizeAgentId } = await import("./lib/sanitize.mjs");

  // Prevent infinite loops (spec requirement)
  if (input.stop_hook_active) {
    return { continue: true };
  }

  const cwd = input.cwd || process.cwd();
  const agentId = sanitizeAgentId(input.agent_id || "unknown");
  const agentType = input.agent_type || "unknown";
  const sessionId = input.sessionId || "unknown";
  const memoryDir = getMemoryDirWithFallback(cwd);
  const sessionsDir = join(memoryDir, "sessions");

  if (!existsSync(memoryDir)) {
    return { continue: true };
  }

  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const trackingFile = join(sessionsDir, "subagent-tracking.jsonl");
  const now = new Date();

  // ═══════════════════════════════════════════════════════════
  // 1. FIND MATCHING START ENTRY (for duration calculation)
  // ═══════════════════════════════════════════════════════════

  let durationMs = null;
  try {
    if (existsSync(trackingFile)) {
      const lines = readFileSync(trackingFile, "utf8")
        .split("\n")
        .filter(Boolean);
      // Find the most recent 'start' entry for this agentId
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.event === "start" && entry.agentId === agentId) {
            durationMs = now.getTime() - new Date(entry.t).getTime();
            break;
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 2. LOG COMPLETION
  // ═══════════════════════════════════════════════════════════

  const entry = {
    t: now.toISOString(),
    event: "stop",
    agentId,
    agentType,
    parentSession: sessionId,
    durationMs,
    durationHuman: durationMs ? formatDuration(durationMs) : null,
  };

  try {
    appendFileSync(trackingFile, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 3. AGGREGATE STATS (lightweight, per-session summary)
  // ═══════════════════════════════════════════════════════════

  try {
    if (existsSync(trackingFile)) {
      const lines = readFileSync(trackingFile, "utf8")
        .split("\n")
        .filter(Boolean);
      const stops = lines.filter((l) => {
        try {
          return JSON.parse(l).event === "stop";
        } catch {
          return false;
        }
      });

      // Every 5 subagent completions, write a summary
      if (stops.length > 0 && stops.length % 5 === 0) {
        const byType = {};
        for (const line of stops) {
          try {
            const s = JSON.parse(line);
            const type = s.agentType || "unknown";
            if (!byType[type]) byType[type] = { count: 0, totalMs: 0 };
            byType[type].count++;
            if (s.durationMs) byType[type].totalMs += s.durationMs;
          } catch {
            continue;
          }
        }

        const summary = Object.entries(byType)
          .map(
            ([type, stats]) =>
              `  - ${type}: ${stats.count} runs, avg ${formatDuration(stats.totalMs / stats.count)}`,
          )
          .join("\n");

        const summaryEntry = `\n## Subagent Analytics (${now.toISOString()})\n${summary}\n`;
        appendFileSync(
          join(sessionsDir, "subagent-analytics.md"),
          summaryEntry,
          "utf8",
        );
      }
    }
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 4. MAILBOX PROCESSING (idempotent: rename → parse → staging → cleanup)
  // ═══════════════════════════════════════════════════════════

  try {
    const mailboxFile = join(sessionsDir, `learning-mailbox-${agentId}.jsonl`);
    if (existsSync(mailboxFile)) {
      // Size guard
      const mbStats = statSync(mailboxFile);
      if (mbStats.size > 0 && mbStats.size <= MAILBOX_MAX_BYTES) {
        // Atomic claim: rename to .processing (idempotent lock)
        const processingFile = mailboxFile + ".processing";
        try {
          renameSync(mailboxFile, processingFile);
        } catch {
          // Another process claimed it — skip
          return { continue: true };
        }

        const stagingFile = join(sessionsDir, "pending-learnings.jsonl");
        const raw = readFileSync(processingFile, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        let processed = 0;

        for (const line of lines.slice(0, MAILBOX_MAX_LINES)) {
          try {
            const mbEntry = JSON.parse(line);
            // Validate structure
            if (!mbEntry.text || typeof mbEntry.text !== "string") continue;
            if (mbEntry.text.length < 10 || mbEntry.text.length > 500) continue;
            // Safety check
            if (!isContentSafe(mbEntry.text)) continue;

            // Enrich with metadata and write to staging
            const staged = {
              t: mbEntry.t || now.toISOString(),
              type: mbEntry.type || "learning",
              text: mbEntry.text,
              agentId,
              agentType,
              verified: false,
            };
            appendFileSync(stagingFile, JSON.stringify(staged) + "\n", "utf8");
            processed++;
          } catch {
            // Skip malformed lines — never crash
            continue;
          }
        }

        // Cleanup
        try {
          unlinkSync(processingFile);
        } catch {
          /* non-critical */
        }

        if (processed > 0) {
          process.stderr.write(
            `SubagentStop: processed ${processed} learnings from ${agentId}\n`,
          );
        }
      } else if (mbStats.size > MAILBOX_MAX_BYTES) {
        // Oversized mailbox — delete to prevent growth
        try {
          unlinkSync(mailboxFile);
        } catch {
          /* non-critical */
        }
      }
    }
  } catch {
    /* non-critical */
  }

  return { continue: true };
});
