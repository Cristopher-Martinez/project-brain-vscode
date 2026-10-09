// quality-gate/index.d.ts
// Type declarations for the portable quality-gate engine (.mjs source).
// Lets the TypeScript MCP server import the engine with full typing while the
// runtime stays a plain .mjs shared by every facade.

export type GateDecision = "allow" | "deny";
export type GateLevel = "deny" | "warn" | "off";

export interface GateVerdict {
  decision: GateDecision;
  gate: string;
  reason: string;
  matched?: string;
  level?: GateLevel;
}

export function allow(gate: string, reason?: string): GateVerdict;
export function deny(gate: string, reason: string, matched?: string): GateVerdict;

export const DESTRUCTIVE_GATE_ID: string;
export const DESTRUCTIVE_PATTERNS: RegExp[];
export function checkDestructiveCommand(command: unknown): GateVerdict;

export const SECRET_GATE_ID: string;
export const SECRET_PATTERNS: { re: RegExp; label: string }[];
export function checkSecretExposure(content: unknown, filePath?: string): GateVerdict;

export const GATE_LEVELS: readonly GateLevel[];
export const DEFAULT_GATE_LEVELS: Record<string, GateLevel>;
export const FALLBACK_LEVEL: GateLevel;
export function getGateLevel(
  gateId: string,
  config?: { gates?: Record<string, string> }
): GateLevel;
export function loadGateConfig(rootPath?: string): { gates: Record<string, string> };

export const COMMAND_RUNNERS: Record<string, (cmd: string) => GateVerdict>;
export const CONTENT_RUNNERS: Record<
  string,
  (content: string, filePath?: string) => GateVerdict
>;
export interface EvaluateOptions {
  gates?: string[];
  config?: { gates?: Record<string, string> };
  filePath?: string;
}
export interface EvaluateResult {
  decision: GateDecision;
  blocked: boolean;
  verdicts: GateVerdict[];
}
export function evaluateCommand(
  command: unknown,
  opts?: EvaluateOptions
): EvaluateResult;
export function evaluateContent(
  content: unknown,
  opts?: EvaluateOptions
): EvaluateResult;
