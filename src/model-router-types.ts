// ============================================================
// model-router-types.ts — Extracted types & constants from model-router.ts
// Source: src/model-router.ts
// ============================================================

import * as vscode from "vscode";

// ─── Task Kinds ────────────────────────────────────────────────────────────

export type DelegateTaskKind =
  | "summarize"
  | "extract-info"
  | "generate-code"
  | "generate-test"
  | "code-review"
  | "format"
  | "list"
  | "classify"
  | "transform"
  | "document"
  | "debug-analyze"
  | "refactor"
  | "raw";

// ─── Core Types ────────────────────────────────────────────────────────────

export type ModelTier = "free" | "cheap" | "standard" | "premium" | "ultra";

export type TaskType =
  | "simple-qa"
  | "code-generation"
  | "code-review"
  | "architecture"
  | "debugging"
  | "documentation"
  | "creative"
  | "bootstrap"
  | "status";

export type TaskComplexity =
  | "trivial"
  | "simple"
  | "medium"
  | "complex"
  | "expert";

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface ModelProfile {
  id: string;
  family: string;
  vendor: string;
  maxInputTokens: number;
  tier: ModelTier;
  capabilities: string[];
  performanceHistory: TaskResult[];
  successRate: Record<string, number>; // taskType -> success %
  avgResponseQuality: number; // 0-1
}

export interface TaskClassification {
  type: TaskType;
  complexity: TaskComplexity;
  estimatedTokens: number;
  requiresReasoning: boolean;
  requiresCodeUnderstanding: boolean;
}

export interface TaskResult {
  taskType: TaskType;
  complexity: TaskComplexity;
  modelId: string;
  modelFamily: string;
  timestamp: number;
  success: boolean;
  qualityScore: number; // 0-1
  responseTimeMs: number;
  responseLength: number;
  hadCodeBlocks: boolean;
  escalated: boolean;
}

export interface RoutingDecision {
  selectedModel: vscode.LanguageModelChat;
  task: TaskClassification;
  reason: string;
  wasEscalated: boolean;
}

export interface SlaveValidationResult {
  isValid: boolean;
  score: number; // 0-1
  issues: string[]; // what's wrong
  canRetry: boolean; // is it worth retrying?
  feedback: string; // what to tell the slave to fix
}

// ─── Tier Detection Maps ───────────────────────────────────────────────────

export const TIER_MAP: Record<string, ModelTier> = {
  // Ultra (3x+ cost — LAST RESORT only, the big guns)
  "claude-opus-4.6": "ultra",

  // Premium (3x cost — only for expert tasks)
  "claude-opus-4": "premium",
  "claude-opus-4.5": "premium",
  o1: "premium",
  "o1-pro": "premium",
  o3: "premium",
  "o3-pro": "premium",

  // Standard (1x cost — code gen, debugging, architecture)
  "claude-sonnet-4": "standard",
  "claude-sonnet-4.5": "standard",
  "claude-3.5-sonnet": "standard",
  "gpt-5": "standard",
  "gpt-5-codex": "standard",
  "gpt-5.2-codex": "standard",
  "gemini-2.5-pro": "standard",
  "gemini-3-pro": "standard",
  "gemini-pro": "standard",
  "gemini-1.5-pro": "standard",
  "gemini-2.0-pro": "standard",

  // Cheap (0.33x cost — good quality, low price)
  "claude-haiku-4.5": "cheap",
  "claude-3.5-haiku": "cheap",
  "claude-3-haiku": "cheap",
  "claude-haiku": "cheap",

  // Free (0x cost — use these as much as possible!)
  "gpt-4.1": "free",
  "gpt-4o": "free",
  "gpt-4o-mini": "free",
  "gpt-5-mini": "free",
  "gpt-4-turbo": "free",
  "gpt-3.5-turbo": "free",
  "grok-code": "free",
  "grok-code-fast-1": "free",
  "copilot-fast": "free",
  "gemini-flash": "free",
  "gemini-1.5-flash": "free",
  "gemini-2.0-flash": "free",
};

export const TIER_PRIORITY: Record<ModelTier, number> = {
  free: 0,
  cheap: 1,
  standard: 2,
  premium: 3,
  ultra: 4,
};

export const MIN_TIER_FOR_COMPLEXITY: Record<TaskComplexity, ModelTier> = {
  trivial: "free",
  simple: "free",
  medium: "free",
  complex: "standard",
  expert: "premium",
};

// ─── Classification Heuristics ─────────────────────────────────────────────

export const COMPLEXITY_SIGNALS: [TaskComplexity, RegExp[]][] = [
  [
    "expert",
    [
      /system design/i,
      /security audit/i,
      /performance optim/i,
      /refactor.*entire/i,
      /architect/i,
      /migrate.*from.*to/i,
      /redesign/i,
    ],
  ],
  [
    "complex",
    [
      /debug/i,
      /fix.*bug/i,
      /why.*not.*work/i,
      /refactor/i,
      /multi.?file/i,
      /error.*trace/i,
      /stack.*trace/i,
      /implement.*feature/i,
      /integrate/i,
    ],
  ],
  [
    "medium",
    [
      /explain/i,
      /how.*does/i,
      /generate.*code/i,
      /write.*function/i,
      /create.*class/i,
      /add.*test/i,
      /document/i,
      /review/i,
    ],
  ],
  [
    "simple",
    [
      /what.*is/i,
      /status/i,
      /list/i,
      /show/i,
      /search/i,
      /find/i,
      /where/i,
      /which.*file/i,
    ],
  ],
];

export const TYPE_SIGNALS: [TaskType, RegExp[]][] = [
  [
    "code-generation",
    [
      /write/i,
      /create/i,
      /generate/i,
      /implement/i,
      /add.*function/i,
      /add.*class/i,
      /add.*method/i,
      /build/i,
    ],
  ],
  [
    "code-review",
    [/review/i, /check.*code/i, /improve/i, /optimize/i, /clean.*up/i],
  ],
  [
    "architecture",
    [/architect/i, /design/i, /structure/i, /pattern/i, /system/i, /scale/i],
  ],
  [
    "debugging",
    [
      /debug/i,
      /fix/i,
      /error/i,
      /bug/i,
      /broken/i,
      /not.*work/i,
      /crash/i,
      /fail/i,
    ],
  ],
  ["documentation", [/document/i, /doc/i, /readme/i, /comment/i, /explain/i]],
  ["creative", [/name/i, /suggest/i, /idea/i, /brainstorm/i, /creative/i]],
  ["bootstrap", [/identity/i, /bootstrap/i, /who.*am.*i/i, /first.*run/i]],
  ["status", [/status/i, /health/i, /overview/i]],
  ["simple-qa", [/what/i, /where/i, /when/i, /how.*many/i, /which/i]],
];
