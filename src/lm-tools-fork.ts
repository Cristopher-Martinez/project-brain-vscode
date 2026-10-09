/**
 * Fork Isolation LM Tools
 *
 * Exposes fork-related operations as toolbox sub-tools:
 *   - provisionForkDeps: Copy node_modules to a fork on demand
 *
 * Sub-tool registered via Toolbox.register("provisionForkDeps", ...).
 */

import * as vscode from "vscode";
import { provisionForkDeps } from "./fork-isolation";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProvisionForkDepsInput {
  /** Session ID of the fork to provision. */
  sessionId: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ProvisionForkDepsTool implements vscode.LanguageModelTool<ProvisionForkDepsInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ProvisionForkDepsInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId } = options.input;

    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "❌ sessionId is required to identify the fork.",
        ),
      ]);
    }

    this.log(
      `[ProvisionForkDepsTool] provisioning node_modules for ${sessionId.slice(0, 8)}`,
    );

    const result = await provisionForkDeps(sessionId);

    const emoji = result.ok ? "✅" : "❌";
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${emoji} ${result.message}`),
    ]);
  }
}
