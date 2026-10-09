// ─── Delegate Command (extracted from extension.ts) ─────────────────────────
// Responsibility: projectBrain.delegate — slave task delegation via ModelRouter
import * as vscode from "vscode";
import type { ModelRouter } from "./model-router";

export interface DelegateCommandDeps {
  modelRouter: ModelRouter;
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
  log: (msg: string) => void;
}

export function registerDelegateCommand(
  context: vscode.ExtensionContext,
  deps: DelegateCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.delegate",
      async (argsJson?: string) => {
        try {
          let prompt =
            "Summarize: Project Brain is a VS Code extension for self-documenting codebases.";
          let taskKind = "summarize";
          let maxTier = "free";
          let maxRetries: number | undefined;

          if (argsJson) {
            try {
              const parsed = JSON.parse(argsJson);
              prompt = parsed.prompt ?? prompt;
              taskKind = parsed.taskKind ?? taskKind;
              maxTier = parsed.maxTier ?? maxTier;
              maxRetries = parsed.maxRetries;
            } catch {
              prompt = argsJson;
            }
          } else {
            const userPrompt = await vscode.window.showInputBox({
              prompt: "Task prompt for slave delegation",
              placeHolder: "What should the slave do?",
            });
            if (!userPrompt) return;
            prompt = userPrompt;

            const kindPick = await vscode.window.showQuickPick(
              [
                "summarize",
                "generate-code",
                "generate-test",
                "code-review",
                "format",
                "list",
                "classify",
                "transform",
                "extract",
                "document",
                "debug-analyze",
                "refactor",
                "raw",
              ],
              { placeHolder: "Task kind (specialist persona)" },
            );
            if (kindPick) taskKind = kindPick;

            const tierPick = await vscode.window.showQuickPick(
              ["free", "cheap", "standard", "premium"],
              { placeHolder: "Max tier (cost ceiling)" },
            );
            if (tierPick) maxTier = tierPick;
          }

          deps.log(
            `[Delegate Command] Starting: [${taskKind}] maxTier=${maxTier}`,
          );
          deps.log(`[Delegate Command] Prompt: ${prompt.substring(0, 100)}...`);

          const models = deps.modelRouter.getAvailableModels();
          if (models.length === 0) {
            await deps.modelRouter.discoverModels();
          }
          const fallback = deps.modelRouter.getAvailableModels()[0];
          if (!fallback) {
            const errMsg = "No models available for delegation";
            deps.log(`[Delegate Command] ${errMsg}`);
            vscode.window.showErrorMessage(`Project Brain: ${errMsg}`);
            return;
          }

          const cts = new vscode.CancellationTokenSource();
          const timeout = setTimeout(() => cts.cancel(), 60_000);

          try {
            const result = await deps.modelRouter.delegateTask(
              prompt,
              cts.token,
              fallback,
              {
                taskKind: taskKind as any,
                maxTier: maxTier as any,
                maxRetries,
              },
            );
            clearTimeout(timeout);

            const resultData = {
              timestamp: new Date().toISOString(),
              taskKind,
              maxTier,
              prompt: prompt.substring(0, 200),
              model: result.decision.selectedModel.id,
              tier: result.decision.reason,
              attempts: result.attempts,
              wasEscalated: result.wasEscalated,
              validation: {
                isValid: result.validation.isValid,
                score: result.validation.score,
                issues: result.validation.issues,
              },
              responseTimeMs: result.responseTimeMs,
              textLength: result.text.length,
              text: result.text,
            };

            const folder = await deps.pickWorkspaceFolder();
            if (folder) {
              const resultPath = vscode.Uri.joinPath(
                folder.uri,
                "docs",
                "memory",
                ".last-delegation.json",
              );
              await vscode.workspace.fs.writeFile(
                resultPath,
                Buffer.from(JSON.stringify(resultData, null, 2), "utf-8"),
              );
              deps.log(
                `[Delegate Command] Result written to ${resultPath.fsPath}`,
              );
            }

            deps.log(
              `[Delegate Command] ✅ Done: model=${resultData.model}, ` +
                `score=${resultData.validation.score}, attempts=${resultData.attempts}, ` +
                `${resultData.responseTimeMs}ms`,
            );
            deps.log(
              `[Delegate Command] Output: ${result.text.substring(0, 300)}`,
            );

            vscode.window.showInformationMessage(
              `Delegation complete: ${resultData.model} (${taskKind}, score: ${resultData.validation.score.toFixed(2)})`,
            );

            return resultData;
          } finally {
            clearTimeout(timeout);
            cts.dispose();
          }
        } catch (err) {
          deps.log(`[Delegate Command] Error: ${err}`);
          vscode.window.showErrorMessage(`Delegation failed: ${err}`);
        }
      },
    ),
  );
}
