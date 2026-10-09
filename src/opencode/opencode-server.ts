/**
 * opencode-server — Spawns and supervises a headless `opencode serve` process.
 *
 * Decoupled from the Copilot loop engine. Uses child_process directly (no SDK
 * at runtime) so it works from the CJS extension host. Binary resolution order:
 *   1. explicit binaryPath
 *   2. node_modules/.bin/opencode(.cmd)
 *   3. `opencode` on PATH
 *   4. `npx --yes opencode-ai@latest` fallback
 */

import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { existsSync } from "fs";
import { join } from "path";
import { log, logWarn } from "../logger";
import {
  OpenCodeUnavailableError,
  type OpenCodeServerHandle,
  type OpenCodeSpawnOptions,
} from "./opencode-types";

const LISTEN_MARKER = "opencode server listening";
const isWin = process.platform === "win32";

/** Find a free TCP port by binding to 0 and reading the assigned port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

/** Resolve which executable to run for `opencode`. Exported for reuse (e.g. attach). */
export function resolveOpenCodeCommand(cwd: string, binaryPath?: string): ResolvedCommand {
  if (binaryPath && existsSync(binaryPath)) {
    return { command: binaryPath, prefixArgs: [] };
  }
  const binName = isWin ? "opencode.cmd" : "opencode";
  const localBin = join(cwd, "node_modules", ".bin", binName);
  if (existsSync(localBin)) {
    return { command: localBin, prefixArgs: [] };
  }
  // npx fallback: works without a global/local install, just slower on cold start.
  const npx = isWin ? "npx.cmd" : "npx";
  return { command: npx, prefixArgs: ["--yes", "opencode-ai@latest"] };
}

/** Parse the base URL out of the "listening" log line. */
function parseListenUrl(line: string, port: number, hostname: string): string {
  const match = line.match(/https?:\/\/[^\s]+/);
  if (match) {
    return match[0].replace(/\/+$/, "");
  }
  return `http://${hostname}:${port}`;
}

/**
 * Spawn an OpenCode server and resolve once it is listening.
 * The returned handle exposes the base URL and a close() to kill the process.
 */
export async function spawnOpenCodeServer(
  opts: OpenCodeSpawnOptions,
): Promise<OpenCodeServerHandle> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? (await getFreePort());
  const timeoutMs = opts.startupTimeoutMs ?? 60000;
  const mode = opts.mode ?? "serve";
  const { command, prefixArgs } = resolveOpenCodeCommand(opts.cwd, opts.binaryPath);
  const args = [...prefixArgs, mode, "--port", String(port), "--hostname", hostname];

  log(`[OpenCode] spawning: ${command} ${args.join(" ")}`);

  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    windowsHide: true,
    // On Windows, .cmd shims (npx.cmd, opencode.cmd) throw EINVAL with
    // shell:false on Node 20+. shell:true routes through cmd.exe. Our args
    // contain no spaces/special chars, so this is safe.
    shell: isWin,
  });

  return new Promise<OpenCodeServerHandle>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      kill(child);
      reject(new OpenCodeUnavailableError(`OpenCode server did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    const onLine = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        opts.onLog?.(line);
        // "serve" prints the listen marker; "web" may only print the URL line.
        const ready = line.includes(LISTEN_MARKER) || line.includes(`:${port}`);
        if (!settled && ready) {
          settled = true;
          clearTimeout(timer);
          const url = parseListenUrl(line, port, hostname);
          log(`[OpenCode] server ready at ${url}`);
          resolve({
            url,
            port,
            close: () => kill(child),
          });
        }
      }
    };

    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new OpenCodeUnavailableError(`Failed to launch OpenCode: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new OpenCodeUnavailableError(`OpenCode exited early (code ${code})`));
    });
  });
}

/** Kill a child process, tolerating already-dead processes. */
function kill(child: ChildProcess): void {
  try {
    if (isWin && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch (err) {
    logWarn(`[OpenCode] kill failed: ${(err as Error).message}`);
  }
}
