import type { WebviewToExtensionMessage } from "./types/messages";

// Acquire the VS Code API singleton
interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

export function postMessage(message: WebviewToExtensionMessage): void {
  getVsCodeApi().postMessage(message);
}
