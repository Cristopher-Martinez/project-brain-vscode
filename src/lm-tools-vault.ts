/**
 * LM Tools — Vault sub-tools for agent-accessible credential management.
 *
 * Sub-tools:
 *   - readVaultEntry: Read a specific vault entry (returns secrets + instructions)
 *   - readVaultSummary: List all vault entries (labels + instructions, no secrets)
 *   - writeVaultEntry: Create or update a vault entry
 *   - removeVaultEntry: Delete a vault entry by label
 *
 * @module LmToolsVault
 */

import * as vscode from "vscode";
import {
  generateVaultContext,
  readVault,
  removeVaultEntry,
  upsertVaultEntry,
  initVault,
  hasVault,
  type VaultEntry,
} from "./vault-manager";

type LogFn = (msg: string) => void;

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

// ─── Read Vault Entry ───────────────────────────────────────────────────────

export class ReadVaultEntryTool
  implements vscode.LanguageModelTool<{ label?: string }>
{
  constructor(private readonly log: LogFn) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ label?: string }>,
  ): Promise<vscode.LanguageModelToolResult> {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("No workspace folder found."),
      ]);
    }

    if (!hasVault(wsRoot)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Vault not initialized. Ask the user to initialize it from Brain HQ → Vault tab.",
        ),
      ]);
    }

    const entries = readVault(wsRoot);
    const label = options.input.label;

    // If no label, return summary (labels + instructions + key names only)
    if (!label) {
      const ctx = generateVaultContext(wsRoot);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          ctx || "Vault is empty. No entries configured.",
        ),
      ]);
    }

    // Find specific entry
    const entry = entries.find(
      (e) => e.label.toLowerCase() === label.toLowerCase(),
    );
    if (!entry) {
      const available = entries.map((e) => e.label).join(", ");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Vault entry "${label}" not found. Available: ${available || "(none)"}`,
        ),
      ]);
    }

    // Return full entry including secrets
    const lines: string[] = [`## 🔑 ${entry.label}`];
    if (entry.instructions) {
      lines.push(`**Instructions**: ${entry.instructions}`);
    }
    for (const [key, value] of Object.entries(entry.secrets)) {
      lines.push(`- \`${key}\` = \`${value}\``);
    }

    this.log(`[Vault] Agent read entry: ${entry.label}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join("\n")),
    ]);
  }
}

// ─── Write Vault Entry ──────────────────────────────────────────────────────

export class WriteVaultEntryTool
  implements
    vscode.LanguageModelTool<{
      label: string;
      instructions?: string;
      secrets?: Record<string, string>;
    }>
{
  constructor(private readonly log: LogFn) {}

  async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: "Writing vault entry...",
      confirmationMessages: {
        title: "Vault Write",
        message: new vscode.MarkdownString(
          "The agent wants to write a credential to the vault. Allow?",
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{
      label: string;
      instructions?: string;
      secrets?: Record<string, string>;
    }>,
  ): Promise<vscode.LanguageModelToolResult> {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("No workspace folder found."),
      ]);
    }

    // Auto-init vault if not exists
    if (!hasVault(wsRoot)) {
      initVault(wsRoot);
    }

    const { label, instructions, secrets } = options.input;
    if (!label) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Missing "label" parameter. Provide a label for the vault entry.',
        ),
      ]);
    }

    // Merge with existing entry to avoid wiping secrets when only updating instructions
    const existing = readVault(wsRoot).find(
      (e) => e.label.toLowerCase() === label.toLowerCase(),
    );
    const entry: VaultEntry = {
      label,
      instructions: instructions ?? existing?.instructions ?? "",
      secrets: secrets ?? existing?.secrets ?? {},
    };

    upsertVaultEntry(wsRoot, entry);
    this.log(`[Vault] Agent wrote entry: ${label}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `✅ Vault entry "${label}" saved with ${Object.keys(entry.secrets).length} keys.`,
      ),
    ]);
  }
}

// ─── Remove Vault Entry ─────────────────────────────────────────────────────

export class RemoveVaultEntryTool
  implements vscode.LanguageModelTool<{ label: string }>
{
  constructor(private readonly log: LogFn) {}

  async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: "Removing vault entry...",
      confirmationMessages: {
        title: "Vault Delete",
        message: new vscode.MarkdownString(
          "The agent wants to delete a vault entry. Allow?",
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ label: string }>,
  ): Promise<vscode.LanguageModelToolResult> {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("No workspace folder found."),
      ]);
    }

    const { label } = options.input;
    if (!label) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("Missing label parameter."),
      ]);
    }

    const removed = removeVaultEntry(wsRoot, label);
    this.log(`[Vault] Agent removed entry: ${label} (${removed})`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        removed
          ? `✅ Vault entry "${label}" removed.`
          : `⚠️ Vault entry "${label}" not found.`,
      ),
    ]);
  }
}
