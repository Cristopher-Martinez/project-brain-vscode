/**
 * Types and scope classification constants for DualOpinionBank.
 * Extracted to keep dual-opinion-bank.ts under 400 lines.
 */

import type { Opinion, OpinionBank } from "./opinion-bank";
import type { OfflineManager } from "./offline-manager";
import type {
  SaaSClient,
  SearchScope,
} from "./saas-client";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DualOpinion extends Opinion {
  scope: SearchScope;
  syncVersion: number;
  cloudId?: string; // Server-side UUID
  pendingSync: boolean;
}

export interface SyncSummary {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

export interface DualOpinionBankOptions {
  opinionBank: OpinionBank;
  saasClient?: SaaSClient;
  offlineManager?: OfflineManager;
  log: (msg: string) => void;
}

// ─── Scope Classification ─────────────────────────────────────────────────────

/** Keywords that indicate cross-project or universal scope. */
export const UNIVERSAL_KEYWORDS = [
  "always",
  "never",
  "every project",
  "all codebases",
  "general rule",
  "best practice",
  "anti-pattern",
  "code smell",
  "principle",
];

export const STACK_KEYWORDS = [
  "react",
  "vue",
  "angular",
  "node",
  "python",
  "rust",
  "go",
  "typescript",
  "javascript",
  "java",
  "kotlin",
  "swift",
  "rails",
  "django",
  "spring",
  "next.js",
  "express",
  "fastify",
  "hono",
];

// Pre-compiled word-boundary regexps (escape special chars like '.' in 'next.js')
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export const UNIVERSAL_REGEXPS = UNIVERSAL_KEYWORDS.map(
  (kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`),
);
export const STACK_REGEXPS = STACK_KEYWORDS.map(
  (kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`),
);
