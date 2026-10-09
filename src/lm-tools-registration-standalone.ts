/**
 * LM Tools Registration — Standalone Brain tools (unique, non-native).
 *
 * Only registers tools that have NO native VS Code equivalent.
 * Native tools (read, find, grep, list, search, errors, terminals, notebooks,
 * fetch, test, usages) are now handled by VS Code's built-in tools.
 *
 * Kept standalone tools:
 * - awaken — Identity/soul awakening (unique)
 * - command — Run VS Code API commands (unique, no native equivalent)
 * - gitChanges — Git status/diff (unique)
 * - installExtension — Install VS Code extensions (unique)
 *
 * @module lm-tools-registration-standalone
 */

import * as vscode from "vscode";
import { AgentIdentityManager } from "./agent-identity";
import { BrainCommandTool } from "./lm-tools-command";
import { BrainGitChangesTool } from "./lm-tools-git-changes";
import { BrainInstallExtensionTool } from "./lm-tools-install-ext";
import { AwakenTool } from "./lm-tools-neuro";
import { OpinionBank } from "./opinion-bank";

/** Refs returned by standalone tool registration. */
export interface StandaloneToolRefs {
  awaken: AwakenTool;
  command: BrainCommandTool;
  gitChanges: BrainGitChangesTool;
  installExtension: BrainInstallExtensionTool;
}

export interface StandaloneToolDeps {
  context: vscode.ExtensionContext;
  identityManager: AgentIdentityManager;
  bank: OpinionBank;
  memoryPath: string;
  workspacePath: string;
  searchFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>;
  log: (msg: string) => void;
}

/**
 * Create and register standalone Brain tool instances.
 * Only tools with NO native VS Code equivalent are registered here.
 */
export function registerStandaloneTools(
  deps: StandaloneToolDeps,
): StandaloneToolRefs {
  const { context, identityManager, bank, memoryPath, workspacePath, log } = deps;

  // Awaken — standalone (zero-params, identity mirror)
  const awakenTool = new AwakenTool(identityManager, bank, memoryPath, workspacePath, log);
  context.subscriptions.push(vscode.lm.registerTool("projectBrain_awaken", awakenTool));

  // Command — Run VS Code API commands (no native equivalent)
  const commandTool = new BrainCommandTool(log);
  context.subscriptions.push(vscode.lm.registerTool("projectBrain_command", commandTool));

  // Git Changes — Git status/diff (no native equivalent)
  const gitChangesTool = new BrainGitChangesTool(log);
  context.subscriptions.push(vscode.lm.registerTool("projectBrain_gitChanges", gitChangesTool));

  // Install Extension — Install VS Code extensions (no native equivalent)
  const installExtensionTool = new BrainInstallExtensionTool();
  context.subscriptions.push(vscode.lm.registerTool("projectBrain_installExtension", installExtensionTool));

  return {
    awaken: awakenTool,
    command: commandTool,
    gitChanges: gitChangesTool,
    installExtension: installExtensionTool,
  };
}
