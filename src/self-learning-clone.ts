/**
 * Self-Learning — Git clone helper.
 *
 * Cross-platform clone that avoids leaving partial directories behind by cloning
 * into a temp folder and then swapping it into place.
 *
 * @module self-learning-clone
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { robustRename, robustRm } from "./fs-utils";

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}

function isFilterUnsupported(text: string): boolean {
  const s = text.toLowerCase();
  return s.includes("unknown option") && s.includes("filter");
}

function isLikelyGitOptionError(text: string, option: string): boolean {
  const s = text.toLowerCase();
  return s.includes("unknown option") && s.includes(option.toLowerCase());
}

function isCheckoutFailedAfterClone(text: string): boolean {
  const s = text.toLowerCase();
  return s.includes("clone succeeded") && s.includes("checkout failed");
}

function isTransientGitNetworkError(text: string): boolean {
  const s = text.toLowerCase();
  return (
    s.includes("unexpected disconnect") ||
    s.includes("invalid index-pack output") ||
    s.includes("fetch-pack") ||
    s.includes("connection was reset") ||
    s.includes("could not resolve host") ||
    s.includes("failed to connect") ||
    s.includes("tls")
  );
}

function isMissingBlobOrPromisorError(text: string): boolean {
  const s = text.toLowerCase();
  return (
    s.includes("unable to read sha1 file") ||
    s.includes("promisor") ||
    s.includes("missing blob")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function spawnAndCollect(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  onStderrChunk?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: opts.env,
    });

    let stdout = "";
    let stderr = "";

    // Inactivity timeout: resets on every data chunk.
    // Process only dies if it goes silent for `timeoutMs`.
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `Command timed out (inactivity ${opts.timeoutMs}ms): ${opts.command} ${opts.args.join(" ")}`,
          ),
        );
      }, opts.timeoutMs);
    };
    let timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `Command timed out (inactivity ${opts.timeoutMs}ms): ${opts.command} ${opts.args.join(" ")}`,
        ),
      );
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      resetTimeout();
    });

    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      resetTimeout();
      opts.onStderrChunk?.(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(
        new Error(
          `Command failed (${code}): ${opts.command} ${opts.args.join(" ")}` +
            (stderr.trim() ? `\n${stderr.trim()}` : ""),
        ),
      );
    });
  });
}

function gitEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
  };
}

function gitConfigPrefix(): string[] {
  return ["-c", "core.longpaths=true", "-c", "http.version=HTTP/1.1"];
}

async function gitCloneWithProgress(opts: {
  sourceUrl: string;
  destPath: string;
  argsExtra: string[];
  timeoutMs: number;
  onProgress?: (info: { percent?: number; detail: string }) => void;
  throttleMs?: number;
}): Promise<void> {
  const throttleMs = opts.throttleMs ?? 750;
  let lastEmit = 0;
  let buffered = "";

  const emit = (detail: string, percent?: number) => {
    const now = Date.now();
    if (now - lastEmit < throttleMs) return;
    lastEmit = now;
    opts.onProgress?.({ percent, detail });
  };

  // Emit initial state immediately
  emit("Connecting to remote...");

  const onStderrChunk = (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Match any git phase with percentage
      const m =
        /(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Filtering content):\s*(\d+)%/i.exec(
          trimmed,
        );
      if (m) {
        emit(`${m[1]} ${m[2]}%`, parseInt(m[2], 10));
        continue;
      }

      // Match remote-prefixed lines (remote: Total X, ...)
      if (/^remote:/i.test(trimmed)) {
        emit(trimmed.replace(/^remote:\s*/i, "Remote: "));
        continue;
      }

      // Known informational lines
      if (/Cloning into/i.test(trimmed)) {
        emit(trimmed);
        continue;
      }

      // Fallback: emit any other non-empty line as heartbeat
      if (trimmed.length > 3) emit(trimmed);
    }
  };

  await spawnAndCollect({
    command: "git",
    args: [
      ...gitConfigPrefix(),
      "clone",
      "--progress",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      ...opts.argsExtra,
      opts.sourceUrl,
      opts.destPath,
    ],
    timeoutMs: opts.timeoutMs,
    env: gitEnv(),
    onStderrChunk,
  });
}

async function gitRestoreCheckout(opts: {
  repoPath: string;
  timeoutMs: number;
}): Promise<void> {
  await spawnAndCollect({
    command: "git",
    args: [
      ...gitConfigPrefix(),
      "-C",
      opts.repoPath,
      "restore",
      "--source=HEAD",
      ":/",
    ],
    timeoutMs: opts.timeoutMs,
    env: gitEnv(),
  });
}

async function cloneIntoTemp(opts: {
  sourceUrl: string;
  tempPath: string;
  timeoutMs: number;
  onProgress?: (info: { percent?: number; detail: string }) => void;
  throttleMs?: number;
}): Promise<void> {
  try {
    await gitCloneWithProgress({
      sourceUrl: opts.sourceUrl,
      destPath: opts.tempPath,
      argsExtra: ["--filter=blob:none"],
      timeoutMs: opts.timeoutMs,
      onProgress: opts.onProgress,
      throttleMs: opts.throttleMs,
    });
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (isFilterUnsupported(msg) || isLikelyGitOptionError(msg, "filter")) {
      await robustRm(opts.tempPath).catch(() => undefined);
      await gitCloneWithProgress({
        sourceUrl: opts.sourceUrl,
        destPath: opts.tempPath,
        argsExtra: [],
        timeoutMs: opts.timeoutMs,
        onProgress: opts.onProgress,
        throttleMs: opts.throttleMs,
      });
      return;
    }

    if (isCheckoutFailedAfterClone(msg)) {
      try {
        await gitRestoreCheckout({
          repoPath: opts.tempPath,
          timeoutMs: opts.timeoutMs,
        });
      } catch (restoreErr) {
        const restoreMsg =
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        if (!isMissingBlobOrPromisorError(restoreMsg)) throw restoreErr;

        // If partial clone left us without required blobs, do a full shallow clone.
        await robustRm(opts.tempPath).catch(() => undefined);
        await gitCloneWithProgress({
          sourceUrl: opts.sourceUrl,
          destPath: opts.tempPath,
          argsExtra: [],
          timeoutMs: opts.timeoutMs,
          onProgress: opts.onProgress,
          throttleMs: opts.throttleMs,
        });
      }
      return;
    }

    throw new Error(msg, { cause: err instanceof Error ? err : undefined });
  }
}

async function finalizeSwap(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  const gitDir = path.join(tempPath, ".git");
  if (fs.existsSync(gitDir)) await robustRm(gitDir);
  if (fs.existsSync(targetPath)) await robustRm(targetPath);
  await robustRename(tempPath, targetPath);
}

/**
 * Clone repo into `targetPath`.
 *
 * - Clones into `${targetPath}.tmp-*` and then renames into place.
 * - Removes `.git/` to save disk and to avoid Windows locks later.
 * - Retries transient network failures.
 */
export async function cloneGithubRepoToPath(opts: {
  sourceUrl: string;
  targetPath: string;
  timeoutMs?: number;
  onProgress?: (info: { percent?: number; detail: string }) => void;
  throttleMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const parent = path.dirname(opts.targetPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tempPath = `${opts.targetPath}.tmp-${Date.now()}-${randomSuffix()}`;
    try {
      if (fs.existsSync(tempPath)) await robustRm(tempPath);
      if (attempt > 1) {
        opts.onProgress?.({
          detail: `Retrying clone (${attempt}/${maxAttempts})...`,
        });
      }

      await cloneIntoTemp({
        sourceUrl: opts.sourceUrl,
        tempPath,
        timeoutMs,
        onProgress: opts.onProgress,
        throttleMs: opts.throttleMs,
      });

      await finalizeSwap(tempPath, opts.targetPath);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await robustRm(tempPath).catch(() => undefined);

      if (attempt < maxAttempts && isTransientGitNetworkError(msg)) {
        await sleep(750 * attempt);
        continue;
      }
      throw err;
    }
  }
}
