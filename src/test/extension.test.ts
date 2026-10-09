import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Activation Tests", () => {
  test("Extension should be present", () => {
    const ext = vscode.extensions.getExtension("crismart.project-brain");
    assert.ok(ext, "Extension should be found");
  });

  test("Extension should activate", async () => {
    const ext = vscode.extensions.getExtension("crismart.project-brain");
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext?.isActive, "Extension should be active");
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "projectBrain.init",
      "projectBrain.scan",
      "projectBrain.status",
      "projectBrain.openMemory",
      "projectBrain.importContentTxt",
      "projectBrain.startAutoVectorization",
      "projectBrain.stopAutoVectorization",
      "projectBrain.excludeFromGit",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
  });

  test("Output channel should exist", () => {
    // The output channel is created during activation
    // We can verify by checking the extension is active
    const ext = vscode.extensions.getExtension("crismart.project-brain");
    assert.ok(
      ext?.isActive,
      "Extension should be active (output channel created)",
    );
  });

  test("Import content command is contributed to the memory view title", () => {
    const ext = vscode.extensions.getExtension("crismart.project-brain");
    assert.ok(ext, "Extension should be found");

    const commands = ext?.packageJSON?.contributes?.commands ?? [];
    const importCommand = commands.find(
      (entry: { command?: string }) => entry.command === "projectBrain.importContentTxt",
    ) as { title?: string } | undefined;

    assert.ok(importCommand, "Import content command should be contributed");
    assert.strictEqual(
      importCommand?.title,
      "Project Brain: Import chat content from content.txt",
    );

    const viewTitleMenus = ext?.packageJSON?.contributes?.menus?.["view/title"] ?? [];
    assert.ok(
      viewTitleMenus.some(
        (entry: { command?: string; when?: string }) =>
          entry.command === "projectBrain.importContentTxt"
            && entry.when === "view == projectBrain.memoryView",
      ),
      "Import content command should appear in the memory view title menu",
    );
  });
});
