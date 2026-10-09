// quality-gate/destructive-gate.mjs
// Portable gate: block irreversible / destructive shell commands.
//
// Extracted verbatim (R1 parity) from the VS Code PreToolUse hook
// (`.github/hooks/scripts/pre-tool-security.mjs`, section "2. BLOCK
// destructive commands in terminal"). The pattern list is the single
// source of truth — both facades must consume THIS array, never re-declare it.
//
// Pure function. No I/O, no env, no shell. Safe to run anywhere.

import { allow, deny } from "./types.mjs";

export const GATE_ID = "destructive-command";

/**
 * Irreversible command patterns. Order is preserved so the first match wins,
 * mirroring the hook's loop semantics exactly.
 * @type {RegExp[]}
 */
export const DESTRUCTIVE_PATTERNS = [
  /rm\s+(-rf|--recursive|--force)/i,
  /del\s+\/[sq]/i,
  /Remove-Item\s+.*-Recurse\s+-Force/i,
  /git\s+push\s+.*--force/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /FORMAT\s+[A-Z]:/i,
  /mkfs\./i,
];

/**
 * Evaluate a candidate command against the destructive-pattern catalog.
 *
 * @param {string} command - The terminal command (or subagent prompt) to inspect.
 * @returns {import("./types.mjs").GateVerdict}
 */
export function checkDestructiveCommand(command) {
  const cmd = typeof command === "string" ? command : "";
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) {
      return deny(
        GATE_ID,
        `Blocked destructive command: ${pattern.source}`,
        pattern.source,
      );
    }
  }
  return allow(GATE_ID, "No destructive command pattern matched.");
}
