/**
 * constants.mjs — Centralized limits for hook context injection.
 * Single source of truth for all truncation budgets.
 * Hooks import these instead of hardcoding magic numbers.
 */

/** Max characters for BOOT.md injection */
export const BOOT_MAX = 1500;

/** Max characters for knowledge summary injection */
export const KNOWLEDGE_MAX = 2000;

/** Max characters for opinions block */
export const OPINIONS_MAX = 1500;

/** Max characters for identity reminder line */
export const IDENTITY_MAX = 500;

/** Max characters for strategy injection */
export const STRATEGY_MAX = 3000;

/** Max characters for per-file reads (learnings, troubleshooting) */
export const FILE_READ_MAX = 50_000;

/** Max lines to read from tool-usage.log for counter */
export const TOOL_LOG_MAX_LINES = 5000;

/** How many tool calls between knowledge re-injections */
export const KNOWLEDGE_REINJECTION_INTERVAL = 10;

/** Max learnings per mailbox file */
export const MAILBOX_MAX_LINES = 200;

/** Max bytes per mailbox file */
export const MAILBOX_MAX_BYTES = 102_400; // 100KB

/** Max characters for agent_id in paths */
export const AGENT_ID_MAX_LEN = 64;

/** Max opinions to inject (sorted by confidence) */
export const OPINIONS_TOP_N = 5;

/** Min confidence for opinion injection */
export const OPINIONS_MIN_CONFIDENCE = 0.7;
