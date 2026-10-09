import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

// ─── Batch Command Types ─────────────────────────────────────────────────────

interface CommandType {
  id: string;
  label: string;
  description: string;
  icon: string;
}

const COMMAND_TYPES: CommandType[] = [
  {
    id: "search",
    label: "🔍 Search Memory",
    description: "Semantic search across .project-brain/memory/",
    icon: "search",
  },
  {
    id: "read",
    label: "📖 Read File",
    description: "Read a file or memory document",
    icon: "file",
  },
  {
    id: "execute",
    label: "⚡ Execute Terminal",
    description: "Run a shell command",
    icon: "terminal",
  },
  {
    id: "git",
    label: "📦 Git Command",
    description: "Run a git command",
    icon: "git-commit",
  },
  {
    id: "code",
    label: "💻 Code Change",
    description: "Implement a code modification",
    icon: "code",
  },
  {
    id: "report",
    label: "📢 Report Message",
    description: "Write a message to output",
    icon: "comment",
  },
];

// ─── Quick Input Flow ────────────────────────────────────────────────────────

export async function createBatchCommand(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const commandType = await vscode.window.showQuickPick(
    COMMAND_TYPES.map((t) => ({
      label: t.label,
      description: t.description,
      id: t.id,
    })),
    {
      placeHolder: "Select command type",
      title: "Batch Mode: New Command",
    },
  );

  if (!commandType) return;

  let commandText: string | undefined;

  // Step 2: Get command details based on type
  switch (commandType.id) {
    case "search":
      commandText = await vscode.window.showInputBox({
        prompt: "Enter search query",
        placeHolder: 'e.g., "troubleshooting deploy"',
        title: "Batch Mode: Search Memory",
      });
      if (commandText) {
        commandText = `search: "${commandText}"`;
      }
      break;

    case "read":
      commandText = await vscode.window.showInputBox({
        prompt: "Enter filename or memory aspect",
        placeHolder: "e.g., 01_ARCHITECTURE.md or src/file.ts",
        title: "Batch Mode: Read File",
      });
      if (commandText) {
        commandText = `read: ${commandText}`;
      }
      break;

    case "execute":
      commandText = await vscode.window.showInputBox({
        prompt: "Enter shell command",
        placeHolder: "e.g., npm run compile",
        title: "Batch Mode: Execute Terminal",
      });
      if (commandText) {
        commandText = `execute: ${commandText}`;
      }
      break;

    case "git":
      commandText = await vscode.window.showInputBox({
        prompt: "Enter git command (without 'git' prefix)",
        placeHolder: 'e.g., add -A or commit -m "message"',
        title: "Batch Mode: Git Command",
      });
      if (commandText) {
        commandText = `git: ${commandText}`;
      }
      break;

    case "code":
      commandText = await vscode.window.showInputBox({
        prompt: "Describe the code change",
        placeHolder: "e.g., refactor scanner.ts to use async/await",
        title: "Batch Mode: Code Change",
      });
      if (commandText) {
        commandText = `code: ${commandText}`;
      }
      break;

    case "report":
      commandText = await vscode.window.showInputBox({
        prompt: "Enter message to report",
        placeHolder: 'e.g., "Deploy completed successfully"',
        title: "Batch Mode: Report Message",
      });
      if (commandText) {
        commandText = `report: "${commandText}"`;
      }
      break;
  }

  if (!commandText) return;

  // Step 3: Ask if they want to add more
  const addMore = await vscode.window.showQuickPick(
    ["Add to batch", "Add & create another", "Cancel"],
    {
      placeHolder: "What next?",
      title: "Batch Mode: Command Created",
    },
  );

  if (addMore === "Cancel") return;

  // Append to commands.txt
  const commandsPath = path.join(
    workspaceFolder.uri.fsPath,
    ".project-brain",
    "commands.txt",
  );

  try {
    let content = await fs.readFile(commandsPath, "utf-8");

    // Find where to insert (after the last non-empty, non-comment line)
    const lines = content.split("\n");
    let insertIndex = lines.length;

    // Skip trailing empty lines and comments
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line && !line.startsWith("#")) {
        insertIndex = i + 1;
        break;
      }
    }

    lines.splice(insertIndex, 0, commandText);
    content = lines.join("\n");

    await fs.writeFile(commandsPath, content, "utf-8");
    vscode.window.showInformationMessage(`✅ Command added: ${commandText}`);

    // If they want to add another, recurse
    if (addMore === "Add & create another") {
      await createBatchCommand(workspaceFolder);
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to write command: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── File Operations ─────────────────────────────────────────────────────────

export async function editCommandsFile(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const commandsPath = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".project-brain",
    "commands.txt",
  );

  try {
    const doc = await vscode.workspace.openTextDocument(commandsPath);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to open commands.txt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function viewOutputFile(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const outputPath = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".project-brain",
    "output.txt",
  );

  try {
    const doc = await vscode.workspace.openTextDocument(outputPath);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to open output.txt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function executeBatch(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  // Open chat and send "batch" message
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: "batch",
      isPartialQuery: false, // Auto-submit
    });
    vscode.window.showInformationMessage("🧠 Batch mode activated!");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to open chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
