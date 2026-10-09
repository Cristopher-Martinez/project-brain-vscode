/**
 * lm-tools-documentation.ts — documentLearning tool for validated knowledge capture.
 *
 * Enforces structured documentation format to prevent garbage in memory files.
 * Used by autohydrate-gate to verify quality documentation was written.
 */

import * as vscode from "vscode";
import { log } from "./logger";
import * as fs from "fs";
import * as path from "path";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface DocumentLearningInput {
  /** Target file: "04_LEARNINGS.md" or "05_TROUBLESHOOTING.md" */
  file: "04_LEARNINGS.md" | "05_TROUBLESHOOTING.md";
  /** Short descriptive title (20-100 chars) */
  title: string;
  /** Comma-separated tags (e.g., "loop, quality-gate, state-management") */
  tags: string;
  /** Current status: resolved, pending, blocked */
  status: "resolved" | "pending" | "blocked";
  /** Background context — what led to this discovery */
  context: string;
  /** The problem/challenge encountered */
  problem: string;
  /** Root cause analysis — why it happened */
  rootCause: string;
  /** Solution applied (can be "N/A" if status=blocked) */
  solution: string;
  /** Key takeaways for future reference */
  lessonsLearned: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool Implementation
// ────────────────────────────────────────────────────────────────────────────

export class DocumentLearningTool
  implements vscode.LanguageModelTool<DocumentLearningInput>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DocumentLearningInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;

    // ── Validation ──────────────────────────────────────────────────────────

    const errors: string[] = [];

    if (!input.file) {
      errors.push("⚠️ Missing 'file' parameter");
    } else if (
      !["04_LEARNINGS.md", "05_TROUBLESHOOTING.md"].includes(input.file)
    ) {
      errors.push(
        `⚠️ Invalid file: "${input.file}". Must be "04_LEARNINGS.md" or "05_TROUBLESHOOTING.md"`,
      );
    }

    if (!input.title || input.title.length < 20) {
      errors.push("⚠️ 'title' must be at least 20 characters");
    }
    if (input.title && input.title.length > 100) {
      errors.push("⚠️ 'title' must be at most 100 characters");
    }

    if (!input.tags || input.tags.split(",").length < 2) {
      errors.push("⚠️ 'tags' must include at least 2 tags (comma-separated)");
    }

    if (!["resolved", "pending", "blocked"].includes(input.status || "")) {
      errors.push(
        `⚠️ 'status' must be "resolved", "pending", or "blocked" (got: "${input.status}")`,
      );
    }

    if (!input.context || input.context.length < 50) {
      errors.push("⚠️ 'context' must be at least 50 characters");
    }

    if (!input.problem || input.problem.length < 50) {
      errors.push("⚠️ 'problem' must be at least 50 characters");
    }

    if (!input.rootCause || input.rootCause.length < 50) {
      errors.push("⚠️ 'rootCause' must be at least 50 characters");
    }

    if (
      input.status === "resolved" &&
      (!input.solution || input.solution.length < 50)
    ) {
      errors.push(
        "⚠️ 'solution' must be at least 50 characters when status=resolved",
      );
    }

    if (!input.lessonsLearned || input.lessonsLearned.length < 30) {
      errors.push("⚠️ 'lessonsLearned' must be at least 30 characters");
    }

    if (errors.length > 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ VALIDATION FAILED — documentLearning requires complete, quality documentation.\n\n` +
            errors.join("\n") +
            `\n\n` +
            `**REQUIRED FORMAT**:\n` +
            `documentLearning({\n` +
            `  file: "04_LEARNINGS.md" | "05_TROUBLESHOOTING.md",\n` +
            `  title: "[Descriptive title 20-100 chars]",\n` +
            `  tags: "keyword1, keyword2, keyword3",\n` +
            `  status: "resolved" | "pending" | "blocked",\n` +
            `  context: "[Background — what led to this] (50+ chars)",\n` +
            `  problem: "[The challenge encountered] (50+ chars)",\n` +
            `  rootCause: "[Why it happened] (50+ chars)",\n` +
            `  solution: "[What fixed it] (50+ chars if resolved)",\n` +
            `  lessonsLearned: "[Key takeaways] (30+ chars)"\n` +
            `})`,
        ),
      ]);
    }

    // ── Find workspace root ─────────────────────────────────────────────────

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      log("[DocumentLearning] ERROR: No workspace folder");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "❌ No workspace folder found. Cannot write documentation.",
        ),
      ]);
    }

    // ── Format documentation entry ──────────────────────────────────────────

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    const entry = `
## ${input.title}
**Date**: ${today}  
**Tags**: ${input.tags}  
**Status**: ${input.status}

### Context
${input.context}

### Problem
${input.problem}

### Root Cause
${input.rootCause}

### Solution
${input.solution || "N/A (still blocked)"}

### Lessons Learned
${input.lessonsLearned}

---
`.trim();

    // ── Write to memory file ────────────────────────────────────────────────

    const memoryDir = path.join(wsRoot, ".project-brain", "memory");
    const targetFile = path.join(memoryDir, input.file);

    try {
      // Ensure directory exists
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }

      // Append to file
      fs.appendFileSync(targetFile, `\n${entry}\n`, "utf8");

      log(
        `[DocumentLearning] ✅ Documented to ${input.file}: "${input.title}"`,
      );

      // ── Record documentation done (for autohydrate gate tracking) ────────

      try {
        // Record documentation via direct file I/O (avoids CJS/ESM import mismatch)
        const { existsSync: ex, readFileSync: rf, writeFileSync: wf } = await import("fs");
        const { join: pj } = await import("path");
        const sid = (input as unknown as Record<string, unknown>).sessionId as string || "";
        if (sid && wsRoot) {
          const stateDir = pj(wsRoot, ".project-brain", "loops", sid);
          const statePath = pj(stateDir, "autohydrate-state.json");
          const defaults: Record<string, unknown> = { lastDocTs: null, triggerCount: 0, autohydrateBypass: false };
          let state = defaults;
          if (ex(statePath)) {
            try { state = { ...defaults, ...JSON.parse(rf(statePath, "utf8")) }; } catch { /* use defaults */ }
          }
          state.lastDocTs = Date.now();
          state.triggerCount = ((state.triggerCount as number) || 0) + 1;
          wf(statePath, JSON.stringify(state, null, 2));
        }
      } catch {
        // Non-fatal — grace period won't activate but gate still works
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `✅ DOCUMENTED — "${input.title}"\n\n` +
            `**File**: ${input.file}\n` +
            `**Status**: ${input.status}\n` +
            `**Tags**: ${input.tags}\n\n` +
            `Entry written to \`.project-brain/memory/${input.file}\`.` +
            `\n\nAutohydrate gate will now allow synthesis. You may call loopAwaitInput.`,
        ),
      ]);
    } catch (err) {
      log(`[DocumentLearning] ERROR writing to ${targetFile}: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ WRITE FAILED — Could not write to ${input.file}.\n\nError: ${err}`,
        ),
      ]);
    }
  }
}
