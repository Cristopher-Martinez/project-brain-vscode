/** LM Tools  awaken (identity mirror) + toolbox (multiplexer). */

import * as vscode from "vscode";
import { AutoCapture } from "./auto-capture";
import { CONFIDENCE_HIGH, extractBestScore } from "./graph-utils";
import {
  extractActions,
  formatActionSuggestions,
  PLAN_RANK,
  TOOL_PLAN_REQUIREMENTS,
} from "./lm-tools-shared";
import { recordToolCallActivity } from "./loop-engine";
import { requireEnabled } from "./project-lifecycle-utils";
import { ReactiveRecall } from "./reactive-recall";
import type { SaaSClient } from "./saas-client";

// ═══════════════════════════════════════════════════════════════════════
// TOOLBOX (multiplexer — no enforcement)
// ═══════════════════════════════════════════════════════════════════════

interface ToolboxInput {
  tool: string;
  [key: string]: unknown;
}

/** Per-tool required parameters — validated at dispatch before reaching handlers. */
const TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  // searchMemory: handled by SearchMemoryTool with BOOT.md fallback
  search: ["query"],
  searchRelations: ["query"],
  grep: ["query"],
  findSkill: ["query"],
  strategyPicker: ["task"],
  rememberThis: ["note"],
  createReminder: ["message"],
  readAgentDiary: ["mode"],
  writeAgentDiary: ["mode", "learning"],
  writeVaultEntry: ["label"],
  removeVaultEntry: ["label"],
  enrichPrompt: ["prompt"],
};

export class ToolboxTool implements vscode.LanguageModelTool<ToolboxInput> {
  private handlers = new Map<string, vscode.LanguageModelTool<any>>();
  private capture: AutoCapture | null = null;
  private saasClient: SaaSClient | null = null;
  private reactiveRecall: ReactiveRecall | null = null;

  setAutoCapture(autoCapture: AutoCapture | null): void {
    this.capture = autoCapture;
  }

  setReactiveRecall(rr: ReactiveRecall | null): void {
    this.reactiveRecall = rr;
  }

  setSaaSClient(client: SaaSClient | null): void {
    this.saasClient = client;
  }

  register(name: string, handler: vscode.LanguageModelTool<any>): void {
    this.handlers.set(name, handler);
  }

  get availableTools(): string[] {
    return [...this.handlers.keys()];
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ToolboxInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation | undefined> {
    const { tool, ...params } = options.input;
    const handler = this.handlers.get(tool);
    if (!handler) return { invocationMessage: `Unknown tool: ${tool}` };
    if (handler.prepareInvocation) {
      const result = await handler.prepareInvocation(
        { ...options, input: params } as any,
        token,
      );
      return result ?? { invocationMessage: `Running ${tool}...` };
    }
    return { invocationMessage: `Running ${tool}...` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ToolboxInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // ─── Workspace activation guard ───
    if (!requireEnabled()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Project Brain is not initialized in this workspace. The user must run "Project Brain: Initialize" first.',
        ),
      ]);
    }

    const { tool, ...rawParams } = options.input;
    const params = normalizeToolboxParams(rawParams);

    const handler = this.handlers.get(tool);
    if (!handler) {
      const available = this.availableTools.join(", ");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Unknown tool: "${tool}". Available: ${available}`,
        ),
      ]);
    }

    // ─── Plan gating: block tools above user's plan tier ───
    const requiredPlan = TOOL_PLAN_REQUIREMENTS[tool] ?? "free";
    const currentPlan = this.saasClient?.currentPlan ?? "free";
    if (PLAN_RANK[currentPlan] < PLAN_RANK[requiredPlan]) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ Tool "${tool}" requires ${requiredPlan} plan (current: ${currentPlan}). Upgrade at https://projectbrain.dev/pricing`,
        ),
      ]);
    }

    // ─── Validate required params per tool ───
    const requiredParams = TOOL_REQUIRED_PARAMS[tool];
    if (requiredParams) {
      const missing = requiredParams.filter(
        (p) =>
          params[p] === undefined ||
          params[p] === null ||
          String(params[p]).trim() === "",
      );
      if (missing.length > 0) {
        // Strip unrelated params from error message to reduce confusion
        const relevantParams = Object.keys(params).filter(
          (k) => params[k] !== undefined && params[k] !== null && params[k] !== false,
        );
        const extraNote = relevantParams.length > 0
          ? ` You sent: ${relevantParams.join(", ")} — these are not used by "${tool}".`
          : "";
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `⚠️ Missing required parameter(s) for "${tool}": ${missing.join(", ")}. ` +
              `Correct: { "tool": "${tool}", ${missing.map((p) => `"${p}": "<value>"`).join(", ")} }.${extraNote}`,
          ),
        ]);
      }
    }

    // ─── writeMemory: auto-assemble structured params into content ───
    if (tool === "writeMemory" && !params.content && params.title) {
      params.content = assembleWriteMemoryContent(params);
    }

    let result = await handler.invoke(
      { ...options, input: params } as any,
      token,
    );

    // ─── Reactive Recall: surface relevant past solutions ───
    if (this.reactiveRecall && result) {
      const hints = this.reactiveRecall.getContextualHints(
        tool,
        params as Record<string, unknown>,
      );
      if (hints) {
        const existing = result.content
          .filter(
            (p): p is vscode.LanguageModelTextPart =>
              p instanceof vscode.LanguageModelTextPart,
          )
          .map((p) => p.value)
          .join("");
        result = new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(existing + hints),
        ]);
      }
    }

    // Record tool activity for loop compliance watchdog
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (sessionId) {
      recordToolCallActivity(sessionId);
    }

    // Auto-capture from writeMemory content (primary learning path in agent mode)
    if (this.capture && tool === "writeMemory" && params.content) {
      this.capture.buffer(String(params.content), "writeMemory");
    }

    // ─── Action Closure post-processor ───
    const suggestActions = vscode.workspace
      .getConfiguration("projectBrain")
      .get<boolean>("suggestActions", true);

    if (suggestActions && result) {
      // Extract text from result parts
      const textParts = result.content.filter(
        (p): p is vscode.LanguageModelTextPart =>
          p instanceof vscode.LanguageModelTextPart,
      );

      if (textParts.length > 0) {
        const fullText = textParts.map((p) => p.value).join("");
        const { cleanText, actions } = extractActions(fullText);

        if (actions.length > 0) {
          // Only show suggestions when confidence is high enough
          const bestScore = extractBestScore(fullText);
          const showActions = bestScore >= CONFIDENCE_HIGH || bestScore === 0; // 0 = no score in output (non-search tools)
          const actionSuffix = showActions
            ? formatActionSuggestions(actions)
            : "";

          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(cleanText + actionSuffix),
          ]);
        }
      }
    }

    return (
      result ??
      new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("Tool returned no result."),
      ])
    );
  }
}

//
// REGISTRATION  extracted to lm-tools-registration.ts
//

export { registerLMTools } from "./lm-tools-registration";
export type { LMToolRefs } from "./lm-tools-registration";

// ── writeMemory structured-to-content assembler ──────────────────

/**
 * When the autohydrate gate prompts the LLM to call writeMemory with
 * structured fields (title, tags, context, problem, solution, etc.),
 * this assembles them into a single markdown `content` string that
 * the WriteProjectMemoryTool handler expects.
 */
function assembleWriteMemoryContent(
  params: Record<string, unknown>,
): string {
  const s = (key: string): string => {
    const v = params[key];
    return typeof v === "string" ? v.trim() : "";
  };

  const parts: string[] = [];
  const title = s("title");
  const date = new Date().toISOString().slice(0, 10);
  const tags = s("tags");
  const status = s("status") || "resolved";

  parts.push(`## ${title || "Untitled Entry"}`);
  parts.push(`**Date**: ${date}  **Tags**: ${tags}  **Status**: ${status}`);

  if (s("context")) parts.push(`### Context\n${s("context")}`);
  if (s("problem")) parts.push(`### Problem\n${s("problem")}`);
  if (s("rootCause")) parts.push(`### Root Cause\n${s("rootCause")}`);
  if (s("solution")) parts.push(`### Solution\n${s("solution")}`);
  if (s("lessonsLearned")) parts.push(`### Lessons Learned\n${s("lessonsLearned")}`);

  return parts.join("\n");
}

function normalizeToolboxParams(
  rawParams: Record<string, unknown>,
): Record<string, unknown> {
  const nestedArgs = rawParams.args;
  if (!nestedArgs) {
    return rawParams;
  }

  let parsedArgs: Record<string, unknown> | null = null;
  if (typeof nestedArgs === "string") {
    try {
      const parsed = JSON.parse(nestedArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      }
    } catch {
      return rawParams;
    }
  } else if (typeof nestedArgs === "object" && !Array.isArray(nestedArgs)) {
    parsedArgs = nestedArgs as Record<string, unknown>;
  }

  if (!parsedArgs) {
    return rawParams;
  }

  return {
    ...parsedArgs,
    ...rawParams,
    args: nestedArgs,
  };
}
