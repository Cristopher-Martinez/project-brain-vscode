import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { FolderState } from "../extension-types";
import {
  runImportContentTxtCommand,
  type ImportContentTxtCommandApi,
  type LifecycleCommandsDeps,
} from "../lifecycle-commands";

function makeTempRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pb-lifecycle-import-"));
}

function makeLifecycleDeps(
  folder: vscode.WorkspaceFolder,
  counters: { refreshCalls: number; indexCalls: number },
): LifecycleCommandsDeps {
  const state = {
    mcpManager: {
      indexProject: async () => {
        counters.indexCalls += 1;
      },
    },
  } as unknown as FolderState;

  return {
    pickWorkspaceFolder: async () => folder,
    context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
    folderStates: new Map(),
    getState: () => state,
    treeDataProvider: {
      refresh: () => {
        counters.refreshCalls += 1;
      },
    } as unknown as LifecycleCommandsDeps["treeDataProvider"],
    statusBarItem: {} as vscode.StatusBarItem,
    getSaasClient: () => null,
    getLoginWebview: () => null,
    getSessionDb: () => null,
    getGlobalConfig: () => null,
    getGlobalKnowledge: () => null,
    log: () => {},
  };
}

suite("LifecycleCommands — Import Content", () => {
  test("refreshes the memory tree after a successful import", async () => {
    const repoRoot = makeTempRepoRoot();
    const outputPath = path.join(repoRoot, ".project-brain", "memory", "conversations", "note.md");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "# Imported note\n", "utf8");

    const folder = {
      name: "project-brain",
      index: 0,
      uri: vscode.Uri.file(repoRoot),
    } as vscode.WorkspaceFolder;
    const counters = { refreshCalls: 0, indexCalls: 0 };
    const deps = makeLifecycleDeps(folder, counters);
    const infoMessages: string[] = [];
    const errorMessages: string[] = [];
    const progressMessages: string[] = [];
    let openedPath = "";
    let showDocumentCalls = 0;

    const api: ImportContentTxtCommandApi = {
      pickContentTxtFile: async () => path.join(repoRoot, "content.txt"),
      importContentTxtFile: () => ({
        outputPath,
        sourcePath: path.join(repoRoot, "content.txt"),
        sessionIds: ["123e4567-e89b-12d3-a456-426614174000"],
        toolHints: ["loopAwaitInput"],
        signalLines: 3,
      }),
      withProgress: async (_options, task) =>
        task(
          {
            report: (value) => {
              if (value.message) {
                progressMessages.push(value.message);
              }
            },
          },
          {} as vscode.CancellationToken,
        ),
      showInformationMessage: async (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        errorMessages.push(message);
        return undefined;
      },
      openTextDocument: async (target) => {
        openedPath = typeof target === "string"
          ? target
          : target && "fsPath" in target
            ? target.fsPath
            : "";
        return { uri: vscode.Uri.file(openedPath) } as vscode.TextDocument;
      },
      showTextDocument: async () => {
        showDocumentCalls += 1;
        return {} as vscode.TextEditor;
      },
    };

    await runImportContentTxtCommand(
      folder,
      deps.context,
      deps,
      api,
    );

    assert.strictEqual(counters.indexCalls, 1);
    assert.strictEqual(counters.refreshCalls, 1);
    assert.strictEqual(showDocumentCalls, 1);
    assert.strictEqual(openedPath, outputPath);
    assert.deepStrictEqual(progressMessages, [
      "Reading the selected file...",
      "Saving a compact note to memory...",
      "Refreshing memory index...",
      "Opening the imported note...",
    ]);
    assert.ok(
      infoMessages.some((message) => message.includes("Chat imported as a compact note.")),
      "Success message should be shown",
    );
    assert.deepStrictEqual(errorMessages, []);
  });
});