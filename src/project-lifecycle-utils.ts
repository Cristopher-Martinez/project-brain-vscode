// ─── Project Lifecycle Utilities (extracted from project-lifecycle.ts) ───────
// Status display, memory folder opener, status bar update
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PROJECT_BRAIN_DIR, MEMORY_SUBDIR } from "./brain-paths";
import type { LifecycleDeps, FolderState } from "./extension-types";
import { getBootstrapStrings, type BootstrapStrings } from "./i18n";
import { showIdentityForm } from "./identity-webview";

// ─── Workspace enabled check ───────────────────────────────────────────

/**
 * Check whether Project Brain is enabled for a workspace folder.
 * Returns true if:
 *   1. `projectBrain.enabled` is explicitly true in workspace settings, OR
 *   2. A BOOT.md already exists (backward compat for existing users)
 */
export function isWorkspaceEnabled(folder: vscode.WorkspaceFolder): boolean {
  const config = vscode.workspace.getConfiguration("projectBrain", folder.uri);
  const explicit = config.get<boolean>("enabled", false);
  if (explicit) return true;

  // Backward compat: if BOOT.md exists, treat as enabled
  const bootPath = path.join(
    folder.uri.fsPath,
    PROJECT_BRAIN_DIR,
    MEMORY_SUBDIR,
    "BOOT.md",
  );
  return fs.existsSync(bootPath);
}

/**
 * Enable Project Brain for a workspace folder by setting `projectBrain.enabled = true`.
 */
export async function enableWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
  await vscode.workspace
    .getConfiguration("projectBrain", folder.uri)
    .update("enabled", true, vscode.ConfigurationTarget.WorkspaceFolder);
  // Update context key so command enablement reflects the change
  void vscode.commands.executeCommand("setContext", "projectBrain:enabled", true);
}

/**
 * Update the `projectBrain:enabled` context key based on whether any workspace folder is enabled.
 * Call this on activation and when workspace folders change.
 */
export function refreshEnabledContextKey(): void {
  const folders = vscode.workspace.workspaceFolders;
  const anyEnabled = folders?.some((f) => isWorkspaceEnabled(f)) ?? false;
  void vscode.commands.executeCommand("setContext", "projectBrain:enabled", anyEnabled);
}

/**
 * Guard that checks if any workspace has Project Brain enabled.
 * Shows an info message directing the user to initialize first.
 * Returns true if enabled, false if blocked.
 */
export function requireEnabled(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  const anyEnabled = folders?.some((f) => isWorkspaceEnabled(f)) ?? false;
  if (!anyEnabled) {
    void vscode.window.showInformationMessage(
      "Project Brain is not initialized in this workspace. Run \"Project Brain: Initialize\" first.",
      "Initialize",
    ).then((action) => {
      if (action === "Initialize") {
        void vscode.commands.executeCommand("projectBrain.init");
      }
    });
    return false;
  }
  return true;
}

// ─── Status bar helper ──────────────────────────────────────────────────

export function updateStatusBar(
  deps: Pick<LifecycleDeps, "statusBarItem">,
  text: string,
): void {
  deps.statusBarItem.text = text;
  deps.statusBarItem.show();
}

// ─── Show status webview ────────────────────────────────────────────────

export async function showStatus(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  const state = deps.getState(folder, context);
  const hasMemory = await state.bootstrapper.hasMemoryStructure();
  const ragReady = state.mcpManager.isReady();
  const stats = await state.mcpManager.getIndexStats();
  const autoVecActive = state.autoVectorizer?.isActive() || false;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const folderName = esc(folder.name);

  let statsHtml = "";
  if (stats) {
    statsHtml = `
      <tr><td>Indexed Chunks</td><td>${stats.chunks}</td></tr>
      <tr><td>Files</td><td>${stats.files}</td></tr>
      <tr><td>Last Updated</td><td>${esc(new Date(stats.lastUpdated).toLocaleString())}</td></tr>
    `;
  }

  const panel = vscode.window.createWebviewPanel(
    "projectBrainStatus",
    `Project Brain Status — ${folder.name}`,
    vscode.ViewColumn.One,
    {},
  );

  panel.webview.html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
        h2 { margin-bottom: 16px; }
        table { border-collapse: collapse; width: 100%; max-width: 500px; }
        td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
        td:first-child { font-weight: bold; width: 180px; }
        .active { color: var(--vscode-testing-iconPassed, #4ec9b0); }
        .inactive { color: var(--vscode-testing-iconFailed, #f48771); }
      </style>
    </head>
    <body>
      <h2>Project Brain Status &mdash; ${folderName}</h2>
      <table>
        <tr><td>Memory Structure</td><td class="${hasMemory ? "active" : "inactive"}">${hasMemory ? "Active" : "Not initialized"}</td></tr>
        <tr><td>RAG Backend</td><td class="${ragReady ? "active" : "inactive"}">${ragReady ? "Ready (LM Tools)" : "Not configured"}</td></tr>
        <tr><td>Auto-Vectorization</td><td class="${autoVecActive ? "active" : "inactive"}">${autoVecActive ? "Active" : "Inactive"}</td></tr>
        ${statsHtml}
      </table>
    </body>
    </html>
  `;
}

// ─── Open memory folder ─────────────────────────────────────────────────

export async function openMemoryFolder(
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const memoryFolder = config.get<string>(
    "memoryFolder",
    ".project-brain/memory",
  );
  const memoryPath = vscode.Uri.joinPath(folder.uri, memoryFolder);

  try {
    await vscode.workspace.fs.stat(memoryPath);
    const files = await vscode.workspace.fs.readDirectory(memoryPath);

    if (files.length > 0) {
      const firstFile = vscode.Uri.joinPath(memoryPath, files[0][0]);
      await vscode.window.showTextDocument(firstFile);
    } else {
      await vscode.commands.executeCommand("revealInExplorer", memoryPath);
    }
  } catch {
    vscode.window.showWarningMessage(
      "Memory folder not found. Initialize first.",
    );
  }
}

// ─── Identity wizard helper (used by initializeProject) ─────────────────

/** Run the full identity configuration wizard and regenerate agent instructions. */
export async function runIdentityWizard(
  state: FolderState,
  deps: LifecycleDeps,
): Promise<BootstrapStrings> {
  const identity = await state.identityManager.configureInteractive();
  let i18n = getBootstrapStrings(identity?.language);

  if (identity) {
    const soul = await state.identityManager.configureSoul();
    const user = await state.identityManager.configureUser();
    const prefs = await state.identityManager.configureProgrammingPrefs();

    try {
      const docs = await state.scanner.scanProject();
      const essence = state.identityManager.extractProjectEssence();
      await state.bootstrapper.generateAgentInstructions(
        docs.projectType,
        identity,
        soul,
        user,
        essence,
      );
      deps.log("Agent instructions regenerated with identity");
    } catch (err) {
      deps.log(`Failed to regenerate agent instructions: ${err}`);
    }

    const parts: string[] = [`${identity.emoji} ${identity.name}`];
    if (soul) parts.push("soul ✓");
    if (user) parts.push(`user: ${user.name}`);
    if (prefs) parts.push("prefs ✓");

    vscode.window.showInformationMessage(
      `Agent configured: ${parts.join(" | ")}`,
    );
  }

  return i18n;
}

// ─── Post-init identity setup (QuickPick-based, extracted from lifecycle) ───

/**
 * First-time scope selection: global vs workspace-only initialization.
 * Only shows if `identityScope` hasn't been explicitly set for this workspace.
 * Returns false if user cancelled (should abort init).
 */
export async function runScopeSelection(
  folder: vscode.WorkspaceFolder,
  deps: LifecycleDeps,
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("projectBrain", folder.uri);
  const currentScope = config.inspect<string>("identityScope");

  // Skip if scope was already explicitly set at workspace or folder level
  if (
    currentScope?.workspaceValue !== undefined ||
    currentScope?.workspaceFolderValue !== undefined
  ) {
    deps.log(`[Scope] Already set — skipping selection`);
    return true;
  }

  const items: vscode.QuickPickItem[] = [
    {
      label: "$(globe) Global Setup",
      description: "Same identity across all projects",
      detail:
        "Your agent name, personality, and user profile will be shared across all workspaces. " +
        "Best for personal use.",
    },
    {
      label: "$(folder) Workspace Only",
      description: "Unique identity for this project",
      detail:
        "Configure a separate agent identity just for this workspace. " +
        "Best for teams or per-project personas.",
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Project Brain — Setup Scope",
    placeHolder: "How would you like to configure Project Brain?",
    ignoreFocusOut: true,
  });

  if (!pick) return false; // cancelled

  const scope = pick.label.includes("Global") ? "global" : "project";
  try {
    await config.update(
      "identityScope",
      scope,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    deps.log(`[Scope] User selected: ${scope} — saved to workspace folder settings`);
  } catch (err) {
    // Fallback to workspace-level if folder-level fails
    deps.log(`[Scope] WorkspaceFolder update failed, trying Workspace target: ${err}`);
    try {
      await config.update(
        "identityScope",
        scope,
        vscode.ConfigurationTarget.Workspace,
      );
      deps.log(`[Scope] Saved to workspace-level settings`);
    } catch (err2) {
      deps.log(`[Scope] All update targets failed: ${err2}`);
    }
  }
  return true;
}

export async function runPostInitIdentitySetup(
  state: FolderState,
  deps: LifecycleDeps,
  i18n: BootstrapStrings,
  context: vscode.ExtensionContext,
): Promise<BootstrapStrings> {
  const globalConfig = state.identityManager.getGlobalConfig();
  const globalIdentity = globalConfig?.loadIdentity();
  const hasLocal = state.identityManager.hasLocalIdentity();
  deps.log(`[Identity] globalConfig=${!!globalConfig}, globalIdentity=${globalIdentity?.name ?? "null"}, hasLocal=${hasLocal}`);

  if (globalIdentity && !hasLocal) {
    // Global identity exists — use QuickPick for visibility
    const items: vscode.QuickPickItem[] = [
      {
        label: `$(check) Use "${globalIdentity.name}"`,
        description: `${globalIdentity.emoji} ${globalIdentity.creature}`,
        detail: "Apply your global identity to this workspace",
      },
      {
        label: "$(edit) Customize for this workspace",
        description: "Create a new identity just for this project",
        detail: "Opens the full identity wizard",
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: "Agent Identity Setup",
      placeHolder: "A global identity was found. How would you like to proceed?",
      ignoreFocusOut: true,
    });

    if (pick?.label.includes("Customize")) {
      await vscode.workspace
        .getConfiguration("projectBrain")
        .update("identityScope", "project", vscode.ConfigurationTarget.Workspace);
      state.identityManager.clearIdentityCache();
      showIdentityForm(context, state);
      return i18n;
    }
    deps.log(`[Identity] Using global identity: "${globalIdentity.name}"`);
  } else if (!state.identityManager.hasIdentity()) {
    deps.log("[Identity] No identity found — offering wizard");
    const items: vscode.QuickPickItem[] = [
      {
        label: "$(sparkle) Configure Agent Identity",
        description: "Set up name, personality, and preferences",
      },
      {
        label: "$(arrow-right) Skip for now",
        description: "Use defaults — you can configure later",
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: "Agent Identity Setup",
      placeHolder: "Would you like to configure your AI agent's identity?",
      ignoreFocusOut: true,
    });

    if (pick?.label.includes("Configure")) {
      showIdentityForm(context, state);
      return i18n;
    }
    state.identityManager.ensureDefaultIdentityFiles();
    deps.log("Default identity files created (wizard skipped)");
  }

  return i18n;
}
