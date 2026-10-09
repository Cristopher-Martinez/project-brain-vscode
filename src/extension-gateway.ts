import * as vscode from "vscode";
import { BrainHQPanel } from "./brain-hq";
import type { FolderState } from "./extension-types";
import { McpGateway } from "./mcp-gateway";
import type { OpinionBank } from "./opinion-bank";
import { OrchestrationManager } from "./orchestration-manager";
import { BrainTreeDataProvider } from "./tree-view";

export interface InitializeGatewayArgs {
  context: vscode.ExtensionContext;
  folder: vscode.WorkspaceFolder;
  memoryPath: string;
  opinionBank: OpinionBank | null;
  orchestrationManager: OrchestrationManager;
  treeDataProvider: BrainTreeDataProvider;
  getState: (
    folder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
  ) => FolderState;
  setActiveGateway: (gateway: McpGateway) => void;
  log: (msg: string) => void;
}

export function initializeGateway(args: InitializeGatewayArgs): void {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const enabled = config.get<boolean>("gateway.enabled", false);
  const port = config.get<number>("gateway.port", 3200);
  const autoStart = config.get<boolean>("gateway.autoStart", false);

  const primaryState = args.getState(args.folder, args.context);
  const deps = {
    identityManager: primaryState.identityManager,
    opinionBank: args.opinionBank ?? undefined,
    orchestrationManager: args.orchestrationManager,
    memoryPath: args.memoryPath,
    workspaceFolder: args.folder,
    mcpManager: primaryState.mcpManager,
    secretStorage: args.context.secrets,
    log: args.log,
  };

  const gateway = new McpGateway(deps, port);
  args.setActiveGateway(gateway);
  args.treeDataProvider.setGatewayRef(gateway);
  BrainHQPanel.currentPanel?.setGateway(gateway);

  args.context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.gateway.toggle", async () => {
      if (gateway.isRunning()) {
        await gateway.stop();
        args.log("[Gateway] Stopped");
        args.treeDataProvider.setGatewayRef(gateway);
        BrainHQPanel.currentPanel?.setGateway(gateway);
        void vscode.window.showInformationMessage("MCP Gateway stopped.");
      } else {
        await gateway.start();
        args.treeDataProvider.setGatewayRef(gateway);
        BrainHQPanel.currentPanel?.setGateway(gateway);
        const tkns = await gateway.listTokens();
        const hasToken = tkns.length > 0;
        if (!hasToken) {
          const newToken = await gateway.generateToken("default", [
            "read",
            "write",
            "loop",
            "orchestrate",
          ]);
          args.log("[Gateway] Default token created");
          void vscode.window.showInformationMessage(
            `MCP Gateway started on port ${gateway.getPort()}. Token: ${newToken}`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `MCP Gateway started on http://127.0.0.1:${gateway.getPort()}`,
          );
        }
      }
    }),
  );

  args.context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.gateway.showToken",
      async () => {
        const raw = await args.context.secrets.get("projectBrain.gateway.tokens");
        if (!raw) {
          void vscode.window.showInformationMessage("No gateway tokens stored.");
          return;
        }
        const tokens = JSON.parse(raw) as Array<{
          token: string;
          label: string;
          scopes: string[];
        }>;
        if (tokens.length === 0) {
          void vscode.window.showInformationMessage("Token list is empty.");
          return;
        }
        const items = tokens.map((t) => ({
          label: `$(key) ${t.label}`,
          description: `[${t.scopes.join(", ")}]`,
          detail: t.token,
          token: t.token,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a token to copy to clipboard",
          title: "MCP Gateway Tokens",
        });
        if (picked) {
          await vscode.env.clipboard.writeText(picked.token);
          void vscode.window.showInformationMessage(
            `Token "${picked.label.replace("$(key) ", "")}" copied to clipboard!`,
          );
        }
      },
    ),
  );

  if (enabled && autoStart) {
    gateway
      .start()
      .then(() => {
        args.treeDataProvider.setGatewayRef(gateway);
        BrainHQPanel.currentPanel?.setGateway(gateway);
        args.log(`[Gateway] Auto-started on port ${gateway.getPort()}`);
      })
      .catch((e) => args.log(`[Gateway] Auto-start failed: ${e}`));
  }
}
