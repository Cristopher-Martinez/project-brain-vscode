import * as vscode from "vscode";
import {
  hydrateLoopContext,
  type HydrateLoopContextInput,
} from "./loop-hydration";

export class HydrateLoopContextTool implements vscode.LanguageModelTool<HydrateLoopContextInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<HydrateLoopContextInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { sessionId, sourceSessionId, mode } = options.input;

    if (!sessionId) {
      return this.text("Missing sessionId parameter.");
    }

    try {
      const output = hydrateLoopContext({
        sessionId,
        sourceSessionId,
        mode,
      });
      this.log(
        `[HydrateLoopContext] sessionId=${sessionId} source=${sourceSessionId ?? "auto"} mode=${mode ?? "summary"}`,
      );
      return this.text(output);
    } catch (error) {
      this.log(`[HydrateLoopContext] error: ${error}`);
      return this.text("Failed to hydrate loop context.");
    }
  }

  private text(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(message),
    ]);
  }
}
