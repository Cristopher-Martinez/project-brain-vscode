// ============================================================
// terminal-cwd-guard.ts — INC-15: CWD mismatch detection
// Warns when terminal commands run in the main workspace
// while an active worktree session exists.
// Uses Shell Integration API (VS Code ≥1.93).
// ============================================================

import * as vscode from "vscode";
import * as path from "path";
import { log, logWarn } from "./logger";
import { listAllBranches } from "./fork-queries";

// ─── Config ─────────────────────────────────────────────────────────────────

/** Min interval between warnings (ms). Prevents notification spam. */
const THROTTLE_MS = 30_000;

/** Commands that are safe to run from main workspace (no warning). */
const SAFE_CWD_PATTERNS: RegExp[] = [
  /^\s*cd\b/i, // cd itself (they're navigating)
  /^\s*ls\b|^\s*dir\b/i, // listing files — exploratory
  /^\s*pwd\b/i, // checking where they are
  /^\s*echo\b/i, // echo — informational
  /^\s*cat\b|^\s*type\b/i, // reading a file — usually safe
  /^\s*Get-Location\b/i, // PowerShell pwd
  /^\s*Set-Location\b/i, // PowerShell cd
  /^\s*Push-Location\b/i, // PowerShell pushd
];

// ─── State ──────────────────────────────────────────────────────────────────

let guardDisposable: vscode.Disposable | undefined;
let lastWarningTime = 0;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the terminal CWD guard.
 * Listens to shell execution events and warns when CWD doesn't match
 * any active worktree path.
 */
export function startTerminalCwdGuard(
  subscriptions: vscode.Disposable[],
): void {
  if (guardDisposable) return; // already running

  guardDisposable = vscode.window.onDidStartTerminalShellExecution((event) => {
    handleShellExecution(event);
  });

  subscriptions.push(guardDisposable);
  log("[CwdGuard] Terminal CWD guard started");
}

/** Stop the terminal CWD guard. */
export function stopTerminalCwdGuard(): void {
  guardDisposable?.dispose();
  guardDisposable = undefined;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function handleShellExecution(
  event: vscode.TerminalShellExecutionStartEvent,
): void {
  const executionCwd = event.execution.cwd;
  if (!executionCwd) return; // shell integration didn't report CWD

  // Get active fork sessions
  const activeForks = listAllBranches().filter(
    (i) => i.status === "active" && i.forkPath,
  );
  if (activeForks.length === 0) return; // no fork sessions → nothing to guard

  const command = event.execution.commandLine?.value ?? "";

  // Skip safe/navigational commands
  if (SAFE_CWD_PATTERNS.some((p) => p.test(command))) return;

  const cwdNorm = normalizePath(executionCwd.fsPath);

  // Check if CWD is inside any active fork → all good
  const isInFork = activeForks.some((s) => {
    const fp = normalizePath(s.forkPath!);
    return cwdNorm === fp || cwdNorm.startsWith(fp + path.sep);
  });
  if (isInFork) return; // CWD is correct

  // Throttle warnings
  const now = Date.now();
  if (now - lastWarningTime < THROTTLE_MS) return;
  lastWarningTime = now;

  const targetFork = activeForks[0].forkPath!;
  const cmdPreview =
    command.length > 80 ? command.slice(0, 77) + "..." : command;

  logWarn(
    `[CwdGuard] Command "${cmdPreview}" running outside fork (cwd: ${cwdNorm})`,
  );

  void vscode.window
    .showWarningMessage(
      `⚠️ Comando ejecutándose fuera del fork: "${cmdPreview}". ` +
        `Hay sesión activa en: ${targetFork}`,
      "Copiar cd al fork",
    )
    .then((action) => {
      if (action) {
        void vscode.env.clipboard.writeText(`cd "${targetFork}"`);
        void vscode.window.showInformationMessage(
          "Comando cd copiado al portapapeles.",
        );
      }
    });
}

/** Normalize path for comparison (lowercase on Windows). */
function normalizePath(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
