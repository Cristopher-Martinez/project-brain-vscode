/**
 * projectBrain_command — Execute VS Code commands safely.
 * Replaces native `run_vscode_command` with allowlist enforcement.
 *
 * @module lm-tools-command
 */

import * as vscode from "vscode";

// ─── Types ──────────────────────────────────────────────────────
interface CommandInput {
  command: string;
  args?: unknown[];
}

/** Commands that are always safe to execute (read-only / UI navigation). */
const SAFE_COMMANDS = new Set([
  // Navigation
  "workbench.action.gotoLine",
  "workbench.action.quickOpen",
  "workbench.action.showAllSymbols",
  "editor.action.goToDeclaration",
  "editor.action.goToImplementation",
  "editor.action.goToTypeDefinition",
  "editor.action.peekDefinition",
  "editor.action.peekImplementation",
  "editor.action.referenceSearch.trigger",
  // Code intelligence (executeCommand-based)
  "vscode.executeDefinitionProvider",
  "vscode.executeTypeDefinitionProvider",
  "vscode.executeImplementationProvider",
  "vscode.executeReferenceProvider",
  "vscode.executeDocumentSymbolProvider",
  "vscode.executeWorkspaceSymbolProvider",
  "vscode.executeHoverProvider",
  "vscode.executeCompletionItemProvider",
  "vscode.executeCodeActionProvider",
  "vscode.executeDocumentRenameProvider",
  "vscode.executeSignatureHelpProvider",
  "vscode.executeCodeLensProvider",
  "vscode.executeDocumentHighlights",
  "vscode.executeFormatDocumentProvider",
  "vscode.executeFormatRangeProvider",
  "vscode.executeLinkProvider",
  "vscode.executeDocumentColorProvider",
  "vscode.executeColorPresentationProvider",
  "vscode.executeFoldingRangeProvider",
  "vscode.executeSelectionRangeProvider",
  // Editor read-only
  "workbench.action.editor.previousChange",
  "workbench.action.editor.nextChange",
  "workbench.action.openSettings",
  "workbench.action.openSettingsJson",
  "workbench.action.toggleSidebarVisibility",
  "workbench.action.focusActiveEditorGroup",
  "workbench.action.togglePanel",
  "workbench.action.output.toggleOutput",
  "workbench.action.problems.focus",
  "workbench.action.terminal.focus",
  "workbench.action.focusSideBar",
  // SCM / Git read
  "git.refresh",
  "workbench.view.scm",
  // Testing
  "testing.runAll",
  "testing.runAtCursor",
  "testing.debugAtCursor",
  "workbench.action.testing.viewOutput",
  // Explorer
  "workbench.view.explorer",
  "revealInExplorer",
  "workbench.files.action.showActiveFileInExplorer",
  // Search
  "workbench.action.findInFiles",
  "editor.action.startFindReplaceAction",
  // Debug
  "workbench.action.debug.start",
  "workbench.action.debug.stop",
  "workbench.action.debug.restart",
  // Extensions
  "workbench.extensions.search",
]);

/** Commands that are NEVER allowed (destructive / system-level). */
const BLOCKED_PATTERNS = [
  /^workbench\.action\.files\.delete/,
  /^workbench\.action\.quit/,
  /^workbench\.action\.closeAllEditors$/,
  /^workbench\.action\.closeWindow$/,
  /^git\.push/,
  /^git\.forcePush/,
  /^git\.deleteBranch/,
  /^git\.clean/,
  /^workbench\.action\.terminal\.kill/,
];

// ─── Tool ───────────────────────────────────────────────────────
export class BrainCommandTool
  implements vscode.LanguageModelTool<CommandInput>
{
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CommandInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { command, args } = options.input;

    if (!command || typeof command !== "string") {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("Error: command is required"),
      ]);
    }

    // Check blocklist first
    if (BLOCKED_PATTERNS.some((p) => p.test(command))) {
      this.log(`[Command] BLOCKED dangerous command: ${command}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Command "${command}" is blocked for safety. Destructive commands are not allowed.`,
        ),
      ]);
    }

    // If not in allowlist, warn but still execute (some commands are dynamic)
    const isSafe = SAFE_COMMANDS.has(command);
    if (!isSafe) {
      this.log(`[Command] executing non-allowlisted command: ${command}`);
    }

    try {
      const result = await vscode.commands.executeCommand(
        command,
        ...(args ?? []),
      );
      this.log(`[Command] executed: ${command}`);

      // Format result
      if (result === undefined || result === null) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Command "${command}" executed successfully (no return value).`,
          ),
        ]);
      }

      const formatted =
        typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2).slice(0, 8000);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(formatted),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[Command] error executing ${command}: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error executing "${command}": ${msg}`,
        ),
      ]);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CommandInput>,
    _token: vscode.CancellationToken,
  ) {
    const cmd = options.input.command ?? "(unknown)";
    return {
      invocationMessage: `Executing command: ${cmd}`,
    };
  }
}
