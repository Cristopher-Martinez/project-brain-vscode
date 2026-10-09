/**
 * Brain HQ message handler — Model management cases.
 * Extracted to keep brain-hq-message-handler.ts under 400 lines.
 */
import * as vscode from "vscode";
import { AgentRegistry } from "./agent-registry";
import type { BrainHqInstance } from "./brain-hq-message-handler";

/**
 * Handle model-related messages from Brain HQ webview.
 * Returns true if the message was handled, false otherwise.
 */
export async function handleModelMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "getAvailableModels": {
      try {
        const allModels = await AgentRegistry.getAvailableModels();
        const enabledIds: string[] = vscode.workspace
          .getConfiguration("projectBrain")
          .get("orchestration.enabledModels", []);
        const filtered =
          enabledIds.length > 0
            ? allModels.filter((m) => enabledIds.includes(m.id))
            : allModels;
        instance.panel.webview.postMessage({
          type: "availableModels",
          data: filtered,
          allModels: allModels,
          enabledIds: enabledIds,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] Failed to get models: ${err}`);
        instance.panel.webview.postMessage({
          type: "availableModels",
          data: [],
          allModels: [],
          enabledIds: [],
        });
      }
      return true;
    }

    case "toggleModel": {
      try {
        const config = vscode.workspace.getConfiguration("projectBrain");
        const current: string[] = config.get("orchestration.enabledModels", []);
        const modelId = msg.modelId as string;
        const updated = current.includes(modelId)
          ? current.filter((id) => id !== modelId)
          : [...current, modelId];
        await config.update(
          "orchestration.enabledModels",
          updated,
          vscode.ConfigurationTarget.Global,
        );
        // Refresh models in webview
        const allModels = await AgentRegistry.getAvailableModels();
        const filtered =
          updated.length > 0
            ? allModels.filter((m) => updated.includes(m.id))
            : allModels;
        instance.panel.webview.postMessage({
          type: "availableModels",
          data: filtered,
          allModels: allModels,
          enabledIds: updated,
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] toggleModel error: ${err}`);
      }
      return true;
    }

    case "enableAllModels": {
      try {
        const config = vscode.workspace.getConfiguration("projectBrain");
        await config.update(
          "orchestration.enabledModels",
          [],
          vscode.ConfigurationTarget.Global,
        );
        const allModels = await AgentRegistry.getAvailableModels();
        instance.panel.webview.postMessage({
          type: "availableModels",
          data: allModels,
          allModels: allModels,
          enabledIds: [],
        });
      } catch (err) {
        instance.ctx.log(`[BrainHQ] enableAllModels error: ${err}`);
      }
      return true;
    }

    default:
      return false;
  }
}
