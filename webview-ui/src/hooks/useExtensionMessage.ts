import { useEffect, useCallback } from "react";
import type { ExtensionToWebviewMessage } from "../types/messages";
import { postMessage } from "../vscode";

/**
 * Hook that listens for messages from the extension host.
 * Calls the handler whenever a message arrives.
 */
export function useExtensionMessage(
  handler: (msg: ExtensionToWebviewMessage) => void
): void {
  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      handler(event.data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [handler]);
}

/** Send a command to the extension to execute in VS Code. */
export function useRunCommand(): (commandId: string) => void {
  return useCallback((commandId: string) => {
    postMessage({ type: "runCommand", commandId });
  }, []);
}
