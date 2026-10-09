/**
 * opencode-webview — Embeds the OpenCode web UI inside a VS Code editor tab.
 *
 * The OpenCode `web` server serves a browser UI on its port. We render that
 * UI inside a WebviewPanel via an <iframe>, so it lives as a tab alongside
 * Brain HQ instead of an external browser window.
 */

import * as vscode from "vscode";
import { log } from "../logger";

let activePanel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the OpenCode web UI in an editor tab pointing at `url`. */
export function openOpenCodeWebview(url: string): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.webview.html = buildHtml(url);
    activePanel.reveal(vscode.ViewColumn.Active);
    return activePanel;
  }
  const panel = vscode.window.createWebviewPanel(
    "projectBrain.opencodeWeb",
    "OpenCode Web",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = buildHtml(url);
  panel.onDidDispose(() => {
    activePanel = undefined;
  });
  activePanel = panel;
  log(`[OpenCode] web UI panel opened at ${url}`);
  return panel;
}

/** Build the iframe host page. CSP allows framing the local OpenCode server. */
function buildHtml(url: string): string {
  const frameSrc = "http://127.0.0.1:* http://localhost:*";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src ${frameSrc}; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenCode Web</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    iframe { border: 0; width: 100%; height: 100vh; display: block; }
  </style>
</head>
<body>
  <iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}
