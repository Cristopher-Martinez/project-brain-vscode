// ============================================================
// command-gatekeeper.ts — Git branch switch protection
// Inspired by KiloCode's gatekeeper pattern:
//   - Static denylist (instant, zero cost)
//   - LLM evaluation via cheap model (ambiguous cases)
//   - GitHeadWatcher (detection layer)
// ============================================================

import * as vscode from "vscode";
import { log, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────

export interface GatekeeperDecision {
  allowed: boolean;
  reason: string;
  evaluatedBy: "static" | "llm" | "watcher";
  command: string;
  confidence: number; // 0-1
}

/** Minimal interface — avoids hard dependency on ModelRouter. */
export interface GatekeeperDeps {
  delegateTask: (
    prompt: string,
    token: vscode.CancellationToken,
    fallbackModel: vscode.LanguageModelChat,
    options?: {
      taskKind?: string;
      systemPrompt?: string;
      maxTier?: string;
      skipValidation?: boolean;
    },
  ) => Promise<{
    text: string;
    decision: { selectedModel: { id: string } };
    responseTimeMs: number;
  }>;
  token: vscode.CancellationToken;
  fallbackModel: vscode.LanguageModelChat;
}

// ─── Session Whitelist Cache (INC-05) ───────────────────────────────────

/**
 * Commands already approved by static rules this session — skip re-evaluation.
 * Only caches ALLOW results, never DENY (fail-safe).
 */
const sessionWhitelist = new Set<string>();

/** Normalize command for whitelist caching (remove trailing whitespace, lowercase). */
function commandPattern(cmd: string): string {
  return cmd.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Clear the session whitelist (call on session end). */
export function clearGatekeeperWhitelist(): void {
  sessionWhitelist.clear();
  log(`[Gatekeeper] Session whitelist cleared`);
}

// ─── Static Rules ───────────────────────────────────────────────────────

/** Patterns that ALWAYS indicate a branch switch → DENY. */
const BRANCH_SWITCH_DENY: RegExp[] = [
  /^\s*git\s+switch\b/i,
  /^\s*git\s+checkout\s+-b\b/i,
  /^\s*git\s+checkout\s+(?!--)(?!-p\b)(?!-f\b)(?!\.\s)[\w/.@-]+\s*$/i,
];

/** Commands chained with operators — split and check each. */
const CHAIN_SPLITTER = /\s*(?:&&|\|\||;|\|)\s*/;

/** Patterns that are safe git operations → ALLOW instantly. */
const SAFE_PATTERNS: RegExp[] = [
  /^\s*git\s+checkout\s+--\s/i,
  /^\s*git\s+checkout\s+-p\b/i,
  /^\s*git\s+checkout\s+-f\s+--\s/i,
  /^\s*git\s+(?:status|log|diff|show|rev-parse|ls-files)\b/i,
  /^\s*git\s+(?:stash|add|commit|push|pull|fetch)\b/i,
  /^\s*git\s+(?:merge|rebase|cherry-pick)\b/i,
  /^\s*git\s+(?:branch|tag|remote|config)\b/i,
  /^\s*git\s+(?:worktree|bisect|blame|shortlog)\b/i,
];

/** Pattern matchers for tools that perform git checkout/switch. */
const CHECKOUT_TOOL_PATTERNS: RegExp[] = [
  /git[_-]?checkout/i,
  /git[_-]?switch/i,
  /checkout[_-]?branch/i,
  /switch[_-]?branch/i,
];

/** Pattern matchers for tools that can run arbitrary shell commands. */
const COMMAND_EXEC_PATTERNS: RegExp[] = [
  /execute[_-]?command/i,
  /run[_-]?command/i,
  /run[_-]?in[_-]?terminal/i,
  /shell[_-]?exec/i,
  /run[_-]?code/i,
];

// ─── Static Evaluation ─────────────────────────────────────────────────

/**
 * Fast-path evaluation using regex rules.
 * Returns a decision if the command clearly matches, or null for ambiguous cases.
 */
export function evaluateCommandStatic(
  command: string,
): GatekeeperDecision | null {
  const trimmed = command.trim();

  // Not a git command → allow
  if (!/^\s*git\s/i.test(trimmed)) {
    return {
      allowed: true,
      reason: "Not a git command",
      evaluatedBy: "static",
      command: trimmed,
      confidence: 1.0,
    };
  }

  // Check safe patterns first (more specific)
  if (SAFE_PATTERNS.some((p) => p.test(trimmed))) {
    return {
      allowed: true,
      reason: "Safe git operation (static allow)",
      evaluatedBy: "static",
      command: trimmed,
      confidence: 1.0,
    };
  }

  // Check deny patterns
  if (BRANCH_SWITCH_DENY.some((p) => p.test(trimmed))) {
    return {
      allowed: false,
      reason: "Branch switch detected (static deny)",
      evaluatedBy: "static",
      command: trimmed,
      confidence: 0.95,
    };
  }

  // Ambiguous — needs LLM
  return null;
}

/**
 * Evaluate a potentially chained command (e.g., "git add . && git checkout main").
 * If ANY sub-command is denied, the entire chain is denied.
 */
export function evaluateChainedCommandStatic(
  command: string,
): GatekeeperDecision | null {
  const parts = command.split(CHAIN_SPLITTER).filter(Boolean);
  if (parts.length <= 1) return evaluateCommandStatic(command);

  for (const part of parts) {
    const result = evaluateCommandStatic(part.trim());
    if (result && !result.allowed) {
      return {
        ...result,
        command,
        reason: `Chain blocked: sub-command "${part.trim()}" denied — ${result.reason}`,
      };
    }
  }

  // If all sub-commands had static results and all allowed
  const allResolved = parts.every(
    (p) => evaluateCommandStatic(p.trim()) !== null,
  );
  if (allResolved) {
    return {
      allowed: true,
      reason: "All sub-commands in chain allowed (static)",
      evaluatedBy: "static",
      command,
      confidence: 1.0,
    };
  }

  return null; // Some parts ambiguous — needs LLM
}

// ─── Tool Input Extraction ──────────────────────────────────────────────

/** Check if a tool name matches a checkout tool pattern. */
export function isCheckoutTool(toolName: string): boolean {
  return CHECKOUT_TOOL_PATTERNS.some((p) => p.test(toolName));
}

/** Check if a tool can execute arbitrary shell commands. */
export function isCommandExecTool(toolName: string): boolean {
  return COMMAND_EXEC_PATTERNS.some((p) => p.test(toolName));
}

/** Extract the shell command from a tool call's input, if applicable. */
export function extractCommandFromInput(
  toolName: string,
  input: unknown,
): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  // Command execution tools: look for command/cmd/script fields
  if (isCommandExecTool(toolName)) {
    for (const key of ["command", "cmd", "script", "code"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    return null;
  }

  // Checkout tools: look for ref/branch/target fields → synthesize git command
  if (isCheckoutTool(toolName)) {
    for (const key of ["ref", "branch", "branchName", "target", "name"]) {
      if (typeof obj[key] === "string" && obj[key]) {
        return `git checkout ${obj[key]}`;
      }
    }
    return `git checkout (unknown ref)`;
  }

  return null;
}

// ─── LLM Evaluation (extracted to gatekeeper-llm.ts — INC-09) ──────────────

import { evaluateCommandWithLLM } from "./gatekeeper-llm";

// ─── Combined Evaluation ────────────────────────────────────────────────

/**
 * Evaluate a command with static rules first, then LLM fallback (if enabled).
 * INC-05: LLM is OFF by default (setting: projectBrain.gatekeeper.useLlmEvaluation).
 * Session whitelist caches ALLOW results for instant repeat evaluation.
 */
export async function evaluateCommand(
  command: string,
  context: string,
  deps: GatekeeperDeps,
): Promise<GatekeeperDecision> {
  // INC-05: Session whitelist — instant cache hit for repeated commands
  const pattern = commandPattern(command);
  if (sessionWhitelist.has(pattern)) {
    return {
      allowed: true,
      reason: "Session whitelist (cached ALLOW)",
      evaluatedBy: "static",
      command,
      confidence: 0.95,
    };
  }

  const staticResult = evaluateChainedCommandStatic(command);
  if (staticResult) {
    log(
      `[Gatekeeper] Static resolved: ${staticResult.allowed ? "ALLOW" : "DENY"} — ${staticResult.reason}`,
    );
    // Cache ALLOW results in session whitelist (never cache DENY)
    if (staticResult.allowed) {
      sessionWhitelist.add(pattern);
    }
    return staticResult;
  }

  // INC-05: LLM layer is opt-in via setting (default: false → fail-safe DENY)
  const useLlm = vscode.workspace
    .getConfiguration("projectBrain")
    .get<boolean>("gatekeeper.useLlmEvaluation", false);

  if (!useLlm) {
    log(
      `[Gatekeeper] Static inconclusive, LLM disabled — fail-safe DENY: ${command.substring(0, 80)}`,
    );
    return {
      allowed: false,
      reason: "Static inconclusive, LLM evaluation disabled (fail-safe deny)",
      evaluatedBy: "static",
      command,
      confidence: 0.5,
    };
  }

  log(
    `[Gatekeeper] Static inconclusive — escalating to LLM for: ${command.substring(0, 80)}`,
  );
  return evaluateCommandWithLLM(command, context, deps);
}

/**
 * Top-level: evaluate a tool call before it executes.
 * Used by swarm-tool-dispatch to gate dangerous operations.
 * Returns null if the tool doesn't need gating.
 */
export async function evaluateToolCall(
  toolName: string,
  toolInput: unknown,
  context: string,
  deps: GatekeeperDeps | null,
): Promise<GatekeeperDecision | null> {
  const inputPreview = JSON.stringify(toolInput).substring(0, 120);
  log(
    `[Gatekeeper] evaluateToolCall ENTRY — tool: ${toolName}, input: ${inputPreview}, hasDeps: ${!!deps}`,
  );

  // Direct checkout tools → always block
  if (isCheckoutTool(toolName)) {
    const cmd = extractCommandFromInput(toolName, toolInput) ?? toolName;
    logWarn(
      `[Gatekeeper] BLOCKED checkout tool: ${toolName}, synthesized cmd: ${cmd}`,
    );
    return {
      allowed: false,
      reason: `Checkout tool "${toolName}" blocked during auto-pilot`,
      evaluatedBy: "static",
      command: cmd,
      confidence: 1.0,
    };
  }

  // Command execution tools → inspect the command
  if (isCommandExecTool(toolName)) {
    const cmd = extractCommandFromInput(toolName, toolInput);
    if (!cmd) {
      log(
        `[Gatekeeper] exec tool ${toolName} — no command extracted, skipping`,
      );
      return null;
    }

    // Only gate git commands
    if (!/\bgit\b/i.test(cmd)) {
      log(
        `[Gatekeeper] exec tool ${toolName} — non-git command, allowing: ${cmd.substring(0, 80)}`,
      );
      return null;
    }

    log(
      `[Gatekeeper] exec tool ${toolName} — git command detected: ${cmd.substring(0, 100)}`,
    );
    if (deps) {
      return evaluateCommand(cmd, context, deps);
    }
    // No deps → use static only, deny if ambiguous
    logWarn(
      `[Gatekeeper] No LLM deps — static-only evaluation for: ${cmd.substring(0, 80)}`,
    );
    const staticResult = evaluateChainedCommandStatic(cmd);
    if (!staticResult) {
      logWarn(
        `[Gatekeeper] FAIL-SAFE DENY — ambiguous git command with no LLM: ${cmd.substring(0, 80)}`,
      );
    }
    return (
      staticResult ?? {
        allowed: false,
        reason: "Ambiguous git command — no LLM available, fail-safe deny",
        evaluatedBy: "static",
        command: cmd,
        confidence: 0.5,
      }
    );
  }

  log(`[Gatekeeper] Tool ${toolName} does not need gating`);
  return null; // Tool doesn't need gating
}

// Re-export GitHeadWatcher from its own module for consumers
export { GitHeadWatcher } from "./git-head-watcher";
// Re-export LLM evaluation for consumers
export { evaluateCommandWithLLM } from "./gatekeeper-llm";
