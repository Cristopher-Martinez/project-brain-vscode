import { showIdentityForm } from "./identity-webview";
import * as vscode from "vscode";
import { log } from "./logger";
import type { GlobalConfigProvider } from "./global-config-provider";
import type { SaaSClient } from "./saas-client";
import type { UpgradePromptManager } from "./upgrade-prompts";
import type { Bootstrapper } from "./bootstrapper";
import type { ProjectScanner } from "./scanner";
import type { MCPManager } from "./mcp-manager";
import type { AutoVectorizer } from "./auto-vectorizer";
import type { AgentIdentityManager } from "./agent-identity";

interface FolderState {
  bootstrapper: Bootstrapper;
  scanner: ProjectScanner;
  mcpManager: MCPManager;
  autoVectorizer: AutoVectorizer | null;
  identityManager: AgentIdentityManager;
}

export interface IdentityCommandDeps {
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
  getState: (
    folder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
  ) => FolderState;
  getSaasClient: () => SaaSClient | null;
  getUpgradePrompts: () => UpgradePromptManager | null;
  getGlobalConfig: () => GlobalConfigProvider | null;
}

export function registerIdentityCommands(
  context: vscode.ExtensionContext,
  deps: IdentityCommandDeps,
): void {
  // ─── Agent Identity / Soul / User commands ───────────────────────
  // configureIdentity and configureSoul require Pro+ plan (custom_personality)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.configureIdentity",
      async () => {
        const activeSaasClient = deps.getSaasClient();
        const activeUpgradePrompts = deps.getUpgradePrompts();
        const currentPlan = activeSaasClient?.currentPlan ?? "free";
        if (currentPlan === "free") {
          if (activeUpgradePrompts) {
            await activeUpgradePrompts.promptForFeature(
              "custom_personality",
              currentPlan,
            );
          } else {
            vscode.window.showWarningMessage(
              "⛔ Custom personality requires a Pro plan. Upgrade at https://projectbrain.dev/pricing",
            );
          }
          return;
        }
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);

        // Check if global identity exists and offer to import
        const globalConfig = deps.getGlobalConfig();
        if (globalConfig && globalConfig.hasGlobalIdentity()) {
          const existing = globalConfig.loadIdentity();
          if (existing) {
            const choice = await vscode.window.showQuickPick(
              [
                {
                  label: `$(person) Usar identidad global: ${existing.name} ${existing.emoji}`,
                  value: "use-global",
                },
                {
                  label: "$(edit) Crear nueva identidad",
                  value: "create-new",
                },
              ],
              {
                placeHolder:
                  "Ya tienes una identidad global configurada",
              },
            );
            if (!choice) return;
            if (choice.value === "use-global") {
              // Force re-read from global — identity will propagate to local files
              state.identityManager.invalidateCache();
              const identity = state.identityManager.loadIdentity();
              if (identity) {
                log("Identity imported from global config");
                try {
                  const docs = await state.scanner.scanProject();
                  const soul = state.identityManager.loadSoul();
                  const user = state.identityManager.loadUser();
                  const essence =
                    state.identityManager.extractProjectEssence();
                  await state.bootstrapper.generateAgentInstructions(
                    docs.projectType,
                    identity,
                    soul,
                    user,
                    essence,
                  );
                  vscode.window.showInformationMessage(
                    `Identidad global "${identity.name}" ${identity.emoji} importada a este proyecto.`,
                  );
                } catch (err) {
                  log(`Failed to regenerate agent instructions: ${err}`);
                }
              }
              return;
            }
          }
        }

        const newIdentity = await state.identityManager.configureInteractive();

        if (newIdentity) {
          log("Identity configured — regenerating agent instruction files...");
          try {
            const docs = await state.scanner.scanProject();
            const soul = state.identityManager.loadSoul();
            const user = state.identityManager.loadUser();
            const essence = state.identityManager.extractProjectEssence();
            await state.bootstrapper.generateAgentInstructions(
              docs.projectType,
              newIdentity,
              soul,
              user,
              essence,
            );
            log("Agent instruction files updated with new identity");
            vscode.window.showInformationMessage(
              `Agent identity "${newIdentity.name}" ${newIdentity.emoji} propagated to all instruction files.`,
            );
          } catch (err) {
            log(`Failed to regenerate agent instructions: ${err}`);
          }
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.openIdentityFile",
      async () => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);
        await state.identityManager.openIdentityFile();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.configureSoul", async () => {
      const activeSaasClient = deps.getSaasClient();
      const activeUpgradePrompts = deps.getUpgradePrompts();
      const currentPlan = activeSaasClient?.currentPlan ?? "free";
      if (currentPlan === "free") {
        if (activeUpgradePrompts) {
          await activeUpgradePrompts.promptForFeature(
            "custom_personality",
            currentPlan,
          );
        } else {
          vscode.window.showWarningMessage(
            "⛔ Custom personality requires a Pro plan. Upgrade at https://projectbrain.dev/pricing",
          );
        }
        return;
      }
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.getState(folder, context);
      const newSoul = await state.identityManager.configureSoul();

      if (newSoul) {
        log("Soul configured — regenerating agent instruction files...");
        try {
          const docs = await state.scanner.scanProject();
          const identity = state.identityManager.loadIdentity();
          const user = state.identityManager.loadUser();
          const essence = state.identityManager.extractProjectEssence();
          await state.bootstrapper.generateAgentInstructions(
            docs.projectType,
            identity,
            newSoul,
            user,
            essence,
          );
          log("Agent instruction files updated with new soul");
          vscode.window.showInformationMessage(
            "Agent soul configured and propagated to all instruction files.",
          );
        } catch (err) {
          log(`Failed to regenerate agent instructions: ${err}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.configureUser", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.getState(folder, context);
      const newUser = await state.identityManager.configureUser();

      if (newUser) {
        log(
          "User profile configured — regenerating agent instruction files...",
        );
        try {
          const docs = await state.scanner.scanProject();
          const identity = state.identityManager.loadIdentity();
          const soul = state.identityManager.loadSoul();
          const essence = state.identityManager.extractProjectEssence();
          await state.bootstrapper.generateAgentInstructions(
            docs.projectType,
            identity,
            soul,
            newUser,
            essence,
          );
          log("Agent instruction files updated with user profile");
          vscode.window.showInformationMessage(
            `User profile "${newUser.name}" saved and propagated.`,
          );
        } catch (err) {
          log(`Failed to regenerate agent instructions: ${err}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.configureProgrammingPrefs",
      async () => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);
        const newPrefs =
          await state.identityManager.configureProgrammingPrefs();

        if (newPrefs) {
          log("Programming preferences configured");
          vscode.window.showInformationMessage(
            "💻 Programming preferences saved.",
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.openSoulFile", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.getState(folder, context);
      await state.identityManager.openSoulFile();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.openUserFile", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      const state = deps.getState(folder, context);
      await state.identityManager.openUserFile();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.openProgrammingPrefsFile",
      async () => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);
        await state.identityManager.openProgrammingPrefsFile();
      },
    ),
  );

  // ─── Identity Form (webview) ─────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.openIdentityForm",
      async () => {
        const folder = await deps.pickWorkspaceFolder();
        if (!folder) return;
        const state = deps.getState(folder, context);
        showIdentityForm(context, state);
      },
    ),
  );
}
