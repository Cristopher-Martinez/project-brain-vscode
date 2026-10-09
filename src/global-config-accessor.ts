/**
 * global-config-accessor — Singleton accessor for the GlobalConfigProvider.
 * Set once during extension activation, consumed by bridge sessions.
 */
import type { GlobalConfigProvider } from "./global-config-provider";

let instance: GlobalConfigProvider | null = null;

export function setGlobalConfig(config: GlobalConfigProvider): void {
  instance = config;
}

export function getGlobalConfig(): GlobalConfigProvider | null {
  return instance;
}
