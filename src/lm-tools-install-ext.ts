import * as vscode from "vscode";
import { log } from "./logger";

// ── Types ──────────────────────────────────────────────

interface InstallExtInput {
  extensionId: string;
}

// ── Constants ──────────────────────────────────────────

/** Extensions that should never be installed via agent */
const BLOCKED_EXTENSIONS = new Set([
  "ms-vscode-remote.remote-ssh", // security: remote access
  "ms-vscode-remote.remote-containers", // security: container access
]);

/** Maximum extension ID length to prevent injection */
const MAX_ID_LENGTH = 128;

/** Pattern: publisher.extension-name */
const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;

// ── Tool ───────────────────────────────────────────────

export class BrainInstallExtensionTool implements vscode.LanguageModelTool<InstallExtInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<InstallExtInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { extensionId } = options.input;

    // ── Validate format ──
    if (!extensionId || typeof extensionId !== "string") {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Error: extensionId is required (format: publisher.name)",
        ),
      ]);
    }

    const trimmed = extensionId.trim();

    if (trimmed.length > MAX_ID_LENGTH) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error: extensionId too long (max ${MAX_ID_LENGTH} chars)`,
        ),
      ]);
    }

    if (!EXTENSION_ID_PATTERN.test(trimmed)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error: invalid extensionId format "${trimmed}". Expected: publisher.extension-name`,
        ),
      ]);
    }

    // ── Blocklist check ──
    if (BLOCKED_EXTENSIONS.has(trimmed.toLowerCase())) {
      log(`[InstallExt] BLOCKED: ${trimmed}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Extension "${trimmed}" is blocked for security reasons.`,
        ),
      ]);
    }

    // ── Check if already installed ──
    const existing = vscode.extensions.getExtension(trimmed);
    if (existing) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Extension "${trimmed}" is already installed (v${existing.packageJSON?.version ?? "unknown"}).`,
        ),
      ]);
    }

    // ── Install ──
    try {
      log(`[InstallExt] Installing: ${trimmed}`);
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        trimmed,
      );
      log(`[InstallExt] Installed: ${trimmed}`);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Extension "${trimmed}" installed successfully. A reload may be required to activate it.`,
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[InstallExt] Error installing ${trimmed}: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error installing "${trimmed}": ${msg}`,
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<InstallExtInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { extensionId } = options.input;
    return {
      invocationMessage: `Installing extension: ${extensionId ?? "(unknown)"}`,
    };
  }
}
