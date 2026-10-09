// ─── Brain HQ — MCP Gateway Message Handlers ─────────────────────────────────
// Extracted from brain-hq-message-handler.ts to stay within 400-line limit.

import * as vscode from "vscode";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { log, logError, logWarn } from "./logger";

/**
 * Handle gateway-related webview messages.
 * Returns true if the message was handled, false otherwise.
 */
export async function handleGatewayMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "toggleGateway": {
      log(`[BrainHQ:Gateway] Toggle gateway requested`);
      try {
        await vscode.commands.executeCommand("projectBrain.gateway.toggle");
        await new Promise((r) => setTimeout(r, 300));
        const gwState = await buildGatewayState(instance);
        instance.panel.webview.postMessage({
          type: "gatewayState",
          data: gwState,
        });
      } catch (err) {
        logError(`[BrainHQ:Gateway] Toggle failed: ${err}`);
      }
      return true;
    }

    case "requestGatewayState":
    case "requestGatewayTokens": {
      try {
        const gws = await buildGatewayState(instance);
        instance.panel.webview.postMessage({ type: "gatewayState", data: gws });
      } catch (err) {
        logError(`[BrainHQ:Gateway] Failed to build gateway state: ${err}`);
      }
      return true;
    }

    case "createGatewayToken": {
      if (!instance.gateway) {
        logWarn(
          "[BrainHQ:Gateway] Cannot create token — gateway not initialized",
        );
        return true;
      }
      const label = (msg.label as string) || "default";
      const scopes = (msg.scopes as string[]) || ["read"];
      try {
        log(
          `[BrainHQ:Gateway] Creating token "${label}" with scopes: ${scopes.join(",")}`,
        );
        const newToken = await instance.gateway.generateToken(
          label,
          scopes as any,
        );
        instance.panel.webview.postMessage({
          type: "gatewayTokenCreated",
          token: newToken,
          label,
        });
        const stateAfterCreate = await buildGatewayState(instance);
        instance.panel.webview.postMessage({
          type: "gatewayState",
          data: stateAfterCreate,
        });
      } catch (err) {
        logError(
          `[BrainHQ:Gateway] Token creation failed for "${label}": ${err}`,
        );
      }
      return true;
    }

    case "revokeGatewayToken": {
      if (!instance.gateway) {
        logWarn(
          "[BrainHQ:Gateway] Cannot revoke token — gateway not initialized",
        );
        return true;
      }
      const revokeLabel = msg.label as string;
      if (revokeLabel) {
        try {
          log(`[BrainHQ:Gateway] Revoking token "${revokeLabel}"`);
          await instance.gateway.revokeToken(revokeLabel);
          const stateAfterRevoke = await buildGatewayState(instance);
          instance.panel.webview.postMessage({
            type: "gatewayState",
            data: stateAfterRevoke,
          });
        } catch (err) {
          logError(
            `[BrainHQ:Gateway] Token revoke failed for "${revokeLabel}": ${err}`,
          );
        }
      }
      return true;
    }

    case "requestGatewayLog": {
      log(`[BrainHQ:Gateway] Request log requested`);
      const gwLog = instance.gateway?.getRequestLog() ?? [];
      instance.panel.webview.postMessage({
        type: "gatewayRequestLog",
        data: gwLog,
      });
      return true;
    }

    case "copyConnectionSnippet": {
      const tokenLabel = msg.tokenLabel as string;
      const language = msg.language as "curl" | "node" | "python";
      const port = instance.gateway?.getPort() ?? 3200;
      log(
        `[BrainHQ:Gateway] Copying ${language} snippet for token "${tokenLabel}"`,
      );
      const snippet = generateSnippet(language, tokenLabel, port);
      await vscode.env.clipboard.writeText(snippet);
      void vscode.window.showInformationMessage(
        `Connection snippet (${language}) copied to clipboard!`,
      );
      return true;
    }

    default:
      return false;
  }
}

// ─── Gateway State Builder ────────────────────────────────────────────────────

async function buildGatewayState(instance: BrainHqInstance) {
  const gw = instance.gateway;
  const tokens = gw ? await gw.listTokens() : [];
  const requestLog = gw?.getRequestLog() ?? [];
  return {
    running: gw?.isRunning() ?? false,
    port: gw?.getPort() ?? 3200,
    tokens: tokens.map((t) => ({
      label: t.label,
      scopes: t.scopes,
      createdAt: t.createdAt,
      lastUsed: t.lastUsed ?? null,
      expiresAt: t.expiresAt ?? null,
    })),
    sessions: gw?.getSessionCount() ?? 0,
    requestLog,
  };
}

// ─── Connection Snippet Generator ─────────────────────────────────────────────

function generateSnippet(
  language: "curl" | "node" | "python",
  tokenLabel: string,
  port: number,
): string {
  const url = `http://127.0.0.1:${port}`;
  const placeholder = `<paste-${tokenLabel}-token-here>`;

  if (language === "curl") {
    return [
      `# Initialize MCP session`,
      `curl -X POST ${url}/ \\`,
      `  -H "Authorization: Bearer ${placeholder}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{`,
      `    "protocolVersion":"2024-11-05","capabilities":{},`,
      `    "clientInfo":{"name":"my-client","version":"1.0"}}}'`,
    ].join("\n");
  }

  if (language === "node") {
    return [
      `import { Client } from "@modelcontextprotocol/sdk/client/index.js";`,
      `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";`,
      ``,
      `const transport = new StreamableHTTPClientTransport(`,
      `  new URL("${url}"),`,
      `  { requestInit: { headers: { Authorization: "Bearer ${placeholder}" } } },`,
      `);`,
      `const client = new Client({ name: "my-client", version: "1.0" }, { capabilities: {} });`,
      `await client.connect(transport);`,
      ``,
      `// Example: search memory`,
      `const result = await client.callTool({`,
      `  name: "search_memory",`,
      `  arguments: { query: "your query here" },`,
      `});`,
      `console.log(result.content[0].text);`,
    ].join("\n");
  }

  // python
  return [
    `import requests`,
    ``,
    `TOKEN = "${placeholder}"`,
    `URL = "${url}"`,
    `HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}`,
    ``,
    `# Initialize session`,
    `resp = requests.post(URL, headers=HEADERS, json={`,
    `    "jsonrpc": "2.0", "id": 1, "method": "initialize",`,
    `    "params": {"protocolVersion": "2024-11-05", "capabilities": {},`,
    `              "clientInfo": {"name": "python-client", "version": "1.0"}}`,
    `})`,
    `HEADERS["mcp-session-id"] = resp.headers.get("mcp-session-id")`,
    ``,
    `# Search memory`,
    `resp = requests.post(URL, headers=HEADERS, json={`,
    `    "jsonrpc": "2.0", "id": 2, "method": "tools/call",`,
    `    "params": {"name": "search_memory", "arguments": {"query": "your query"}}`,
    `})`,
    `print(resp.json())`,
  ].join("\n");
}
