import * as vscode from "vscode";
import { getSecretStorage } from "./brain-hq-bridge-settings-handler";
import { logWarn } from "./logger";

export interface BridgeApiKeyResolution {
  apiKey: string;
  source: string;
  checkedSources: string[];
  settingKey: string;
}

interface SecretCandidate {
  key: string;
  value: string;
}

interface SettingInspection {
  key: string;
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

const CURRENT_SETTING_KEYS: Record<string, string> = {
  openrouter: "projectBrain.bridge.openrouterApiKey",
  gemini: "projectBrain.bridge.geminiApiKey",
};

const LEGACY_SETTING_KEYS: Record<string, string[]> = {
  openrouter: ["projectBrain.openrouterApiKey"],
  gemini: ["projectBrain.geminiApiKey"],
};

const CURRENT_SECRET_KEY = (providerId: string): string => `projectBrain.bridge.${providerId}.apiKey`;
const LEGACY_SECRET_KEY = (providerId: string): string => `projectBrain.${providerId}.apiKey`;

export function getBridgeApiKeySettingKey(providerId: string): string {
  return CURRENT_SETTING_KEYS[providerId] ?? `projectBrain.bridge.${providerId}ApiKey`;
}

/** Returns true if the key pattern clearly belongs to a different provider */
export function isWrongProviderKey(apiKey: string, providerId?: string): boolean {
  if (!providerId) return false;
  if (providerId === "openrouter" && /^AIza[0-9A-Za-z\-_]{35}$/.test(apiKey)) {
    return true; // Gemini key used for OpenRouter
  }
  if (providerId === "gemini" && apiKey.startsWith("sk-or-")) {
    return true; // OpenRouter key used for Gemini
  }
  return false;
}

export function selectBridgeApiKeyResolution(
  directApiKey: string | undefined,
  secretCandidates: SecretCandidate[],
  settingInspections: SettingInspection[],
  providerId?: string,
): BridgeApiKeyResolution {
  const checkedSources: string[] = [];
  const inlineApiKey = directApiKey?.trim() ?? "";
  const primarySettingKey = settingInspections[0]?.key ?? "";

  if (inlineApiKey && !isWrongProviderKey(inlineApiKey, providerId)) {
    return {
      apiKey: inlineApiKey,
      source: "direct",
      checkedSources: ["direct"],
      settingKey: primarySettingKey,
    };
  }
  if (inlineApiKey) {
    checkedSources.push("direct(skipped:wrong-provider)");
  }

  for (const candidate of secretCandidates) {
    checkedSources.push(`secret:${candidate.key}`);
    const value = candidate.value.trim();
    if (value && !isWrongProviderKey(value, providerId)) {
      return {
        apiKey: value,
        source: `secret:${candidate.key}`,
        checkedSources,
        settingKey: primarySettingKey,
      };
    }
    if (value && isWrongProviderKey(value, providerId)) {
      checkedSources[checkedSources.length - 1] += "(skipped:wrong-provider)";
      logWarn(`[BridgeKeyResolver] Skipping ${candidate.key}: key looks like wrong provider for ${providerId}`);
    }
  }

  const scopedFields: Array<keyof SettingInspection> = [
    "workspaceFolderValue",
    "workspaceValue",
    "globalValue",
  ];

  for (const inspection of settingInspections) {
    for (const field of scopedFields) {
      checkedSources.push(`setting:${inspection.key}:${field}`);
      const value = inspection[field];
      if (typeof value === "string" && value.trim() && !isWrongProviderKey(value.trim(), providerId)) {
        return {
          apiKey: value.trim(),
          source: `setting:${inspection.key}:${field}`,
          checkedSources,
          settingKey: primarySettingKey,
        };
      }
      if (typeof value === "string" && value.trim() && isWrongProviderKey(value.trim(), providerId)) {
        checkedSources[checkedSources.length - 1] += "(skipped:wrong-provider)";
        logWarn(`[BridgeKeyResolver] Skipping ${inspection.key}:${field}: key looks like wrong provider for ${providerId}`);
      }
    }
  }

  return {
    apiKey: "",
    source: "missing",
    checkedSources,
    settingKey: primarySettingKey,
  };
}

export async function resolveBridgeApiKey(
  providerId: string,
  directApiKey?: string,
): Promise<BridgeApiKeyResolution> {
  const settingKeys = [
    getBridgeApiKeySettingKey(providerId),
    ...(LEGACY_SETTING_KEYS[providerId] ?? []),
  ];

  const secretCandidates: SecretCandidate[] = [];
  const secretStorage = getSecretStorage();
  if (secretStorage) {
    for (const key of [CURRENT_SECRET_KEY(providerId), LEGACY_SECRET_KEY(providerId)]) {
      secretCandidates.push({
        key,
        value: (await secretStorage.get(key)) ?? "",
      });
    }
  }

  const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const config = vscode.workspace.getConfiguration(undefined, resource);
  const settingInspections = settingKeys.map((key) => {
    const inspection = config.inspect<string>(key);
    return {
      key,
      globalValue: inspection?.globalValue,
      workspaceValue: inspection?.workspaceValue,
      workspaceFolderValue: inspection?.workspaceFolderValue,
    };
  });

  const result = selectBridgeApiKeyResolution(directApiKey, secretCandidates, settingInspections, providerId);

  // Warn if the resolved key smells like it belongs to a different provider
  if (result.apiKey && providerId === "openrouter" && /^AIza[0-9A-Za-z\-_]{35}$/.test(result.apiKey)) {
    logWarn(`[BridgeKeyResolver] Key resolved for openrouter from ${result.source} looks like a Gemini key — check settings`);
  }

  return result;
}