import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log, logError, logWarn } from "./logger";

const ORCHESTRATOR_PORT = 3101;

/**
 * OrchestratorSpawner — auto-starts the agent-orchestrator MCP server
 * when the extension activates, and kills it on deactivation.
 *
 * Priority order for locating the server:
 *   1. Bundled inside the extension: dist/agent-orchestrator/index.mjs
 *   2. External dev install:         ~/mcp-servers/agent-orchestrator/dist/index.js
 */
export class OrchestratorSpawner implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private disposed = false;

  constructor(private readonly extensionPath: string) {}

  async start(): Promise<void> {
    if (this.child || this.disposed) {
      return;
    }

    // Check if something is already listening on the port
    const alreadyUp = await isPortInUse(ORCHESTRATOR_PORT);
    if (alreadyUp) {
      log(
        `[OrchestratorSpawner] Port ${ORCHESTRATOR_PORT} already in use — skipping spawn`,
      );
      return;
    }

    const serverPath = this.resolveServerPath();
    if (!serverPath) {
      logWarn(
        "[OrchestratorSpawner] agent-orchestrator not found — orchestration tools unavailable",
      );
      return;
    }

    log(
      `[OrchestratorSpawner] Starting agent-orchestrator (daemon) from: ${serverPath}`,
    );

    // Log file para diagnóstico — si el daemon crashea, al menos hay rastro
    const logFile = path.join(os.tmpdir(), "project-brain-orchestrator.log");
    const logFd = fs.openSync(logFile, "a");

    // detached + unref → daemon: sobrevive al cierre de VS Code y es compartido
    // entre múltiples ventanas. El puerto 3101 es fijo (mcp.json lo requiere).
    this.child = spawn("node", [serverPath], {
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PORT: String(ORCHESTRATOR_PORT) },
      detached: true,
    });

    this.child.unref(); // VS Code puede cerrar sin matar el proceso
    fs.closeSync(logFd); // El child hereda el fd, podemos cerrar nuestra copia

    this.child.on("error", (err) => {
      logError("[OrchestratorSpawner] Failed to start", err);
      this.child = undefined;
    });

    // Health-check: verificar que el daemon realmente arrancó
    await this.waitForPort(ORCHESTRATOR_PORT, 5000);
    log(`[OrchestratorSpawner] Daemon log: ${logFile}`);
  }

  dispose(): void {
    this.disposed = true;
    // Kill the daemon on dispose. Previously we left it running ("daemon
    // compartido"), but detached + never-killed processes accumulated as
    // orphans on port 3101 (EADDRINUSE churn) and starved the system into
    // hard locks. Clean shutdown is safer than a leaked background process.
    const child = this.child;
    this.child = undefined;
    if (child?.pid) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else {
          child.kill("SIGTERM");
        }
        log(`[OrchestratorSpawner] Daemon killed on dispose (PID ${child.pid})`);
      } catch (err) {
        logWarn(`[OrchestratorSpawner] kill on dispose failed: ${(err as Error).message}`);
      }
    }
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const interval = 300;
    while (Date.now() - start < timeoutMs) {
      if (await isPortInUse(port)) {
        log(`[OrchestratorSpawner] Port ${port} is live — daemon ready`);
        return;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    logWarn(
      `[OrchestratorSpawner] Port ${port} not ready after ${timeoutMs}ms — daemon may have failed (check log)`,
    );
  }

  private resolveServerPath(): string | undefined {
    // 1) Bundled inside the extension
    const bundled = path.join(
      this.extensionPath,
      "dist",
      "agent-orchestrator",
      "index.mjs",
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    // 2) External dev install (~\mcp-servers\agent-orchestrator\dist\index.js)
    const homeDir = process.env.USERPROFILE || process.env.HOME || "";
    if (homeDir) {
      const external = path.join(
        homeDir,
        "mcp-servers",
        "agent-orchestrator",
        "dist",
        "index.js",
      );
      if (fs.existsSync(external)) {
        return external;
      }
    }

    return undefined;
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: "127.0.0.1" });
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", () => resolve(false));
    // Safety timeout — don't hang forever if host is unresponsive
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}
