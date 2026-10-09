import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Bootstrapper } from "../bootstrapper";

suite("Bootstrapper Memory Structure Tests", () => {
  let tempRoot: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-bootstrap-memory-"));
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("createMemoryStructure creates agents diary directory", async () => {
    const workspacePath = path.join(tempRoot, "workspace");
    const extensionPath = path.join(tempRoot, "extension");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(extensionPath, { recursive: true });

    const folder = {
      uri: vscode.Uri.file(workspacePath),
      name: "workspace",
      index: 0,
    } as vscode.WorkspaceFolder;

    const bootstrapper = new Bootstrapper(folder, {
      extensionPath,
    } as vscode.ExtensionContext);

    await bootstrapper.createMemoryStructure();

    const memoryRoot = path.join(workspacePath, ".project-brain", "memory");
    assert.ok(fs.existsSync(path.join(memoryRoot, "archive")));
    assert.ok(fs.existsSync(path.join(memoryRoot, "skills")));
    assert.ok(fs.existsSync(path.join(memoryRoot, "agents")));
    assert.ok(fs.existsSync(path.join(workspacePath, ".vscode")));
  });
});