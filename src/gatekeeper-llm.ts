/**
 * gatekeeper-llm.ts — LLM-based command evaluation for branch protection.
 *
 * Extracted from command-gatekeeper.ts (INC-09: simplification).
 * Only active when setting `projectBrain.gatekeeper.useLlmEvaluation` is true.
 */

import { log, logWarn } from "./logger";
import type { GatekeeperDecision, GatekeeperDeps } from "./command-gatekeeper";

const GATEKEEPER_PROMPT = [
  "You are a security gatekeeper for a git repository.",
  "Your ONLY job: determine if a command will SWITCH the current branch.",
  "",
  "DENY these (branch switching):",
  "- git checkout <branch-name>",
  "- git switch <branch-name>",
  "- git checkout -b <new-branch>",
  "",
  "ALLOW these (NOT branch switching):",
  "- git checkout -- <file> (restores file)",
  "- git checkout HEAD -- <file>",
  "- git restore <file>",
  "- git add, commit, push, pull, diff, log, status, etc.",
  "- Any non-git command",
  "",
  "Respond with EXACTLY one word: ALLOW or DENY",
].join("\n");

/**
 * Evaluate a command using a cheap LLM model.
 * Falls back to DENY on error (fail-safe).
 */
export async function evaluateCommandWithLLM(
  command: string,
  context: string,
  deps: GatekeeperDeps,
): Promise<GatekeeperDecision> {
  try {
    const result = await deps.delegateTask(
      `Evaluate this command:\n\`${command}\`\n\nContext: ${context}`,
      deps.token,
      deps.fallbackModel,
      {
        taskKind: "classify",
        systemPrompt: GATEKEEPER_PROMPT,
        maxTier: "free",
        skipValidation: true,
      },
    );

    const answer = result.text.trim().toUpperCase();
    const allowed = answer.startsWith("ALLOW");
    const modelId = result.decision.selectedModel.id;

    log(
      `[Gatekeeper] LLM verdict: ${allowed ? "ALLOW" : "DENY"} for "${command.substring(0, 60)}" (${modelId}, ${result.responseTimeMs}ms)`,
    );

    return {
      allowed,
      reason: allowed ? "LLM approved operation" : "LLM detected branch switch",
      evaluatedBy: "llm",
      command,
      confidence: 0.85,
    };
  } catch (err) {
    logWarn(`[Gatekeeper] LLM failed: ${err} — fail-safe DENY`);
    return {
      allowed: false,
      reason: `LLM evaluation failed — fail-safe deny`,
      evaluatedBy: "llm",
      command,
      confidence: 0.3,
    };
  }
}
