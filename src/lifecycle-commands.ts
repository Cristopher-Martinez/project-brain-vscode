// ─── Lifecycle Commands (extracted from extension.ts) ───────────────────────
// Simple commands (init, scan, status, openMemory, autoVec, validateSoul,
// swarm.openLastReport) + batch commands
import * as vscode from "vscode";
import {
  createBatchCommand,
  editCommandsFile,
  executeBatch,
  viewOutputFile,
} from "./batch-commands";
import {
  initializeProject,
  scanProject,
  showStatus,
  openMemoryFolder,
  startAutoVectorization,
  stopAutoVectorization,
  checkAndUpdateHooksVersion,
} from "./project-lifecycle";
import {
  importContentTxtFile,
  pickContentTxtFile,
} from "./content-txt-import";
import { getBootstrapStrings } from "./i18n";
import { enableWorkspace, isWorkspaceEnabled, requireEnabled } from "./project-lifecycle-utils";
// Note: showStatus and openMemoryFolder are re-exported from project-lifecycle-utils
import { getSwarmState } from "./swarm-state";
import type { FolderState } from "./extension-types";
import type { LifecycleDeps } from "./extension-types";

export interface LifecycleCommandsDeps extends LifecycleDeps {
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
  context: vscode.ExtensionContext;
}

export interface ImportContentTxtCommandApi {
  pickContentTxtFile: typeof pickContentTxtFile;
  importContentTxtFile: typeof importContentTxtFile;
  withProgress: typeof vscode.window.withProgress;
  showInformationMessage: typeof vscode.window.showInformationMessage;
  showErrorMessage: typeof vscode.window.showErrorMessage;
  openTextDocument: typeof vscode.workspace.openTextDocument;
  showTextDocument: typeof vscode.window.showTextDocument;
}

const defaultImportContentTxtCommandApi: ImportContentTxtCommandApi = {
  pickContentTxtFile,
  importContentTxtFile,
  withProgress: vscode.window.withProgress.bind(vscode.window),
  showInformationMessage: vscode.window.showInformationMessage.bind(vscode.window),
  showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
  openTextDocument: vscode.workspace.openTextDocument.bind(vscode.workspace),
  showTextDocument: vscode.window.showTextDocument.bind(vscode.window),
};

export async function runImportContentTxtCommand(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  deps: LifecycleCommandsDeps,
  api: ImportContentTxtCommandApi = defaultImportContentTxtCommandApi,
): Promise<void> {
  const sourcePath = await api.pickContentTxtFile();
  if (!sourcePath) {
    api.showInformationMessage(
      "Import cancelled. Pick a content.txt file when you want to create a compact chat note.",
    );
    return;
  }

  try {
    await api.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing chat note (${folder.name})...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Reading the selected file..." });
        const result = api.importContentTxtFile(folder.uri.fsPath, sourcePath);

        progress.report({ message: "Saving a compact note to memory..." });
        const state = deps.getState(folder, context);
        try {
          progress.report({ message: "Refreshing memory index..." });
          await state.mcpManager.indexProject();
        } catch (err) {
          deps.log(`[ImportContentTxt] Reindex failed: ${err}`);
        }

        deps.treeDataProvider.refresh();

        progress.report({ message: "Opening the imported note..." });
        const document = await api.openTextDocument(result.outputPath);
        await api.showTextDocument(document, { preview: true });
        api.showInformationMessage(
          `Chat imported as a compact note. We kept ${result.signalLines} key lines, ${result.sessionIds.length} session IDs, and ${result.toolHints.length} tool hints.`,
        );
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    api.showErrorMessage(
      `Could not import this file. ${message}`,
    );
  }
}

/** Register core project lifecycle commands */
export function registerLifecycleCommands(
  context: vscode.ExtensionContext,
  deps: LifecycleCommandsDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.init", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (folder) {
        // Enable the extension for this workspace if not already enabled
        if (!isWorkspaceEnabled(folder)) {
          await enableWorkspace(folder);
        }
        await initializeProject(folder, context, deps);
      }
    }),
    vscode.commands.registerCommand("projectBrain.scan", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (folder) await scanProject(folder, context, deps);
    }),
    vscode.commands.registerCommand("projectBrain.status", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (folder) await showStatus(folder, context, deps);
    }),
    vscode.commands.registerCommand("projectBrain.openMemory", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (folder) await openMemoryFolder(folder);
    }),
    vscode.commands.registerCommand("projectBrain.importContentTxt", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (folder) await runImportContentTxtCommand(folder, context, deps);
    }),
    vscode.commands.registerCommand(
      "projectBrain.startAutoVectorization",
      async () => {
        if (!requireEnabled()) return;
        const folder = await deps.pickWorkspaceFolder();
        if (folder) await startAutoVectorization(folder, context, deps);
      },
    ),
    vscode.commands.registerCommand(
      "projectBrain.stopAutoVectorization",
      async () => {
        if (!requireEnabled()) return;
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;

        const confirm = await vscode.window.showWarningMessage(
          "⚠️ Detener la auto-vectorización desactiva:\n" +
            "• Búsqueda semántica actualizada (RAG)\n" +
            "• Indexación automática de cambios\n" +
            "• Contexto inteligente en herramientas LM\n\n" +
            "El agente perderá visibilidad sobre cambios recientes en el código.",
          { modal: true },
          "Detener de todas formas",
          "Cancelar",
        );
        if (confirm === "Detener de todas formas") {
          await stopAutoVectorization(folder, context, deps);
        }
      },
    ),
    vscode.commands.registerCommand("projectBrain.syncProject", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.getState(folder, context);
      const identity = state.identityManager.loadIdentity();
      const i18n = getBootstrapStrings(identity?.language);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Syncing project (${folder.name})...`,
          cancellable: false,
        },
        async (progress) => {
          // Step 1: Sync global identity to local files
          progress.report({ message: "Syncing identity..." });
          const globalConfig = state.identityManager.getGlobalConfig();
          if (globalConfig && globalConfig.getScope() === "global") {
            state.identityManager.invalidateCache();
            const gId = globalConfig.loadIdentity();
            if (gId) state.identityManager.saveIdentity(gId);
            const gSoul = globalConfig.loadSoul();
            if (gSoul) state.identityManager.saveSoul(gSoul);
            const gUser = globalConfig.loadUser();
            if (gUser) state.identityManager.saveUser(gUser);
          }

          // Step 2: Scan + regenerate everything
          progress.report({ message: "Scanning project..." });
          const docs = await state.scanner.scanProject();

          progress.report({ message: "Updating memory files..." });
          await state.bootstrapper.updateDocs(docs);

          progress.report({ message: "Regenerating agent files & hooks..." });
          const currentIdentity = state.identityManager.loadIdentity();
          const soul = state.identityManager.loadSoul();
          const user = state.identityManager.loadUser();
          const essence = state.identityManager.extractProjectEssence();
          await state.bootstrapper.generateAgentInstructions(
            docs.projectType, currentIdentity, soul, user, essence,
          );

          // Step 3: Update MCP config
          progress.report({ message: "Updating MCP config..." });
          await state.mcpManager.setupMCP();

          // Step 4: Reindex RAG
          progress.report({ message: "Reindexing..." });
          await state.mcpManager.indexProject();
        },
      );

      vscode.window.showInformationMessage(
        `Project synced with latest extension features (${folder.name})`,
      );
    }),
    vscode.commands.registerCommand(
      "projectBrain.checkHooksUpdate",
      async () => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);
        const updated = await checkAndUpdateHooksVersion(
          state, folder, context, deps,
        );
        if (!updated) {
          vscode.window.showInformationMessage(
            `Hooks are up to date in "${folder.name}"`,
          );
        }
      },
    ),
    vscode.commands.registerCommand("projectBrain.validateSoul", async () => {
      if (!requireEnabled()) return;
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.folderStates.get(folder.uri.toString());
      if (!state?.identityManager) {
        vscode.window.showWarningMessage(
          "Project Brain not initialized for this folder.",
        );
        return;
      }
      await state.identityManager.validateSoulConsistency();
    }),
    vscode.commands.registerCommand(
      "projectBrain.swarm.openLastReport",
      async () => {
        const swarm = getSwarmState();
        const content = swarm.summary?.trim();
        if (!content) {
          vscode.window.showInformationMessage(
            "No swarm report available yet.",
          );
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    ),
  );
}

/** Register batch execution commands */
export function registerBatchCommands(
  context: vscode.ExtensionContext,
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.batch.newCommand",
      async () => {
        const folder = await pickWorkspaceFolder();
        if (folder) await createBatchCommand(folder);
      },
    ),
    vscode.commands.registerCommand(
      "projectBrain.batch.editCommands",
      async () => {
        const folder = await pickWorkspaceFolder();
        if (folder) await editCommandsFile(folder);
      },
    ),
    vscode.commands.registerCommand(
      "projectBrain.batch.viewOutput",
      async () => {
        const folder = await pickWorkspaceFolder();
        if (folder) await viewOutputFile(folder);
      },
    ),
    vscode.commands.registerCommand("projectBrain.batch.execute", async () => {
      if (!requireEnabled()) return;
      const folder = await pickWorkspaceFolder();
      if (folder) await executeBatch(folder);
    }),
  );
}
