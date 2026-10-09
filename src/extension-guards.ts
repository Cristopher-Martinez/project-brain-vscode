// ─── Workspace Trust & No-Workspace Command Guards ─────────────────────────
// Registers restricted/disabled command handlers when the workspace is
// untrusted or no folders are open.
import * as vscode from "vscode";

/** Register restricted-mode commands (untrusted workspace) */
export function registerRestrictedCommands(
  context: vscode.ExtensionContext,
  log: (msg: string) => void,
): void {
  log("Workspace is not trusted — registering restricted-mode commands");
  const handler = () => {
    vscode.window.showWarningMessage(
      "Project Brain requires a trusted workspace. Grant trust via File > Manage Workspace Trust.",
    );
  };
  const cmds = [
    "projectBrain.init",
    "projectBrain.scan",
    "projectBrain.status",
    "projectBrain.openMemory",
    "projectBrain.startAutoVectorization",
    "projectBrain.stopAutoVectorization",
    "projectBrain.excludeFromGit",
    "projectBrain.saveSession",
    "projectBrain.resumeSession",
    "projectBrain.configureIdentity",
    "projectBrain.openIdentityFile",
    "projectBrain.configureSoul",
    "projectBrain.configureUser",
    "projectBrain.openSoulFile",
    "projectBrain.openUserFile",
    "projectBrain.spawnSession",
    "projectBrain.saas.login",
    "projectBrain.saas.logout",
    "projectBrain.saas.status",
    "projectBrain.saas.syncOpinions",
    "projectBrain.createReminder",
  ];
  for (const cmd of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
  }
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      log("Workspace trust granted — reloading");
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),
  );
}

/** Register no-workspace command handlers (no folders open) */
export function registerNoWorkspaceCommands(
  context: vscode.ExtensionContext,
  log: (msg: string) => void,
): void {
  log("No workspace folders found — registering no-workspace handlers");
  const handler = () => {
    vscode.window.showWarningMessage(
      "Project Brain requires an open workspace folder. Open a folder/workspace and retry.",
    );
  };
  const cmds = [
    "projectBrain.init",
    "projectBrain.scan",
    "projectBrain.status",
    "projectBrain.openMemory",
    "projectBrain.startAutoVectorization",
    "projectBrain.stopAutoVectorization",
    "projectBrain.excludeFromGit",
    "projectBrain.batch.newCommand",
    "projectBrain.batch.editCommands",
    "projectBrain.batch.viewOutput",
    "projectBrain.batch.execute",
    "projectBrain.saveSession",
    "projectBrain.resumeSession",
    "projectBrain.configureIdentity",
    "projectBrain.openIdentityFile",
    "projectBrain.configureSoul",
    "projectBrain.openSoulFile",
    "projectBrain.configureUser",
    "projectBrain.openUserFile",
    "projectBrain.configureProgrammingPrefs",
    "projectBrain.openProgrammingPrefsFile",
    "projectBrain.delegate",
    "projectBrain.spawnSession",
    "projectBrain.saas.login",
    "projectBrain.saas.logout",
    "projectBrain.saas.status",
    "projectBrain.saas.syncOpinions",
    "projectBrain.createReminder",
  ];
  for (const cmd of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
  }
}
