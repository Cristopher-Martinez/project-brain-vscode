/**
 * Post-Compact Payload — Shared utilities for post-compaction context recovery.
 * Used by: pre-tool-security.mjs (PreToolUse), post-tool-capture.mjs (PostToolUse)
 * Written by: pre-compact.mjs (PreCompact)
 * Pattern: One-shot consumption — first hook to read deletes the file.
 * Dual-channel resilience — even if PreToolUse misses it (e.g., own-tool skip),
 * PostToolUse gets a second chance.
 */
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

const PAYLOAD_FILENAME = "post-compact-payload.json";
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Read and consume the post-compact payload (one-shot).
 * Returns recovery context string for additionalContext injection, or empty string.
 * @param {string} cwd - Workspace root
 * @returns {string} Recovery context lines or ""
 */
export function consumePostCompactPayload(cwd) {
  const payloadPath = join(cwd, "docs", "memory", "sessions", PAYLOAD_FILENAME);
  if (!existsSync(payloadPath)) return "";

  try {
    const raw = readFileSync(payloadPath, "utf8");
    const payload = JSON.parse(raw);

    // Staleness check
    const ageMs = Date.now() - (payload.timestamp || 0);
    if (ageMs > MAX_AGE_MS) {
      try { unlinkSync(payloadPath); } catch {  }
      return "";
    }

    const lines = [
      `⚠️ POST-COMPACTION RECOVERY — Context was just compressed. Critical state re-injected:`,
    ];

    // Loop recovery
    const loops = payload.loops || [];
    if (loops.length > 0) {
      for (const loop of loops) {
        lines.push(
          `🔁 ACTIVE LOOP: sessionId="${loop.sessionId}" | Goal: ${loop.goal || "(none)"}`,
          `   ALL output MUST go through loopAwaitInput(sessionId="${loop.sessionId}", synthesis). NEVER respond directly.`,
        );
      }
    }

    // Identity recovery
    if (payload.identity) {
      const id = payload.identity;
      lines.push(
        `🪪 Identity: ${id.emoji || ""} ${id.name || "Unknown"} | Language: ${id.lang || "en"}`,
      );
    }

    // Deferred tool reminder
    if (payload.deferredToolReminder) {
      lines.push(
        `🔧 DEFERRED TOOLS: Call tool_search_tool_regex({ pattern: "projectBrain" }) BEFORE using loop/loopAwaitInput/loopEnd.`,
      );
    }

    // Temporal notes recovery (Tesseract)
    const temporalNotes = payload.temporalNotes || [];
    if (temporalNotes.length > 0) {
      lines.push(`📬 TEMPORAL NOTES (recovered after compaction):`);
      for (const n of temporalNotes.slice(0, 5)) {
        const ago = Math.round((Date.now() - (n.timestamp || 0)) / 60000);
        lines.push(`• [${ago}m ago] ${(n.text || "").slice(0, 120)}`);
      }
      lines.push(
        `📝 You have \`rememberThis\` tool — use it to save important discoveries for your future self.`,
      );
    }

    // Consume (one-shot) — first hook to read wins
    try { unlinkSync(payloadPath); } catch {  }

    return lines.join("\n");
  } catch {
    // Corrupt payload — clean up silently
    try { unlinkSync(payloadPath); } catch {  }
    return "";
  }
}

/**
 * Check if a post-compact payload EXISTS without consuming it.
 * Useful for conditional logic (e.g., force knowledge re-injection).
 * @param {string} cwd - Workspace root
 * @returns {boolean}
 */
export function hasPostCompactPayload(cwd) {
  const payloadPath = join(cwd, "docs", "memory", "sessions", PAYLOAD_FILENAME);
  return existsSync(payloadPath);
}
