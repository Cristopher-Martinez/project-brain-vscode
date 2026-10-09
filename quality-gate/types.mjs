// quality-gate/types.mjs
// Portable quality-gate engine — shared types (JSDoc typedefs).
//
// This module is the SINGLE SOURCE OF TRUTH for gate logic. It has ZERO
// dependencies on `vscode.*`, the Copilot hook runtime, or the MCP server.
// It is consumed by BOTH facades:
//   - the VS Code PreToolUse hook (.github/hooks/scripts/) — F2
//   - the MCP server `run_quality_gate` tool (server/src/) — F3
//
// Pure Node builtins only. Pure functions in, plain verdicts out.

/**
 * @typedef {"allow" | "deny"} GateDecision
 */

/**
 * The verdict returned by every quality gate. Plain data, serializable,
 * host-agnostic. Facades translate this into their own emit/response shape.
 *
 * `decision` is the raw FINDING (did the gate trigger?); `level` is the
 * configured POLICY (how hard to act on it). The orchestrator combines them:
 * only `decision: "deny"` + `level: "deny"` blocks.
 *
 * @typedef {Object} GateVerdict
 * @property {GateDecision} decision  - "allow" to proceed, "deny" if the gate triggered.
 * @property {string}       gate      - Stable gate id (e.g. "destructive-command").
 * @property {string}       reason    - Human-readable explanation of the verdict.
 * @property {string} [matched]       - The specific pattern/rule that triggered a deny.
 * @property {import("./config.mjs").GateLevel} [level] - Configured severity (set by the orchestrator).
 */

/**
 * Helper: build an "allow" verdict.
 * @param {string} gate
 * @param {string} [reason]
 * @returns {GateVerdict}
 */
export function allow(gate, reason = "OK") {
  return { decision: "allow", gate, reason };
}

/**
 * Helper: build a "deny" verdict.
 * @param {string} gate
 * @param {string} reason
 * @param {string} [matched]
 * @returns {GateVerdict}
 */
export function deny(gate, reason, matched) {
  return { decision: "deny", gate, reason, ...(matched ? { matched } : {}) };
}
