/**
 * opencode-commands — VS Code command wiring for the OpenCode subsystem.
 *
 * Decoupled from the Copilot loop engine. Gated behind the
 * `projectBrain.opencode.enabled` setting (default false).
 */

import * as vscode from "vscode";
import { log } from "../logger";
import { findOpenRouterKey, runOpenCodeSmokeTest } from "./opencode-smoke";
import { resolveOpenCodeCommand } from "./opencode-server";
import { openOpenCodeWebview } from "./opencode-webview";
import {
  endOcLoop,
  ensureSharedServerUrl,
  ensureWebServerUrl,
  getAllOcLoopStates,
  initOcEngine,
  sendOcFeedback,
  startOcLoop,
  stopOcServer,
} from "./opencode-engine";
import type { OpenCodeModelRef, OpenCodeSmokeResult, OcLoopState } from "./opencode-types";

export interface OpenCodeCommandDeps {
  /** Resolve the active workspace root, prompting the user when ambiguous. */
  getWorkspaceRoot: () => Promise<string | undefined> | (string | undefined);
}

const CONFIG_SECTION = "projectBrain.opencode";

/** Fallback model when config is empty (validated in Phase 0). */
const FALLBACK_MODEL = "openrouter/openai/gpt-4o-mini";

/**
 * Resolve the configured default model as `{ providerID, modelID }`.
 * Config format is `providerID/modelID` where the first segment is the
 * provider and the remainder (which may contain slashes) is the model id.
 */
function getDefaultModel(): OpenCodeModelRef {
  const raw =
    vscode.workspace.getConfiguration().get<string>(`${CONFIG_SECTION}.defaultModel`, "")?.trim() ||
    FALLBACK_MODEL;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    return { providerID: "openrouter", modelID: "openai/gpt-4o-mini" };
  }
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/** Synchronous best-effort workspace root for the engine. */
function syncWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(`${CONFIG_SECTION}.enabled`, false);
}

/** Verify the feature is enabled; auto-enable on explicit command use. */
async function ensureEnabled(): Promise<boolean> {
  if (isEnabled()) {
    return true;
  }
  log("[OpenCode] feature disabled — auto-enabling (explicit command use)");
  await vscode.workspace
    .getConfiguration()
    .update(`${CONFIG_SECTION}.enabled`, true, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage("OpenCode Loops activado.");
  log("[OpenCode] feature enabled");
  return true;
}

function getBinaryPath(): string | undefined {
  const raw = vscode.workspace.getConfiguration().get<string>(`${CONFIG_SECTION}.serverPath`, "");
  return raw && raw.trim() ? raw.trim() : undefined;
}

function getServerPort(): number | undefined {
  const raw = vscode.workspace.getConfiguration().get<number>(`${CONFIG_SECTION}.serverPort`, 0);
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}

function reportResult(channel: vscode.OutputChannel, result: OpenCodeSmokeResult): void {
  channel.appendLine("─────────────────────────────────────────");
  channel.appendLine("OpenCode Smoke Test");
  channel.appendLine(`  ok:        ${result.ok}`);
  channel.appendLine(`  version:   ${result.serverVersion ?? "—"}`);
  channel.appendLine(`  providers: ${result.providers?.join(", ") ?? "—"}`);
  channel.appendLine(`  model:     ${result.model ?? "—"}`);
  channel.appendLine(`  reply:     ${result.reply ?? "—"}`);
  channel.appendLine(`  elapsed:   ${result.elapsedMs}ms`);
  if (result.error) {
    channel.appendLine(`  note:      ${result.error}`);
  }
  channel.appendLine("─────────────────────────────────────────");
  channel.show(true);
}

async function runSmoke(deps: OpenCodeCommandDeps): Promise<void> {
  if (!isEnabled()) {
    const pick = await vscode.window.showWarningMessage(
      "OpenCode Loops está deshabilitado. ¿Activar projectBrain.opencode.enabled?",
      "Activar",
      "Cancelar",
    );
    if (pick !== "Activar") {
      return;
    }
    await vscode.workspace
      .getConfiguration()
      .update(`${CONFIG_SECTION}.enabled`, true, vscode.ConfigurationTarget.Workspace);
  }

  const workspaceRoot = await deps.getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("No hay workspace activo para el smoke test de OpenCode.");
    return;
  }

  const channel = vscode.window.createOutputChannel("Project Brain — OpenCode");
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "OpenCode smoke test...", cancellable: false },
    async () => {
      log("[OpenCode] starting smoke test");
      const result = await runOpenCodeSmokeTest({
        workspaceRoot,
        binaryPath: getBinaryPath(),
        onLog: (line) => channel.appendLine(`[server] ${line}`),
      });
      reportResult(channel, result);
      if (result.ok) {
        void vscode.window.showInformationMessage(
          `OpenCode OK (v${result.serverVersion}) ${result.reply ? `→ ${result.reply}` : ""}`.trim(),
        );
      } else {
        void vscode.window.showErrorMessage(`OpenCode smoke test falló: ${result.error}`);
      }
    },
  );
}

/** Prompt for a goal and start a new OpenCode loop. */
async function runStartLoop(): Promise<void> {
  if (!isEnabled()) {
    void vscode.window.showWarningMessage(
      "OpenCode Loops está deshabilitado. Activa projectBrain.opencode.enabled.",
    );
    return;
  }
  const goal = await vscode.window.showInputBox({
    title: "OpenCode Loop — Objetivo",
    prompt: "¿Qué quieres que el loop persiga?",
    ignoreFocusOut: true,
  });
  if (!goal?.trim()) {
    return;
  }
  try {
    const sessionId = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: arrancando loop..." },
      () => startOcLoop({ goal: goal.trim(), model: getDefaultModel() }),
    );
    await offerFeedbackCycle(sessionId);
  } catch (err) {
    void vscode.window.showErrorMessage(`OpenCode loop falló: ${(err as Error).message}`);
  }
}

/** After a round, offer to send feedback and continue the cycle. */
async function offerFeedbackCycle(sessionId: string): Promise<void> {
  const channel = vscode.window.createOutputChannel("Project Brain — OpenCode");
  for (;;) {
    const state = getAllOcLoopStates().find((l) => l.sessionId === sessionId);
    const last = state?.rounds.at(-1);
    if (last) {
      channel.appendLine(`\n▶ ${last.kind.toUpperCase()}: ${last.prompt}`);
      channel.appendLine(`◀ REPLY:\n${last.error ? `ERROR: ${last.error}` : last.reply}`);
      channel.show(true);
    }
    const feedback = await vscode.window.showInputBox({
      title: "OpenCode Loop — Feedback",
      prompt: "Envía feedback para otra ronda, o deja vacío para terminar.",
      ignoreFocusOut: true,
    });
    if (!feedback?.trim()) {
      endOcLoop(sessionId);
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: procesando feedback..." },
      () => sendOcFeedback(sessionId, feedback.trim()),
    );
  }
}

/** Show the status of all OpenCode loops in the output channel. */
function runStatus(): void {
  const channel = vscode.window.createOutputChannel("Project Brain — OpenCode");
  const loops = getAllOcLoopStates();
  channel.appendLine("═════ OpenCode Loops ═════");
  if (loops.length === 0) {
    channel.appendLine("  (sin loops)");
  }
  for (const l of loops) {
    channel.appendLine(formatLoopLine(l));
  }
  channel.show(true);
}

function formatLoopLine(l: OcLoopState): string {
  const goal = l.goal.length > 50 ? `${l.goal.slice(0, 50)}…` : l.goal;
  return `  [${l.status}] ${l.sessionId.slice(0, 8)} · ${l.rounds.length} ronda(s) · ${goal}`;
}

/** Build the shell line that attaches the OpenCode TUI to a running server. */
function buildAttachLine(root: string, url: string): string {
  const { command, prefixArgs } = resolveOpenCodeCommand(root, getBinaryPath());
  const parts = [...prefixArgs, "attach", url];
  // Quote the executable when it is a filesystem path (PowerShell needs `&`).
  const isPath = /[\\/]/.test(command);
  const head = isPath ? `& "${command}"` : command;
  return `${head} ${parts.join(" ")}`.trim();
}

/** Ensure the shared server is up and attach the native OpenCode TUI to it. */
async function runOpenUI(): Promise<void> {
  log("[OpenCode] openUI command invoked");
  if (!(await ensureEnabled())) {
    return;
  }
  const root = syncWorkspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("No hay workspace activo para OpenCode.");
    return;
  }
  let url: string;
  try {
    log("[OpenCode] ensuring shared server...");
    url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: preparando server..." },
      () => ensureSharedServerUrl(),
    );
    log(`[OpenCode] shared server URL: ${url}`);
  } catch (err) {
    log(`[OpenCode] server start failed: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`OpenCode: no se pudo iniciar el server: ${(err as Error).message}`);
    return;
  }
  const attachLine = buildAttachLine(root, url);
  log(`[OpenCode] opening terminal: ${attachLine}`);
  const terminal = vscode.window.createTerminal({
    name: "OpenCode TUI",
    cwd: root,
    location: vscode.TerminalLocation.Editor,
  });
  terminal.show();
  terminal.sendText(attachLine);
  log(`[OpenCode] TUI terminal launched`);
}

/** Ensure the web server is up and embed its UI in an editor-tab webview. */
async function runOpenWebUI(): Promise<void> {
  log("[OpenCode] openWebUI command invoked");
  if (!(await ensureEnabled())) {
    return;
  }
  let url: string;
  try {
    log("[OpenCode] ensuring web server...");
    url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: preparando UI web..." },
      () => ensureWebServerUrl(),
    );
    log(`[OpenCode] web server URL: ${url}`);
  } catch (err) {
    log(`[OpenCode] web server start failed: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`OpenCode: no se pudo iniciar la UI web: ${(err as Error).message}`);
    return;
  }
  openOpenCodeWebview(url);
}

/**
 * Stop the running server and re-open the web UI with a fresh process.
 * Use this after changing config (model, port, serverPath) or after a
 * redeploy, so the long-lived server picks up the new settings.
 */
async function runRestartServer(): Promise<void> {
  log("[OpenCode] restartServer command invoked");
  if (!(await ensureEnabled())) {
    return;
  }
  stopOcServer();
  let url: string;
  try {
    url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "OpenCode: reiniciando server..." },
      () => ensureWebServerUrl(),
    );
  } catch (err) {
    log(`[OpenCode] restart failed: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`OpenCode: no se pudo reiniciar: ${(err as Error).message}`);
    return;
  }
  openOpenCodeWebview(url);
  void vscode.window.showInformationMessage("OpenCode: servidor reiniciado con la config actual.");
}

/** Register OpenCode commands. Call from extension activate(). */
export function registerOpenCodeCommands(
  context: vscode.ExtensionContext,
  deps: OpenCodeCommandDeps,
): void {
  initOcEngine({
    getWorkspaceRoot: syncWorkspaceRoot,
    getApiKey: (root) => findOpenRouterKey(root),
    getBinaryPath,
    getServerPort,
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.opencode.smokeTest", () => runSmoke(deps)),
    vscode.commands.registerCommand("projectBrain.opencode.startLoop", () => runStartLoop()),
    vscode.commands.registerCommand("projectBrain.opencode.status", () => runStatus()),
    vscode.commands.registerCommand("projectBrain.opencode.openUI", () => runOpenUI()),
    vscode.commands.registerCommand("projectBrain.opencode.openWebUI", () => runOpenWebUI()),
    vscode.commands.registerCommand("projectBrain.opencode.stopServer", () => {
      stopOcServer();
      void vscode.window.showInformationMessage("OpenCode: servidor detenido.");
    }),
    vscode.commands.registerCommand("projectBrain.opencode.restartServer", () => runRestartServer()),
    { dispose: () => stopOcServer() },
  );
}
