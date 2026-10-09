/**
 * Extension Update Commands — Publish new versions for beta testers.
 *
 * Commands:
 *   projectBrain.publishExtension — Package + upload VSIX to server
 *
 * @module ExtensionUpdateCommands
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./logger";

export interface ExtensionUpdateDeps {
  getSaasClient: () => any | null;
}

export function registerExtensionUpdateCommands(
  context: vscode.ExtensionContext,
  deps: ExtensionUpdateDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.publishExtension",
      async () => {
        const saasClient = deps.getSaasClient();
        if (!saasClient) {
          vscode.window.showErrorMessage(
            "Not connected to Project Brain server. Login first.",
          );
          return;
        }

        // Find extension root (where package.json lives)
        const extRoot = context.extensionPath;
        const pkgPath = path.join(extRoot, "package.json");
        if (!fs.existsSync(pkgPath)) {
          vscode.window.showErrorMessage(
            "Cannot find extension package.json",
          );
          return;
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const version = pkg.version as string;

        // Ask for changelog
        const changelog = await vscode.window.showInputBox({
          prompt: `Publishing v${version}. Enter changelog (optional):`,
          placeHolder: "Bug fixes, new features...",
        });
        if (changelog === undefined) return; // cancelled

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Publishing Extension",
            cancellable: false,
          },
          async (progress) => {
            try {
              // Step 1: Package VSIX
              progress.report({ message: "Packaging VSIX...", increment: 20 });
              log("[PublishExt] Running vsce package...");

              const vsixName = `project-brain-${version}.vsix`;
              const vsixPath = path.join(extRoot, vsixName);

              // Remove old VSIX if exists
              if (fs.existsSync(vsixPath)) {
                fs.unlinkSync(vsixPath);
              }

              execSync("npx @vscode/vsce package --no-dependencies", {
                cwd: extRoot,
                stdio: "pipe",
                timeout: 60_000,
              });

              if (!fs.existsSync(vsixPath)) {
                // Try to find any .vsix file
                const vsixFiles = fs
                  .readdirSync(extRoot)
                  .filter((f) => f.endsWith(".vsix"));
                if (vsixFiles.length === 0) {
                  throw new Error("VSIX packaging failed — no .vsix file found");
                }
                // Use the most recent one
                const latestVsix = vsixFiles.sort().pop()!;
                const actualPath = path.join(extRoot, latestVsix);
                if (actualPath !== vsixPath) {
                  fs.renameSync(actualPath, vsixPath);
                }
              }

              // Step 2: Read VSIX
              progress.report({ message: "Uploading to server...", increment: 30 });
              const vsixBuffer = fs.readFileSync(vsixPath);
              const sizeMB = (vsixBuffer.length / 1024 / 1024).toFixed(2);
              log(`[PublishExt] VSIX size: ${sizeMB} MB`);

              // Step 3: Upload
              const result = await saasClient.publishExtension(
                vsixBuffer,
                version,
                changelog || "",
              );

              if (result.success) {
                progress.report({ message: "Done!", increment: 50 });
                vscode.window.showInformationMessage(
                  `✅ Extension v${version} published! (${sizeMB} MB)`,
                );
                log(`[PublishExt] Published v${version} successfully`);
              } else {
                throw new Error(result.error || "Unknown error");
              }

              // Cleanup VSIX file
              try {
                fs.unlinkSync(vsixPath);
              } catch { /* best effort */ }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log(`[PublishExt] Failed: ${msg}`);
              vscode.window.showErrorMessage(
                `Failed to publish extension: ${msg}`,
              );
            }
          },
        );
      },
    ),
  );
}
