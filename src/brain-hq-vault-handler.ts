/**
 * Brain HQ — Vault message handlers.
 *
 * Handles webview ↔ extension communication for the Vault tab.
 *
 * @module BrainHqVaultHandler
 */

import * as vscode from "vscode";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import {
  ensureVaultGitignored,
  hasVault,
  initVault,
  readVault,
  removeVaultEntry,
  upsertVaultEntry,
  type VaultEntry,
} from "./vault-manager";

/** Handle vault-related webview messages. */
export async function handleVaultMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<void> {
  const wsRoot = instance.ctx.workspaceFolder?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    instance.ctx.log("[Vault] No workspace folder found");
    return;
  }

  switch (msg.type) {
    case "vault:getEntries": {
      try {
        const entries = readVault(wsRoot);
        const exists = hasVault(wsRoot);
        instance.panel.webview.postMessage({
          type: "vault:entries",
          data: { entries, exists },
        });
      } catch (err) {
        instance.ctx.log(`[Vault] getEntries failed: ${err}`);
        instance.panel.webview.postMessage({
          type: "vault:entries",
          data: { entries: [], exists: false },
        });
      }
      break;
    }

    case "vault:init": {
      initVault(wsRoot);
      const entries = readVault(wsRoot);
      instance.panel.webview.postMessage({
        type: "vault:entries",
        data: { entries, exists: true },
      });
      instance.ctx.log("[Vault] Initialized");
      break;
    }

    case "vault:upsert": {
      const entry = msg.entry as VaultEntry;
      if (!entry?.label) {
        instance.ctx.log(`[Vault] upsert: missing label. Raw msg.entry: ${JSON.stringify(msg.entry)}`);
        instance.panel.webview.postMessage({
          type: "vault:error",
          data: { message: "Vault save failed: missing label" },
        });
        break;
      }
      try {
        instance.ctx.log(`[Vault] upsert: label="${entry.label}", keys=${Object.keys(entry.secrets || {}).length}, wsRoot="${wsRoot}"`);
        upsertVaultEntry(wsRoot, entry);
        const entries = readVault(wsRoot);
        instance.ctx.log(`[Vault] upsert OK: ${entries.length} total entries on disk`);
        instance.panel.webview.postMessage({
          type: "vault:entries",
          data: { entries, exists: true },
        });
      } catch (err) {
        instance.ctx.log(`[Vault] upsert failed: ${err}`);
        instance.panel.webview.postMessage({
          type: "vault:error",
          data: { message: `Failed to save vault entry: ${err}` },
        });
      }
      break;
    }

    case "vault:remove": {
      const label = msg.label as string;
      if (!label) break;
      const removed = removeVaultEntry(wsRoot, label);
      if (removed) {
        instance.ctx.log(`[Vault] Removed entry: ${label}`);
      }
      const entries = readVault(wsRoot);
      instance.panel.webview.postMessage({
        type: "vault:entries",
        data: { entries, exists: true },
      });
      break;
    }

    case "vault:ensureGitignore": {
      ensureVaultGitignored(wsRoot);
      instance.panel.webview.postMessage({ type: "vault:gitignoreOk" });
      break;
    }

    case "vault:openFile": {
      const vaultPath = `${wsRoot}/.project-brain/vault/project.brain.vault.env`;
      try {
        const doc = await vscode.workspace.openTextDocument(vaultPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch {
        vscode.window.showWarningMessage(
          "Vault file not found. Initialize the vault first.",
        );
      }
      break;
    }
  }
}
