// quality-gate/config.mjs
// Portable quality-gate engine — per-gate severity configuration.
//
// Severity is the lever that keeps gates low-friction. A gate is NOT binary:
//   - "deny" : hard block. Reserve for the irreversible (destructive, secrets).
//   - "warn" : advisory. Detected but allowed through with a notice. Default
//              for every fallible heuristic (lesson learned: heuristics that
//              BLOCK froze loops — see TEST_CORRELATION incidents).
//   - "off"  : silenced. The gate is not even run.
//
// Pure Node builtins only. Zero deps on vscode / hook runtime / MCP.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {"deny" | "warn" | "off"} GateLevel */

/** Valid severity levels. */
export const GATE_LEVELS = /** @type {const} */ (["deny", "warn", "off"]);

/**
 * Default severity per gate. Security/irreversible gates default to "deny";
 * anything not listed falls back to "warn" (advisory, low-friction).
 * @type {Record<string, GateLevel>}
 */
export const DEFAULT_GATE_LEVELS = {
  "destructive-command": "deny",
  "secret-exposure": "deny",
};

/** Fallback when a gate has neither config override nor an explicit default. */
export const FALLBACK_LEVEL = "warn";

/**
 * Resolve the effective severity for a gate.
 * Precedence: user config override > built-in default > FALLBACK_LEVEL.
 * @param {string} gateId
 * @param {{ gates?: Record<string, string> }} [config]
 * @returns {GateLevel}
 */
export function getGateLevel(gateId, config = {}) {
  const override = config && config.gates ? config.gates[gateId] : undefined;
  if (override && GATE_LEVELS.includes(/** @type {GateLevel} */ (override))) {
    return /** @type {GateLevel} */ (override);
  }
  return DEFAULT_GATE_LEVELS[gateId] || FALLBACK_LEVEL;
}

/**
 * Load `.project-brain/quality-gates.json` from a workspace root.
 * Never throws — a missing/invalid file yields an empty config so the engine
 * falls back to safe defaults.
 * @param {string} [rootPath]
 * @returns {{ gates: Record<string, string> }}
 */
export function loadGateConfig(rootPath) {
  if (!rootPath || typeof rootPath !== "string") return { gates: {} };
  try {
    const file = join(rootPath, ".project-brain", "quality-gates.json");
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const gates =
      parsed && typeof parsed.gates === "object" && parsed.gates !== null
        ? parsed.gates
        : {};
    return { gates };
  } catch {
    return { gates: {} };
  }
}
