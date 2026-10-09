// quality-gate/index.mjs
// Portable quality-gate engine — public barrel.
//
// Single source of truth for gate logic, consumed by every facade
// (VS Code hook, MCP server). Add new gates here as they are extracted.

export { allow, deny } from "./types.mjs";
export {
  GATE_ID as DESTRUCTIVE_GATE_ID,
  DESTRUCTIVE_PATTERNS,
  checkDestructiveCommand,
} from "./destructive-gate.mjs";
export {
  GATE_ID as SECRET_GATE_ID,
  SECRET_PATTERNS,
  checkSecretExposure,
} from "./secret-gate.mjs";
export {
  GATE_LEVELS,
  DEFAULT_GATE_LEVELS,
  FALLBACK_LEVEL,
  getGateLevel,
  loadGateConfig,
} from "./config.mjs";
export {
  COMMAND_RUNNERS,
  CONTENT_RUNNERS,
  evaluateCommand,
  evaluateContent,
} from "./evaluate.mjs";
