/**
 * lm-tools-audit-classify.ts — LLM-powered audit classification sub-tool.
 *
 * Uses a fast VS Code LM (gpt-4o-mini or fallback) to determine if a synthesis
 * reports code changes that need auditing, or is conversational/non-auditable.
 *
 * Writes classification to disk for audit-gate hook to read.
 * NO hash matching — classification is intent-based with TTL freshness only.
 *
 * Sub-tool registered via Toolbox.register("auditClassify", ...).
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";
import { log } from "./logger";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface AuditClassifyInput {
  sessionId: string;
  synthesis: string;
}

interface AuditClassification {
  verdict: "audit" | "no-audit";
  reason: string;
  ts: number;
}

// ════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════

const CLASSIFICATION_PROMPT = `You are a classification system. Determine if the following text reports code modifications that should be audited, or if it's conversational (question, acknowledgment, greeting, clarification request, brief status update without code changes).

Rules:
- "audit" = The text describes code changes, file modifications, implementation results, bug fixes, or technical work done on files.
- "no-audit" = The text is a question, greeting, acknowledgment, clarification request, or does NOT describe any code modifications.

Respond with ONLY one word: "audit" or "no-audit". Nothing else.

Text to classify:
"""
{SYNTHESIS}
"""`;

// ════════════════════════════════════════════════════════════════
// Disk I/O helpers
// ════════════════════════════════════════════════════════════════

function getClassificationDir(cwd: string, sessionId: string): string {
  const dir = getLoopDir(cwd, sessionId);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

function writeClassification(
  cwd: string,
  sessionId: string,
  verdict: "audit" | "no-audit",
  reason: string,
): void {
  const dir = getClassificationDir(cwd, sessionId);
  const filePath = join(dir, "audit-classification.json");
  const data: AuditClassification = { verdict, reason, ts: Date.now() };
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`[AuditClassify] Failed to write classification: ${err}`);
  }
}

// ════════════════════════════════════════════════════════════════
// Tool implementation
// ════════════════════════════════════════════════════════════════

export class AuditClassifyTool implements vscode.LanguageModelTool<AuditClassifyInput> {
  constructor(private logFn: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AuditClassifyInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId, synthesis } = options.input;

    if (!sessionId || !synthesis) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Missing sessionId or synthesis parameter.",
        ),
      ]);
    }

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      const verdict = await this.classifyWithLM(synthesis, token);
      writeClassification(cwd, sessionId, verdict, `llm-${verdict}`);
      this.logFn(`[AuditClassify] sessionId=${sessionId} verdict=${verdict}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Classification: ${verdict}`),
      ]);
    } catch (err) {
      this.logFn(`[AuditClassify] LM error, using heuristic: ${err}`);
      const verdict = this.heuristicClassify(synthesis);
      writeClassification(cwd, sessionId, verdict, "heuristic-fallback");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Classification: ${verdict} (heuristic fallback)`,
        ),
      ]);
    }
  }

  /**
   * Classify synthesis using a fast/cheap LLM model.
   */
  private async classifyWithLM(
    synthesis: string,
    token: vscode.CancellationToken,
  ): Promise<"audit" | "no-audit"> {
    // Prefer gpt-4o-mini (fast + cheap)
    const models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o-mini",
    });
    let model = models[0];

    if (!model) {
      // Fallback to any available copilot model
      const allModels = await vscode.lm.selectChatModels({
        vendor: "copilot",
      });
      model = allModels[0];
    }

    if (!model) {
      this.logFn("[AuditClassify] No LM available, heuristic fallback");
      return this.heuristicClassify(synthesis);
    }

    const prompt = CLASSIFICATION_PROMPT.replace(
      "{SYNTHESIS}",
      synthesis.substring(0, 2000),
    );
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, token);

    let result = "";
    for await (const chunk of response.text) {
      result += chunk;
      if (result.length > 20) break; // Only need one word
    }

    const cleaned = result.trim().toLowerCase();
    return cleaned.includes("no-audit") ? "no-audit" : "audit";
  }

  /**
   * Simple heuristic fallback when no LM is available.
   * Biased toward "audit" (safer — false positives > false negatives).
   */
  private heuristicClassify(text: string): "audit" | "no-audit" {
    const trimmed = text.trim();
    if (trimmed.length < 200 && trimmed.endsWith("?")) return "no-audit";
    const codePatterns =
      /\b(modifi|edit|updat|fix|implement|refactor|creat|delet|chang|remov|added|wrot)/i;
    if (codePatterns.test(trimmed)) return "audit";
    return "audit";
  }
}
