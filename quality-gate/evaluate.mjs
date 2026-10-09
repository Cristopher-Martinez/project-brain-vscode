// quality-gate/evaluate.mjs
// Portable quality-gate engine — the orchestrator.
//
// This is the SINGLE place that combines (gate detection) x (configured
// severity) into an actionable result. BOTH facades (VS Code hook, MCP tool)
// call this so the deny/warn/off semantics stay identical everywhere.
//
// Combination rule:
//   - level "off"            -> gate is skipped entirely.
//   - decision "deny" + "deny"  -> BLOCK (blocked = true).
//   - decision "deny" + "warn"  -> advisory: surfaced but NOT blocking.
//   - decision "allow"          -> clean.
//
// Pure Node builtins only. Zero deps on vscode / hook runtime / MCP.

import { checkDestructiveCommand } from "./destructive-gate.mjs";
import { checkSecretExposure } from "./secret-gate.mjs";
import { getGateLevel } from "./config.mjs";

/**
 * Registry of command-inspecting gates. Add new gates here as they are
 * extracted into the engine — every facade picks them up for free.
 * @type {Record<string, (cmd: string) => import("./types.mjs").GateVerdict>}
 */
export const COMMAND_RUNNERS = {
  "destructive-command": checkDestructiveCommand,
};

/**
 * Registry of content-inspecting gates. These evaluate file content being
 * written (create_file / edit), not shell commands.
 * @type {Record<string, (content: string, filePath?: string) => import("./types.mjs").GateVerdict>}
 */
export const CONTENT_RUNNERS = {
  "secret-exposure": checkSecretExposure,
};

/**
 * @typedef {Object} EvaluateOptions
 * @property {string[]} [gates]  - Explicit subset of gate ids to run. Defaults to all.
 * @property {{ gates?: Record<string, string> }} [config] - Loaded severity config.
 * @property {string} [filePath] - Destination path (content gates only; skips test/fixtures).
 */

/**
 * @typedef {Object} EvaluateResult
 * @property {"allow" | "deny"} decision - "deny" if any gate blocks, else "allow".
 * @property {boolean} blocked           - True if any gate denied at level "deny".
 * @property {import("./types.mjs").GateVerdict[]} verdicts - Per-gate verdicts (level-tagged).
 */

/**
 * Evaluate a candidate command against the configured command gates.
 * @param {unknown} command
 * @param {EvaluateOptions} [opts]
 * @returns {EvaluateResult}
 */
export function evaluateCommand(command, opts = {}) {
  const cmd = typeof command === "string" ? command : "";
  const wanted = opts.gates;
  const config = opts.config || {};

  /** @type {import("./types.mjs").GateVerdict[]} */
  const verdicts = [];
  let blocked = false;

  for (const [id, run] of Object.entries(COMMAND_RUNNERS)) {
    if (wanted && !wanted.includes(id)) continue;
    const level = getGateLevel(id, config);
    if (level === "off") continue;

    const verdict = run(cmd);
    verdict.level = level;
    verdicts.push(verdict);

    if (verdict.decision === "deny" && level === "deny") blocked = true;
  }

  return { decision: blocked ? "deny" : "allow", blocked, verdicts };
}

/**
 * Evaluate file content against the configured content gates (e.g. secrets).
 * Same severity semantics as evaluateCommand.
 * @param {unknown} content
 * @param {EvaluateOptions} [opts]
 * @returns {EvaluateResult}
 */
export function evaluateContent(content, opts = {}) {
  const text = typeof content === "string" ? content : "";
  const filePath = typeof opts.filePath === "string" ? opts.filePath : "";
  const wanted = opts.gates;
  const config = opts.config || {};

  /** @type {import("./types.mjs").GateVerdict[]} */
  const verdicts = [];
  let blocked = false;

  for (const [id, run] of Object.entries(CONTENT_RUNNERS)) {
    if (wanted && !wanted.includes(id)) continue;
    const level = getGateLevel(id, config);
    if (level === "off") continue;

    const verdict = run(text, filePath);
    verdict.level = level;
    verdicts.push(verdict);

    if (verdict.decision === "deny" && level === "deny") blocked = true;
  }

  return { decision: blocked ? "deny" : "allow", blocked, verdicts };
}
