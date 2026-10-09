/**
 * projectBrain_gitChanges — Show modified, staged, and untracked files.
 * Replaces native `get_changed_files` with richer context.
 *
 * Uses VS Code SCM API (no child_process needed).
 *
 * @module lm-tools-git-changes
 */

import * as vscode from "vscode";

// ─── Types ──────────────────────────────────────────────────────
interface GitChangesInput {
  /** Filter: "all" | "staged" | "modified" | "untracked". Default: "all" */
  filter?: string;
  /** Only show changes in this directory (relative to workspace root) */
  directory?: string;
}

interface FileChange {
  path: string;
  status: string;
  staged: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Map SCM resource decorations to readable status labels. */
function statusFromDecorations(
  resource: vscode.SourceControlResourceState,
): string {
  // Git extension uses specific letter codes in the resourceUri query
  const uri = resource.resourceUri.toString();
  const letter = resource.decorations?.tooltip?.charAt(0) ?? "";
  const map: Record<string, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "untracked",
    "?": "untracked",
  };
  if (map[letter]) return map[letter];

  // Fallback: infer from context label
  const ctx = resource.contextValue ?? "";
  if (ctx.includes("untracked")) return "untracked";
  if (ctx.includes("modified")) return "modified";
  if (ctx.includes("deleted")) return "deleted";
  if (ctx.includes("added")) return "added";
  if (uri.includes("?")) return "untracked";
  return "changed";
}

// ─── Tool ───────────────────────────────────────────────────────
export class BrainGitChangesTool
  implements vscode.LanguageModelTool<GitChangesInput>
{
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GitChangesInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const filter = options.input.filter ?? "all";
    const dirFilter = options.input.directory;

    try {
      // Access VS Code's SCM providers
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (!gitExt) {
        return this.fallbackText(
          "Git extension not found. Make sure VS Code Git is enabled.",
        );
      }

      const gitApi = gitExt.isActive
        ? gitExt.exports.getAPI(1)
        : (await gitExt.activate()).getAPI(1);

      if (!gitApi || gitApi.repositories.length === 0) {
        return this.fallbackText("No Git repositories found in workspace.");
      }

      const allChanges: FileChange[] = [];

      for (const repo of gitApi.repositories) {
        const rootPath = repo.rootUri.fsPath;

        // Staged (index) changes
        if (filter === "all" || filter === "staged") {
          for (const r of repo.state.indexChanges ?? []) {
            allChanges.push({
              path: vscode.workspace.asRelativePath(r.uri),
              status: this.gitStatusLabel(r.status),
              staged: true,
            });
          }
        }

        // Working tree changes (modified)
        if (filter === "all" || filter === "modified") {
          for (const r of repo.state.workingTreeChanges ?? []) {
            allChanges.push({
              path: vscode.workspace.asRelativePath(r.uri),
              status: this.gitStatusLabel(r.status),
              staged: false,
            });
          }
        }

        // Untracked
        if (filter === "all" || filter === "untracked") {
          for (const r of repo.state.untrackedChanges ?? []) {
            allChanges.push({
              path: vscode.workspace.asRelativePath(r.uri),
              status: "untracked",
              staged: false,
            });
          }
        }
      }

      // Apply directory filter
      let filtered = allChanges;
      if (dirFilter) {
        const norm = dirFilter.replace(/\\/g, "/");
        filtered = allChanges.filter((c) =>
          c.path.replace(/\\/g, "/").startsWith(norm),
        );
      }

      if (filtered.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `No ${filter === "all" ? "" : filter + " "}changes found.`,
          ),
        ]);
      }

      // Group by status
      const grouped = this.groupByStatus(filtered);
      const lines: string[] = [`## Git Changes (${filtered.length} files)\n`];

      for (const [status, files] of Object.entries(grouped)) {
        lines.push(`### ${status} (${files.length})`);
        for (const f of files) {
          const badge = f.staged ? " [staged]" : "";
          lines.push(`- ${f.path}${badge}`);
        }
        lines.push("");
      }

      this.log(`[GitChanges] ${filtered.length} changes (filter=${filter})`);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(lines.join("\n")),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[GitChanges] error: ${msg}`);
      return this.fallbackText(`Error reading git changes: ${msg}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GitChangesInput>,
    _token: vscode.CancellationToken,
  ) {
    const f = options.input.filter ?? "all";
    return { invocationMessage: `Reading git changes (${f})` };
  }

  // ─── Private ────────────────────────────────────────────────
  private gitStatusLabel(status: number): string {
    // Git extension status enum values
    const labels: Record<number, string> = {
      0: "modified",
      1: "added",
      2: "deleted",
      3: "renamed",
      4: "copied",
      5: "unmerged",
      6: "ignored",
      7: "intent-to-add",
    };
    return labels[status] ?? "modified";
  }

  private groupByStatus(
    changes: FileChange[],
  ): Record<string, FileChange[]> {
    const groups: Record<string, FileChange[]> = {};
    for (const c of changes) {
      (groups[c.status] ??= []).push(c);
    }
    return groups;
  }

  private fallbackText(msg: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}
