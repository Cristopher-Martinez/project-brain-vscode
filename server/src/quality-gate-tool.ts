// server/src/quality-gate-tool.ts
// MCP facade for the portable quality-gate engine.
//
// This is the F3 facade: it exposes the SAME engine the VS Code hook uses
// (quality-gate/*.mjs) as an MCP tool, so ANY editor/client can run the gates.
// It owns ZERO gate logic — it only routes input into the shared engine and
// shapes the verdict into an MCP response.

import {
  evaluateCommand,
  evaluateContent,
  loadGateConfig,
  type GateVerdict,
} from "../../quality-gate/index.mjs";

export interface RunQualityGateArgs {
  /** Tool being evaluated (e.g. "run_in_terminal"). Optional context. */
  tool?: string;
  /** The command / prompt text to inspect (command gates). */
  command?: string;
  /** File content to inspect (content gates, e.g. secret-exposure). */
  content?: string;
  /** Destination path for content gates (skips test/fixture paths). */
  filePath?: string;
  /** Explicit list of gates to run. Defaults to all applicable gates. */
  gates?: string[];
  /** Workspace root to load per-gate severity config from. */
  rootPath?: string;
}

export interface RunQualityGateResult {
  /** Overall decision: "deny" if ANY gate blocks (deny + level deny), else "allow". */
  decision: "allow" | "deny";
  /** True if any gate denied at level "deny". */
  blocked: boolean;
  /** Per-gate verdicts (each tagged with its configured severity level). */
  verdicts: GateVerdict[];
}

/**
 * Run the portable quality gates against a candidate command and/or content.
 *
 * All gate logic + severity combination lives in the shared engine
 * (quality-gate/evaluate.mjs). This facade only loads config and delegates.
 * Command gates and content gates are combined into a single verdict set.
 */
export function runQualityGate(args: RunQualityGateArgs): RunQualityGateResult {
  const config = loadGateConfig(args.rootPath);
  const verdicts: GateVerdict[] = [];
  let blocked = false;

  if (typeof args.command === "string" && args.command.length > 0) {
    const r = evaluateCommand(args.command, { gates: args.gates, config });
    verdicts.push(...r.verdicts);
    blocked = blocked || r.blocked;
  }

  if (typeof args.content === "string" && args.content.length > 0) {
    const r = evaluateContent(args.content, {
      gates: args.gates,
      config,
      filePath: args.filePath,
    });
    verdicts.push(...r.verdicts);
    blocked = blocked || r.blocked;
  }

  return { decision: blocked ? "deny" : "allow", blocked, verdicts };
}
