/**
 * brain-hq-bridge-settings-handler â€” Handles model/provider settings
 * messages from the Auto Loop Bridge tab in Brain HQ.
 *
 * Phase F of the Auto Loop Bridge system.
 * Exposes multi-provider configuration + model selector to the webview.
 */

import * as vscode from "vscode";
import { log, logError } from "./logger";
import { resolveBridgeApiKey, isWrongProviderKey } from "./bridge-api-key-resolver";
import {
  listProviders,
  listModels,
  fetchAllModels,
  setDefaultProvider,
  validateProvider,
} from "./pm-provider-registry";
import { initBridgeManager } from "./auto-loop-bridge-manager";
import type { PMProviderConfig } from "./auto-loop-bridge-types";
/** Mapping providerId -> full VS Code setting key for global storage */
const GLOBAL_SETTING_KEYS: Record<string, string> = {
  openrouter: "projectBrain.bridge.openrouterApiKey",
  gemini: "projectBrain.bridge.geminiApiKey",
};

// â”€â”€ Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleBridgeSettingsMessage(
  message: { type: string; [key: string]: unknown },
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  switch (message.type) {
    case "requestBridgeProviders":
      return handleRequestProviders(postMessage);

    case "requestBridgeModels":
      return handleRequestModels(
        message.providerId as string,
        postMessage
      );

    case "setBridgeDefaultProvider":
      return handleSetDefault(
        message.providerId as string,
        postMessage
      );

    case "validateBridgeProvider":
      return handleValidate(
        message.providerId as string,
        message.config as PMProviderConfig,
        postMessage
      );

    case "saveBridgeApiKey":
      return handleSaveApiKey(
        message.providerId as string,
        message.apiKey as string,
        postMessage
      );

    case "requestBridgeModelCatalog":
      return handleRequestModelCatalog(
        message.providerId as string,
        postMessage
      );

    case "saveBridgeEnabledModels":
      return handleSaveEnabledModels(
        message.providerId as string,
        message.enabledModelIds as string[],
        postMessage
      );

    default:
      return false;
  }
}

// â”€â”€ Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function handleRequestProviders(
  postMessage: (msg: unknown) => void
): boolean {
  // Ensure strategies are registered before listing
  initBridgeManager();
  const providers = listProviders();
  log(`[BridgeSettings] Listed ${providers.length} providers (after init)`);
  postMessage({
    type: "bridgeProviders",
    providers,
  });
  return true;
}

async function handleRequestModels(
  providerId: string,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId) {
    postMessage({
      type: "bridgeSettingsError",
      error: "Provider ID required",
    });
    return true;
  }

  try {
    const config = await loadProviderConfig(providerId);
    const models = await listModels(providerId, config);
    postMessage({
      type: "bridgeModels",
      providerId,
      models,
    });
    log(`[BridgeSettings] Listed ${models.length} models for ${providerId}`);
  } catch (err) {
    logError(`[BridgeSettings] Failed to list models: ${err}`);
    postMessage({
      type: "bridgeSettingsError",
      error: `Failed to list models: ${err}`,
    });
  }
  return true;
}

async function handleSetDefault(
  providerId: string,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId) {
    postMessage({ type: "bridgeSettingsError", error: "Provider ID required" });
    return true;
  }

  let success = setDefaultProvider(providerId);
  if (success) {
    try {
      await vscode.workspace
        .getConfiguration("projectBrain.bridge")
        .update("defaultProvider", providerId, vscode.ConfigurationTarget.Global);
      log(`[BridgeSettings] Default provider persisted: ${providerId}`);
    } catch (err) {
      success = false;
      logError(`[BridgeSettings] Failed to persist default: ${err}`);
    }
  }

  postMessage({
    type: "bridgeDefaultProviderSet",
    providerId,
    success,
  });
  return true;
}

async function handleValidate(
  providerId: string,
  config: PMProviderConfig,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId || !config) {
    postMessage({ type: "bridgeSettingsError", error: "Provider ID and config required" });
    return true;
  }

  const result = await validateProvider(providerId, config);
  postMessage({
    type: "bridgeProviderValidation",
    providerId,
    result,
  });
  return true;
}

async function handleSaveApiKey(
  providerId: string,
  apiKey: string,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId || !apiKey) {
    postMessage({ type: "bridgeSettingsError", error: "Provider ID and API key required" });
    return true;
  }

  // Reject key that clearly belongs to different provider
  if (isWrongProviderKey(apiKey, providerId)) {
    const hint = providerId === "openrouter"
      ? "This looks like a Gemini key (AIza...). OpenRouter keys start with sk-or-."
      : "This looks like an OpenRouter key (sk-or-...). Gemini keys start with AIza.";
    postMessage({ type: "bridgeSettingsError", error: `Wrong key for ${providerId}: ${hint}` });
    return true;
  }

  try {
    const secretStorage = getSecretStorage();
    if (!secretStorage) {
      throw new Error("Secret storage not available");
    }
    await secretStorage.store(`projectBrain.bridge.${providerId}.apiKey`, apiKey);

    // Also save to global VS Code settings so key is available in ALL workspaces
    const settingKey = GLOBAL_SETTING_KEYS[providerId];
    if (settingKey) {
      const lastDot = settingKey.lastIndexOf(".");
      const section = settingKey.substring(0, lastDot);
      const prop = settingKey.substring(lastDot + 1);
      const vsConfig = vscode.workspace.getConfiguration(section);
      await vsConfig.update(prop, apiKey, vscode.ConfigurationTarget.Global);
    }

    log(`[BridgeSettings] API key saved for ${providerId} (secret + global settings)`);

    postMessage({
      type: "bridgeApiKeySaved",
      providerId,
      success: true,
    });
  } catch (err) {
    logError(`[BridgeSettings] Failed to save API key: ${err}`);
    postMessage({
      type: "bridgeSettingsError",
      error: `Failed to save API key: ${err}`,
    });
  }
  return true;
}

async function handleRequestModelCatalog(
  providerId: string,
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId) {
    postMessage({ type: "bridgeSettingsError", error: "Provider ID required" });
    return true;
  }

  try {
    const config = await loadProviderConfig(providerId);
    const catalog = await fetchAllModels(providerId, config);

    const groups: Record<string, Array<{ id: string; label: string }>> = {};
    for (const m of catalog) {
      const slashIdx = m.id.indexOf("/");
      const group = slashIdx > 0 ? m.id.substring(0, slashIdx) : providerId;
      if (!groups[group]) { groups[group] = []; }
      groups[group].push({ id: m.id, label: m.label });
    }

    const bridgeConfig = vscode.workspace.getConfiguration("projectBrain.bridge");
    const enabledIds = bridgeConfig.get<string[]>(`${providerId}.enabledModelIds`, []);

    postMessage({
      type: "bridgeModelCatalog",
      providerId,
      groups,
      enabledModelIds: enabledIds,
    });
    log(`[BridgeSettings] Catalog for ${providerId}: ${catalog.length} models in ${Object.keys(groups).length} groups`);
  } catch (err) {
    logError(`[BridgeSettings] Failed to fetch catalog: ${err}`);
    postMessage({ type: "bridgeSettingsError", error: `Failed to fetch catalog: ${err}` });
  }
  return true;
}

async function handleSaveEnabledModels(
  providerId: string,
  enabledModelIds: string[],
  postMessage: (msg: unknown) => void
): Promise<boolean> {
  if (!providerId) {
    postMessage({ type: "bridgeSettingsError", error: "Provider ID required" });
    return true;
  }

  try {
    await vscode.workspace
      .getConfiguration("projectBrain.bridge")
      .update(`${providerId}.enabledModelIds`, enabledModelIds, vscode.ConfigurationTarget.Global);

    log(`[BridgeSettings] Saved ${enabledModelIds.length} enabled models for ${providerId}`);
    postMessage({
      type: "bridgeEnabledModelsSaved",
      providerId,
      enabledModelIds,
      success: true,
    });

    // Also re-list filtered models so the session dropdown updates immediately
    try {
      const freshConfig = await loadProviderConfig(providerId);
      const models = await listModels(providerId, freshConfig);
      postMessage({
        type: "bridgeModels",
        providerId,
        models,
      });
    } catch {
      // Non-fatal: catalog saved, dropdown will refresh on next load
    }
  } catch (err) {
    logError(`[BridgeSettings] Failed to save enabled models: ${err}`);
    postMessage({ type: "bridgeSettingsError", error: `Failed to save: ${err}` });
  }
  return true;
}

let _secretStorage: vscode.SecretStorage | null = null;

export function setSecretStorage(storage: vscode.SecretStorage): void {
  _secretStorage = storage;
}

export function getSecretStorage(): vscode.SecretStorage | null {
  return _secretStorage;
}

/**
 * Migrates API keys from SecretStorage to global VS Code settings.
 * Run from any workspace to propagate keys everywhere.
 */
export async function migrateKeysToGlobalSettings(): Promise<string[]> {
  const storage = getSecretStorage();
  if (!storage) {
    throw new Error("SecretStorage not available");
  }

  const migrated: string[] = [];
  for (const [providerId, settingKey] of Object.entries(GLOBAL_SETTING_KEYS)) {
    const secretKey = `projectBrain.bridge.${providerId}.apiKey`;
    const value = await storage.get(secretKey);
    if (value?.trim() && !isWrongProviderKey(value.trim(), providerId)) {
      const lastDot = settingKey.lastIndexOf(".");
      const section = settingKey.substring(0, lastDot);
      const prop = settingKey.substring(lastDot + 1);
      const vsConfig = vscode.workspace.getConfiguration(section);
      await vsConfig.update(prop, value.trim(), vscode.ConfigurationTarget.Global);
      migrated.push(providerId);
      log(`[BridgeSettings] Migrated ${providerId} key to global settings`);
    } else if (value?.trim() && isWrongProviderKey(value.trim(), providerId)) {
      log(`[BridgeSettings] Skipping migration for ${providerId}: key belongs to wrong provider — clearing contaminated secret`);
      await storage.delete(secretKey);
    }
  }
  return migrated;
}

async function loadProviderConfig(
  providerId: string
): Promise<PMProviderConfig> {
  const config = vscode.workspace.getConfiguration("projectBrain.bridge");
  const defaultModel = config.get<string>(`${providerId}.defaultModel`);
  const resolution = await resolveBridgeApiKey(providerId);
  if (!resolution.apiKey) {
    log(
      `[BridgeSettings] API key missing for ${providerId}; checked=${resolution.checkedSources.join(" | ")}`,
    );
  }

  return {
    providerId,
    apiKeyRef: resolution.apiKey,
    enabled: true,
    enabledModelIds: config.get<string[]>(`${providerId}.enabledModelIds`, []),
    defaultModelId: defaultModel,
  };
}
