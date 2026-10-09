/**
 * lm-tools-autohydrate-classify.ts — LLM-powered learning classification.
 *
 * Uses a fast VS Code LM (gpt-4o-mini or fallback) to determine if a synthesis
 * contains valuable learnings (bugs, root causes, architectural discoveries),
 * or is mundane conversation (clarifications, status updates, simple confirmations).
 *
 * Writes classification to disk for autohydrate-gate hook to read.
 * NO hash matching — classification is intent-based with TTL freshness only.
 *
 * Sub-tool registered via Toolbox.register("autohydrateClassify", ...).
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";
import { log } from "./logger";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface AutohydrateClassifyInput {
  sessionId: string;
  synthesis: string;
}

interface AutohydrateClassification {
  verdict: "valuable" | "mundane";
  reason: string;
  ts: number;
}

//════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════

const CLASSIFICATION_PROMPT = `You are a knowledge classifier for a developer agent. Determine if the following synthesis text contains valuable learnings that should be documented, or is mundane conversation.

Rules:
- "valuable" = The text describes:
  * Bug discovery and root cause analysis
  * Architectural discoveries or constraints
  * Solutions to errors or problems
  * Performance insights or optimizations
  * Implementation patterns that worked/failed
  * Non-obvious technical findings
  
- "mundane" = The text is:
  * Simple status update ("done", "completed 3 files")
  * Clarification question or acknowledgment
  * Greeting or social niceties
  * Procedural next-step question without new insight
  * Restatement of known information
  * Meta-discussion about the documentation system itself

Respond with ONLY one word: "valuable" or "mundane". Nothing else.

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
  verdict: "valuable" | "mundane",
  reason: string,
): void {
  const dir = getClassificationDir(cwd, sessionId);
  const filePath = join(dir, "autohydrate-classification.json");
  const data: AutohydrateClassification = { verdict, reason, ts: Date.now() };
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`[AutohydrateClassify] Failed to write classification: ${err}`);
  }
}

// ════════════════════════════════════════════════════════════════
// Tool implementation
// ════════════════════════════════════════════════════════════════

export class AutohydrateClassifyTool
  implements vscode.LanguageModelTool<AutohydrateClassifyInput>
{
  constructor(private logFn: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AutohydrateClassifyInput>,
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
      this.logFn(
        `[AutohydrateClassify] sessionId=${sessionId} verdict=${verdict}`,
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Classification: ${verdict}`),
      ]);
    } catch (err) {
      this.logFn(`[AutohydrateClassify] LM error, using heuristic: ${err}`);
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
  ): Promise<"valuable" | "mundane"> {
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
      this.logFn(
        "[AutohydrateClassify] No LM available, heuristic fallback",
      );
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
    return cleaned.includes("mundane") ? "mundane" : "valuable";
  }

  /**
   * Simple heuristic fallback when no LM is available.
   * Multi-category pattern matching for learning detection.
   */
  private heuristicClassify(text: string): "valuable" | "mundane" {
    const trimmed = text.trim();

    // Mundane patterns (high confidence)
    if (trimmed.length < 100 && trimmed.endsWith("?")) return "mundane";
    if (
      /^(listo|done|ok|entendido|got it|noted|cool|thanks|gracias)/i.test(
        trimmed,
      )
    )
      return "mundane";

    // Learning indicators (multi-category scoring)
    const LEARNING_INDICATORS = {
      discovery: /discover|find|identify|detect|reveal|uncover|realiz/i,
      causality: /because|caused by|root cause|due to|stems from|origin/i,
      solution: /fix|solve|resolve|repair|patch|workaround|remediat/i,
      architecture: /pattern|design|structure|approach|strateg/i,
      error: /error|bug|issue|problem|fail|broken|crash/i,
    };

    let score = 0;
    for (const regex of Object.values(LEARNING_INDICATORS)) {
      if (regex.test(trimmed)) score += 20;
    }

    // 50+ score (3+ categories) = valuable learning
    return score >= 50 ? "valuable" : "mundane";
  }
}
