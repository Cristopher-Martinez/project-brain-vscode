// ─── Project Lifecycle Functions (extracted from extension.ts) ──────────────
// Responsibility: project init, scan, memory check, auto-vectorizer, status
import * as path from "path";
import * as vscode from "vscode";
import { AutoVectorizer } from "./auto-vectorizer";
import { ensureProjectBrainDirs, migrateFromLegacyPaths } from "./brain-paths";
import { excludeFromGit } from "./cloud-commands";
import { getBootstrapStrings, interpolate } from "./i18n";
import { SessionManager } from "./session-manager";
import type { LifecycleDeps, FolderState } from "./extension-types";
import { isWorkspaceEnabled, updateStatusBar, openMemoryFolder, runPostInitIdentitySetup, runScopeSelection } from "./project-lifecycle-utils";

// ─── Check project memory on startup ──────────────────────────────────────

export async function checkProjectMemory(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  const state = deps.getState(folder, context);
  const hasMemory = await state.bootstrapper.hasMemoryStructure();
  deps.log(`[${folder.name}] hasMemory: ${hasMemory}`);

  if (!hasMemory) {
    // When workspace lockdown is active, let the sidebar welcome view handle onboarding
    // instead of showing a competing notification prompt
    if (!isWorkspaceEnabled(folder)) {
      deps.log(`[${folder.name}] Not enabled — skipping auto-init prompt (welcome view handles it)`);
      return;
    }

    const config = vscode.workspace.getConfiguration("projectBrain");
    const autoInit = config.get<boolean>("autoScan", true);

    if (autoInit) {
      const i18n = getBootstrapStrings();
      const folderLabel =
        (vscode.workspace.workspaceFolders?.length || 0) > 1
          ? ` (${folder.name})`
          : "";

      const answer = await vscode.window.showInformationMessage(
        interpolate(i18n.noMemoryFound, { folder: folderLabel }),
        i18n.yes,
        i18n.notNow,
        i18n.dontAskAgain,
      );

      if (answer === i18n.yes) {
        await initializeProject(folder, context, deps);
      } else if (answer === i18n.dontAskAgain) {
        await vscode.workspace
          .getConfiguration("projectBrain")
          .update("autoScan", false, vscode.ConfigurationTarget.Workspace);
      }
    }
  } else {
    updateStatusBar(deps, "Project Brain Active");
    await state.mcpManager.setupMCP();
    await state.mcpManager.syncIndex();

    // Auto-update hooks if bundled version is newer than deployed
    // NOTE: Must run BEFORE refreshAgentInstructionsIfGlobal, which also deploys hooks
    await checkAndUpdateHooksVersion(state, folder, context, deps);

    // Refresh agent instructions if scope is global (picks up latest global identity)
    await refreshAgentInstructionsIfGlobal(state, folder, deps);

    // Update TreeView with current status
    const stats = await state.mcpManager.getIndexStats();
    deps.treeDataProvider.updateStatus({
      memoryActive: true,
      ragReady: state.mcpManager.isReady(),
      indexStats: stats,
      workspaceFolder: folder,
    });

    await initializeAutoVectorizer(folder, context, deps);
    if (state.autoVectorizer) {
      state.autoVectorizer.autoStartIfEnabled().then((started) => {
        deps.treeDataProvider.updateStatus({
          autoVecActive: started,
          workspaceFolder: folder,
        });
      });
    }
  }
}

// ─── Initialize project (first-time setup) ─────────────────────────────────

export async function initializeProject(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  // Auth gate: require login before init (login is global, always available)
  const saasClient = deps.getSaasClient();
  if (saasClient) {
    try {
      await saasClient.requireAuthenticatedLicense();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Authentication required";

      const action = await vscode.window.showWarningMessage(
        `Project Brain: Sign in is required before initialization. (${message})`,
        "Sign In",
        "Cancel",
      );

      if (action === "Sign In") {
        const loginWebview = deps.getLoginWebview();
        if (loginWebview) {
          await loginWebview.show();
        } else {
          vscode.window.showErrorMessage(
            "Project Brain: Login UI unavailable. Check Output panel for errors.",
          );
        }
      }

      deps.log(
        "[SaaS] Initialization blocked: user not authenticated/licensed",
      );
      return;
    }
  }

  const state = deps.getState(folder, context);

  // First-time scope selection: global vs workspace-only
  const scopeOk = await runScopeSelection(folder, deps);
  if (!scopeOk) {
    deps.log("[Init] User cancelled scope selection — aborting init");
    return;
  }

  deps.log(`[Init] Scope selection passed — proceeding with bootstrap for ${folder.name}`);

  // Clear identity cache so it picks up the new scope
  state.identityManager.clearIdentityCache();

  // Ensure workspace dirs exist and git exclusion is configured
  // (may have been skipped if workspace was just enabled via init command)
  ensureProjectBrainDirs(folder.uri.fsPath);
  void excludeFromGit(folder, true);
  migrateFromLegacyPaths(folder.uri.fsPath);

  const existingIdentity = state.identityManager.loadIdentity();
  let i18n = getBootstrapStrings(existingIdentity?.language);

  const progress = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${i18n.initTitle} (${folder.name})`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ increment: 0, message: i18n.creatingMemory });
      await state.bootstrapper.createMemoryStructure();

      progress.report({ increment: 10, message: i18n.scanningProject });
      const docs = await state.scanner.scanProject();

      const hasGit = !!docs.gitInsights?.isGitRepo;
      const gitLabel = hasGit ? i18n.withGitAnalysis : "";

      progress.report({
        increment: hasGit ? 30 : 40,
        message: `${i18n.generatingDocs}${gitLabel}...`,
      });
      await state.bootstrapper.generateInitialDocs(docs);

      // Inject global knowledge into new project
      const globalKnowledge = deps.getGlobalKnowledge?.();
      if (globalKnowledge) {
        const memoryPath = path.join(folder.uri.fsPath, "docs", "memory");
        const injected = globalKnowledge.injectIntoProject(memoryPath, folder.name);
        if (injected > 0) {
          deps.log(`[${folder.name}] Inherited ${injected} global knowledge entries`);
        }
      }

      progress.report({ increment: 20, message: i18n.generatingAgent });
      const identity = state.identityManager.loadIdentity();
      const soul = state.identityManager.loadSoul();
      const user = state.identityManager.loadUser();
      const essence = state.identityManager.extractProjectEssence();
      await state.bootstrapper.generateAgentInstructions(
        docs.projectType,
        identity,
        soul,
        user,
        essence,
      );

      progress.report({ increment: 15, message: i18n.settingUpRAG });
      await state.mcpManager.setupMCP();

      progress.report({ increment: 15, message: i18n.indexingRAG });
      await state.mcpManager.indexProject();

      progress.report({ increment: 10, message: i18n.done });
      return true;
    },
  );

  if (progress) {
    updateStatusBar(deps, "Project Brain Active");

    deps.treeDataProvider.updateStatus({
      memoryActive: true,
      ragReady: state.mcpManager.isReady(),
      workspaceFolder: folder,
    });

    // Agent Identity Setup (post-init) — QuickPick-based, extracted to utils
    i18n = await runPostInitIdentitySetup(state, deps, i18n, context);

    // Auto-vectorization: start automatically after init (core feature)
    await startAutoVectorization(folder, context, deps);

    await openMemoryFolder(folder);
  }
}

// ─── Scan project (re-scan existing) ──────────────────────────────────────

export async function scanProject(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  const state = deps.getState(folder, context);
  const identity = state.identityManager.loadIdentity();
  const i18n = getBootstrapStrings(identity?.language);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${i18n.scanTitle} (${folder.name})`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: i18n.analyzingCodebase });
      const docs = await state.scanner.scanProject();

      progress.report({ message: i18n.updatingDocs });
      await state.bootstrapper.updateDocs(docs);

      progress.report({ message: i18n.updatingAgent });
      const currentIdentity = state.identityManager.loadIdentity();
      const soul = state.identityManager.loadSoul();
      const user = state.identityManager.loadUser();
      const essence = state.identityManager.extractProjectEssence();
      await state.bootstrapper.generateAgentInstructions(
        docs.projectType,
        currentIdentity,
        soul,
        user,
        essence,
      );

      progress.report({ message: i18n.reindexingRAG });
      await state.mcpManager.indexProject();
    },
  );

  vscode.window.showInformationMessage(i18n.scanComplete);
}

// ─── Auto-vectorizer lifecycle ────────────────────────────────────────────

export async function initializeAutoVectorizer(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  const state = deps.getState(folder, context);
  if (state.autoVectorizer) return;

  const mcpPath = state.mcpManager.getMCPServerPath();
  const isBundled = state.mcpManager.getIsBundled();
  state.autoVectorizer = new AutoVectorizer(
    folder,
    context,
    mcpPath,
    isBundled,
  );
}

export async function startAutoVectorization(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  await initializeAutoVectorizer(folder, context, deps);
  const state = deps.getState(folder, context);

  if (!state.autoVectorizer) {
    const identity = state.identityManager.loadIdentity();
    const i18n = getBootstrapStrings(identity?.language);
    vscode.window.showErrorMessage(i18n.failedAutoVec);
    return;
  }

  const success = await state.autoVectorizer.start();
  if (success) {
    const config = vscode.workspace.getConfiguration("projectBrain");
    await config.update(
      "autoStartVectorization",
      true,
      vscode.ConfigurationTarget.Workspace,
    );

    deps.treeDataProvider.updateStatus({
      autoVecActive: state.autoVectorizer.isActive(),
      workspaceFolder: folder,
    });
  }
}

export async function stopAutoVectorization(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<void> {
  const state = deps.getState(folder, context);
  if (!state.autoVectorizer) {
    const identity = state.identityManager.loadIdentity();
    const i18n = getBootstrapStrings(identity?.language);
    vscode.window.showInformationMessage(i18n.autoVecNotRunning);
    return;
  }

  await state.autoVectorizer.stop();

  const config = vscode.workspace.getConfiguration("projectBrain");
  await config.update(
    "autoStartVectorization",
    false,
    vscode.ConfigurationTarget.Workspace,
  );

  deps.treeDataProvider.updateStatus({
    autoVecActive: false,
    workspaceFolder: folder,
  });
}

// Re-export from utils for backward compatibility
export { showStatus, openMemoryFolder } from "./project-lifecycle-utils";

// ─── Refresh agent instructions when global scope ───────────────────────

/** When identity scope is global, regenerate agent files on workspace open */
async function refreshAgentInstructionsIfGlobal(
  state: FolderState,
  folder: vscode.WorkspaceFolder,
  deps: LifecycleDeps,
): Promise<void> {
  const globalConfig = deps.getGlobalConfig?.();
  if (!globalConfig || globalConfig.getScope() !== "global") return;

  // Check if projectbrain.agent.md already exists — preserve user config
  const agentsDir = vscode.Uri.joinPath(folder.uri, ".github", "agents");
  const brainAgentPath = vscode.Uri.joinPath(agentsDir, "projectbrain.agent.md");
  try {
    await vscode.workspace.fs.stat(brainAgentPath);
    deps.log(`[${folder.name}] projectbrain.agent.md exists — preserving user config, skipping refresh`);
    return; // File exists, don't overwrite
  } catch {
    // File doesn't exist, proceed with generation
  }

  const identity = state.identityManager.loadIdentity();
  const soul = state.identityManager.loadSoul();
  const user = state.identityManager.loadUser();
  const essence = state.identityManager.extractProjectEssence();
  const docs = await state.scanner.scanProject();

  await state.bootstrapper.generateAgentInstructions(
    docs.projectType, identity, soul, user, essence,
  );
  deps.log(`[${folder.name}] Agent instructions refreshed from global config`);
}

// ─── Auto-update hooks when extension version is newer ────────────────────────

interface HooksVersionFile {
  version: string;
  updated?: string;
}

/**
 * Reads hooks-version.json from a URI. Returns version hash or empty string if missing.
 */
async function readHooksVersion(uri: vscode.Uri): Promise<string> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed: HooksVersionFile = JSON.parse(
      Buffer.from(raw).toString("utf-8"),
    );
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

/**
 * Compares bundled hooks version vs deployed version in the project.
 * If bundled is newer, deploys hooks only (no full scan) and shows notification.
 */
export async function checkAndUpdateHooksVersion(
  state: FolderState,
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleDeps,
): Promise<boolean> {
  const extensionUri = vscode.Uri.file(context.extensionPath);
  const bundledVersion = await readHooksVersion(
    vscode.Uri.joinPath(extensionUri, "static", "hooks", "hooks-version.json"),
  );
  const deployedVersion = await readHooksVersion(
    vscode.Uri.joinPath(
      folder.uri, ".project-brain", "hooks", "hooks-version.json",
    ),
  );

  if (bundledVersion === deployedVersion || bundledVersion === "") {
    return false; // Up to date or no bundled version
  }

  deps.log(
    `[${folder.name}] Hooks outdated (deployed: ${deployedVersion || "none"}, bundled: ${bundledVersion}). Updating...`,
  );

  await state.bootstrapper.generateHooksAndAssets();

  deps.log(`[${folder.name}] Hooks updated to ${bundledVersion}`);
  vscode.window.showInformationMessage(
    `🏴‍☠️ Project Brain: Hooks actualizados en "${folder.name}"`,
  );
  return true;
}
