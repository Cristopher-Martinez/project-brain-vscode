import * as vscode from "vscode";

// ─── Centralized logger for Project Brain extension ───────────────────────────
// All extension source files should use this instead of console.log/error/warn.
// The output goes to the "Project Brain" output channel when registered,
// falling back to console.log if the channel isn't set yet (e.g., during early init).

let _channel: vscode.OutputChannel | undefined;

/** Register the output channel (called once from extension.ts activate). */
export function setOutputChannel(channel: vscode.OutputChannel | undefined): void {
  _channel = channel;
}

/** Best-effort write that survives VS Code shutdown after the channel closes. */
export function appendOutputLine(line: string): void {
  if (_channel) {
    try {
      _channel.appendLine(line);
      return;
    } catch {
      _channel = undefined;
    }
  }

  console.log(line);
}

/** Log a timestamped message to the Project Brain output channel. */
export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  appendOutputLine(line);
}

/** Log an error to the output channel and also to console.error for debug. */
export function logError(msg: string, error?: unknown): void {
  const errorMsg = error instanceof Error ? error.message : String(error ?? "");
  const full = errorMsg ? `${msg}: ${errorMsg}` : msg;
  log(`[ERROR] ${full}`);
  // Also send to console.error so it shows in Debug Console
  console.error(`[Project Brain] ${full}`);
}

/** Log a warning to the output channel. */
export function logWarn(msg: string): void {
  log(`[WARN] ${msg}`);
}
