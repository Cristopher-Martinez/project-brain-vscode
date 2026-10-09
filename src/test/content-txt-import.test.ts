import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  importContentTxtFile,
  pickContentTxtFile,
  type ContentTxtPickerApi,
} from "../content-txt-import";

function makeTempRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pb-content-import-"));
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

suite("ContentTxtImport", () => {
  test("returns undefined when picker is cancelled", async () => {
    const picker: ContentTxtPickerApi = {
      showOpenDialog: async () => undefined,
    };

    const selectedPath = await pickContentTxtFile(picker);
    assert.strictEqual(selectedPath, undefined);
  });

  test("returns the selected file path from the picker", async () => {
    const expectedPath = path.join(os.tmpdir(), "content.txt");
    const picker: ContentTxtPickerApi = {
      showOpenDialog: async () => [vscode.Uri.file(expectedPath)],
    };

    const selectedPath = await pickContentTxtFile(picker);
    assert.strictEqual(selectedPath, expectedPath);
  });

  test("throws when the selected file no longer exists", () => {
    const repoRoot = makeTempRepoRoot();
    const missingPath = path.join(repoRoot, "missing-content.txt");

    assert.throws(
      () => importContentTxtFile(repoRoot, missingPath),
      /We could not find that file anymore\./,
    );
  });

  test("throws when the selected path is a folder", () => {
    const repoRoot = makeTempRepoRoot();
    const folderPath = path.join(repoRoot, "content-folder");
    fs.mkdirSync(folderPath, { recursive: true });

    assert.throws(
      () => importContentTxtFile(repoRoot, folderPath),
      /Please choose a text file, not a folder\./,
    );
  });

  test("throws when the selected file is empty", () => {
    const repoRoot = makeTempRepoRoot();
    const emptyFilePath = path.join(repoRoot, "empty-content.txt");
    writeTextFile(emptyFilePath, "   \n\n  ");

    assert.throws(
      () => importContentTxtFile(repoRoot, emptyFilePath),
      /That file is empty, so there is nothing useful to import\./,
    );
  });

  test("creates a compact markdown note for a valid content export", () => {
    const repoRoot = makeTempRepoRoot();
    const sourcePath = path.join(repoRoot, "exports", "content.txt");
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";

    writeTextFile(
      sourcePath,
      [
        `Loop session ID: ${sessionId}`,
        "loopAwaitInput was blocked by a commit gate error",
        "next step: fix provider persistence and retry",
        "provider should persist after restart",
        "tail preview line",
      ].join("\n"),
    );

    const result = importContentTxtFile(repoRoot, sourcePath);
    const markdown = fs.readFileSync(result.outputPath, "utf8");
    const gitignorePath = path.join(path.dirname(result.outputPath), ".gitignore");

    assert.ok(fs.existsSync(result.outputPath), "Output markdown should exist");
    assert.ok(fs.existsSync(gitignorePath), "Conversations gitignore should exist");
    assert.strictEqual(result.sourcePath, sourcePath);
    assert.deepStrictEqual(result.sessionIds, [sessionId]);
    assert.ok(result.toolHints.includes("loopAwaitInput"));
    assert.ok(result.signalLines >= 1);
    assert.ok(markdown.includes('importKind: "manual-content-txt"'));
    assert.ok(markdown.includes("## Session IDs"));
    assert.ok(markdown.includes(`- ${sessionId}`));
    assert.ok(markdown.includes("## Tool Hints"));
    assert.ok(markdown.includes("- loopAwaitInput"));
    assert.ok(markdown.includes("## Signal Lines"));
    assert.ok(markdown.includes("## Head Preview"));
    assert.ok(markdown.includes("## Tail Preview"));
  });
});