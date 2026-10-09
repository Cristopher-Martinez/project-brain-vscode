/**
 * lm-tools-autohydrate-bypass.ts — Autohydrate gate status reader.
 *
 * Read-only tool that lets agents check the current autohydrate gate state.
 * NO toggle capability — the gate has internal mechanisms (inline heuristic,
 * LLM classification, consecutive-deny auto-bypass, grace period) that handle
 * all edge cases automatically.
 *
 * Sub-tool registered via Toolbox.register("autohydrateBypass", ...).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface AutohydrateStatusInput {
  sessionId: string;
}

interface AutohydrateState {
  lastDocTs: number | null;
  triggerCount: number;
  autohydrateBypass: boolean;
  bypassExpiresAt?: number;
  consecutiveDenies?: number;
}

// ════════════════════════════════════════════════════════════════
// Tool implementation
// ════════════════════════════════════════════════════════════════

export class AutohydrateBypassTool
  implements vscode.LanguageModelTool<AutohydrateStatusInput>
{
  constructor(private logFn: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AutohydrateStatusInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId } = options.input;

    if (!sessionId) {
      return this.text("Missing sessionId parameter.");
    }

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    const dir = getLoopDir(cwd, sessionId);
    const fp = join(dir, "autohydrate-state.json");

    if (!existsSync(fp)) {
      return this.text(
        "No autohydrate state for this session (gate uses defaults: bypass=false, denies=0).",
      );
    }

    try {
      const raw = readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
      const state: AutohydrateState = JSON.parse(raw);
      const lines = [
        `bypass: ${state.autohydrateBypass || false}`,
        `consecutiveDenies: ${state.consecutiveDenies || 0}`,
        `lastDocTs: ${state.lastDocTs ? new Date(state.lastDocTs).toISOString() : "never"}`,
        `triggerCount: ${state.triggerCount || 0}`,
      ];
      if (state.bypassExpiresAt) {
        const remaining = state.bypassExpiresAt - Date.now();
        lines.push(
          remaining > 0
            ? `bypassExpires: ${Math.round(remaining / 60000)}min`
            : `bypassExpires: EXPIRED`,
        );
      }
      return this.text(lines.join("\n"));
    } catch {
      return this.text("Failed to read autohydrate state.");
    }
  }

  private text(msg: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}
