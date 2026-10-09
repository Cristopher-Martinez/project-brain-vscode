/**
 * Path Rewriter LM Tool — STRAT-3
 *
 * Exposes path rewriting as a toolbox sub-tool so agents can:
 *   1. Resolve workspace paths to fork equivalents
 *   2. Check if a path is in the correct location
 *   3. Detect path leakage in their own output
 *
 * Sub-tool registered via Toolbox.register("resolvePath", ...).
 */

import * as vscode from "vscode";
import { getIsolationInfo } from "./fork-queries";
import {
  detectPathLeakage,
  formatLeakWarning,
  isForkPath,
  rewriteToFork,
  rewriteToWorkspace,
} from "./path-rewriter";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvePathInput {
  /** Action: "toFork" | "toWorkspace" | "check" | "detectLeaks" */
  action: "toFork" | "toWorkspace" | "check" | "detectLeaks" | "toWorktree";
  /** File path(s) to process. For detectLeaks, pass text content instead. */
  path?: string;
  /** Multiple paths (batch mode). */
  paths?: string[];
  /** Text content to scan for leaks (action="detectLeaks"). */
  text?: string;
  /** Session ID to find the worktree. */
  sessionId: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ResolvePathTool implements vscode.LanguageModelTool<ResolvePathInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ResolvePathInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action, sessionId } = options.input;
    this.log(`[ResolvePathTool] action=${action} session=${sessionId}`);

    const info = getIsolationInfo(sessionId);
    if (!info?.forkPath) {
      return this.result(
        "ℹ️ No hay fork activo para esta sesión — las rutas no necesitan reescritura.",
      );
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      return this.result("❌ No se encontró workspace root.");
    }

    switch (action) {
      case "toFork":
      case "toWorktree": // backward compat
        return this.handleToFork(options.input, wsRoot, info.forkPath);
      case "toWorkspace":
        return this.handleToWorkspace(options.input, wsRoot, info.forkPath);
      case "check":
        return this.handleCheck(options.input, info.forkPath);
      case "detectLeaks":
        return this.handleDetectLeaks(options.input, wsRoot, info.forkPath);
      default:
        return this.result(
          `\u274c Acci\u00f3n desconocida: "${action}". Usa: toFork, toWorkspace, check, detectLeaks.`,
        );
    }
  }

  private handleToFork(
    input: ResolvePathInput,
    repoRoot: string,
    forkPath: string,
  ): vscode.LanguageModelToolResult {
    const paths = this.collectPaths(input);
    if (paths.length === 0) {
      return this.result("\u274c Se requiere `path` o `paths`.");
    }

    const results = paths.map((p) => {
      const rewritten = rewriteToFork(p, repoRoot, forkPath);
      return `${p} \u2192 ${rewritten}`;
    });

    this.log(`[ResolvePathTool] toFork: ${paths.length} path(s) resolved`);
    return this.result(results.join("\n"));
  }

  private handleToWorkspace(
    input: ResolvePathInput,
    repoRoot: string,
    forkPath: string,
  ): vscode.LanguageModelToolResult {
    const paths = this.collectPaths(input);
    if (paths.length === 0) {
      return this.result("❌ Se requiere `path` o `paths`.");
    }

    const results = paths.map((p) => {
      const rewritten = rewriteToWorkspace(p, repoRoot, forkPath);
      return `${p} → ${rewritten}`;
    });

    this.log(`[ResolvePathTool] toWorkspace: ${paths.length} path(s) resolved`);
    return this.result(results.join("\n"));
  }

  private handleCheck(
    input: ResolvePathInput,
    forkPath: string,
  ): vscode.LanguageModelToolResult {
    const paths = this.collectPaths(input);
    if (paths.length === 0) {
      return this.result("\u274c Se requiere `path` o `paths`.");
    }

    const results = paths.map((p) => {
      const inFork = isForkPath(p, forkPath);
      return `${p} \u2014 ${inFork ? "\u2705 en fork" : "\u26a0\ufe0f FUERA del fork"}`;
    });

    return this.result(results.join("\n"));
  }

  private handleDetectLeaks(
    input: ResolvePathInput,
    repoRoot: string,
    forkPath: string,
  ): vscode.LanguageModelToolResult {
    const text = input.text || input.path || "";
    if (!text) {
      return this.result("❌ Se requiere `text` para escanear.");
    }

    const leaks = detectPathLeakage(text, repoRoot, forkPath);
    if (leaks.length === 0) {
      return this.result(
        "✅ No se detectaron path leaks. Todo apunta al fork.",
      );
    }

    const warning = formatLeakWarning(leaks);
    this.log(`[ResolvePathTool] detectLeaks: ${leaks.length} leak(s) found`);
    return this.result(warning);
  }

  private collectPaths(input: ResolvePathInput): string[] {
    const paths: string[] = [];
    if (input.path) paths.push(input.path);
    if (input.paths) paths.push(...input.paths);
    return paths;
  }

  private result(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}
