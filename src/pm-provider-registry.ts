/**
 * pm-provider-registry — Central registry for PM model providers.
 *
 * Follows the pattern from server/src/embeddings.ts:
 *  - registerStrategy() to add providers
 *  - resolveProvider() to pick the active one
 *  - listModels() to enumerate available models
 *
 * The registry is populated at extension activation. In the MVP,
 * only Gemini is registered. Phase 2 adds OpenAI, Anthropic, etc.
 */

import { log, logError, logWarn } from "./logger";
import {
  PMClient,
  PMModelDescriptor,
  PMProviderConfig,
  ProviderValidationResult,
} from "./auto-loop-bridge-types";
import { PMModelStrategy } from "./pm-model-strategy";

// ── Registry State ───────────────────────────────────────────────

const strategies: Map<string, PMModelStrategy> = new Map();
let defaultProviderId: string | null = null;

// ── Registration ─────────────────────────────────────────────────

/**
 * Register a PM model strategy.
 * The first registered strategy becomes the default if none is set.
 */
export function registerStrategy(strategy: PMModelStrategy): void {
  if (strategies.has(strategy.providerId)) {
    logWarn(
      `[PMRegistry] Overwriting existing strategy: ${strategy.providerId}`
    );
  }
  strategies.set(strategy.providerId, strategy);
  log(`[PMRegistry] Registered provider: ${strategy.label} (${strategy.providerId})`);

  if (defaultProviderId === null) {
    defaultProviderId = strategy.providerId;
    log(`[PMRegistry] Default provider set to: ${strategy.providerId}`);
  }
}

/**
 * Set the default provider by ID.
 */
export function setDefaultProvider(providerId: string): boolean {
  if (!strategies.has(providerId)) {
    logWarn(`[PMRegistry] Cannot set default — unknown provider: ${providerId}`);
    return false;
  }
  defaultProviderId = providerId;
  log(`[PMRegistry] Default provider changed to: ${providerId}`);
  return true;
}

// ── Resolution ───────────────────────────────────────────────────

/**
 * Resolve the active PM strategy by provider ID.
 * Falls back to default if no specific ID given.
 */
export function resolveProvider(
  providerId?: string
): PMModelStrategy | null {
  const targetId = providerId ?? defaultProviderId;
  if (!targetId) {
    logWarn("[PMRegistry] No provider registered");
    return null;
  }

  const strategy = strategies.get(targetId) ?? null;
  if (!strategy) {
    logWarn(`[PMRegistry] Provider not found: ${targetId}`);
  }
  return strategy;
}

/**
 * Get a strategy by its exact provider ID.
 */
export function getStrategy(
  providerId: string
): PMModelStrategy | null {
  return strategies.get(providerId) ?? null;
}

// ── Queries ──────────────────────────────────────────────────────

/**
 * List all registered providers with their labels and IDs.
 */
export function listProviders(): Array<{
  providerId: string;
  label: string;
  isDefault: boolean;
}> {
  return Array.from(strategies.values()).map((s) => ({
    providerId: s.providerId,
    label: s.label,
    isDefault: s.providerId === defaultProviderId,
  }));
}

/**
 * List models for a specific provider.
 */
export async function listModels(
  providerId: string,
  config: PMProviderConfig
): Promise<PMModelDescriptor[]> {
  const strategy = strategies.get(providerId);
  if (!strategy) {
    logWarn(`[PMRegistry] Cannot list models — unknown provider: ${providerId}`);
    return [];
  }

  try {
    return await strategy.listModels(config);
  } catch (err) {
    logError(`[PMRegistry] Failed to list models for ${providerId}: ${err}`);
    return [];
  }
}

/**
 * Fetch the full model catalog from a provider's API.
 * Falls back to listModels if fetchAllModels is not implemented.
 */
export async function fetchAllModels(
  providerId: string,
  config: PMProviderConfig
): Promise<PMModelDescriptor[]> {
  const strategy = strategies.get(providerId);
  if (!strategy) {
    logWarn(`[PMRegistry] Cannot fetch catalog — unknown provider: ${providerId}`);
    return [];
  }

  try {
    if (strategy.fetchAllModels) {
      return await strategy.fetchAllModels(config);
    }
    return await strategy.listModels(config);
  } catch (err) {
    logError(`[PMRegistry] Failed to fetch catalog for ${providerId}: ${err}`);
    return [];
  }
}

/**
 * Validate a provider configuration.
 */
export async function validateProvider(
  providerId: string,
  config: PMProviderConfig
): Promise<ProviderValidationResult> {
  const strategy = strategies.get(providerId);
  if (!strategy) {
    return { valid: false, error: `Unknown provider: ${providerId}` };
  }

  try {
    return await strategy.validateConfig(config);
  } catch (err) {
    return { valid: false, error: `Validation failed: ${err}` };
  }
}

/**
 * Create a PM client for the given provider and config.
 */
export async function createClient(
  providerId: string,
  config: PMProviderConfig
): Promise<PMClient | null> {
  const strategy = strategies.get(providerId);
  if (!strategy) {
    logWarn(`[PMRegistry] Cannot create client — unknown provider: ${providerId}`);
    return null;
  }

  try {
    return await strategy.createClient(config);
  } catch (err) {
    logError(`[PMRegistry] Failed to create client for ${providerId}: ${err}`);
    throw err;
  }
}

// ── Lifecycle ────────────────────────────────────────────────────

/**
 * Get the number of registered providers.
 */
export function getRegisteredCount(): number {
  return strategies.size;
}

/**
 * Get the default provider ID.
 */
export function getDefaultProviderId(): string | null {
  return defaultProviderId;
}

/**
 * Get the correct default model ID for a given provider.
 * Each provider has its own model ID format (e.g. OpenRouter needs org/ prefix).
 */
export function getDefaultModelForProvider(providerId: string): string {
  const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
    gemini: "gemini-2.5-flash",
    openrouter: "google/gemini-2.5-flash",
  };
  return PROVIDER_DEFAULT_MODELS[providerId] ?? "gemini-2.5-flash";
}

/**
 * Clear all registered strategies. Useful for testing.
 */
export function clearRegistry(): void {
  strategies.clear();
  defaultProviderId = null;
  log("[PMRegistry] Registry cleared");
}
