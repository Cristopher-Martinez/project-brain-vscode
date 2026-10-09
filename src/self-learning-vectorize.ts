/**
 * Self-Learning Vectorize — Streaming vectorization via CLI.
 *
 * Runs the RAG CLI (`cli.mjs vectorize`) as a child process with
 * streaming progress parsing (chunk-level and file-level).
 *
 * Extracted from SelfLearningManager to keep files under 400 lines.
 *
 * @module self-learning-vectorize
 */

import { spawn } from "child_process";
import type { LocalEmbeddingConfig, VectorizationResult } from "./self-learning-types";
import { slProgress } from "./self-learning-state";

type PostMessageFn = (msg: Record<string, unknown>) => void;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RunVectorizeOpts {
  repoId: number;
  repoName: string;
  projectPath: string;
  config: LocalEmbeddingConfig;
  signal: AbortSignal;
  cliPath: string;
  postMessage: PostMessageFn | null;
}

/**
 * Run vectorization for a repo via the RAG CLI.
 *
 * Sets up embedding env vars, progress callbacks,
 * and delegates to the streaming runner.
 */
export async function runVectorize(opts: RunVectorizeOpts): Promise<VectorizationResult> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EMBEDDING_PROVIDER: "openai",
    OPENAI_BASE_URL: opts.config.baseUrl,
    OPENAI_MODEL: opts.config.model,
    OPENAI_API_KEY: opts.config.apiKey,
  };

  const emitProgress = (detail: string, percent?: number) => {
    slProgress({ repoId: opts.repoId, name: opts.repoName, phase: "vectorizing", detail, percent });
    if (!opts.postMessage) return;
    try {
      opts.postMessage({
        type: "sl:progress",
        repoId: opts.repoId,
        phase: "vectorizing",
        detail,
        percent,
      });
    } catch {
      /* webview may be disposed */
    }
  };

  return runVectorizeStreaming(
    opts.cliPath,
    opts.projectPath,
    env,
    opts.signal,
    emitProgress,
  );
}

// ─── Streaming Runner ────────────────────────────────────────────────────────

async function runVectorizeStreaming(
  cliPath: string,
  projectPath: string,
  env: Record<string, string>,
  signal: AbortSignal,
  onProgress: (detail: string, percent?: number) => void,
): Promise<VectorizationResult> {
  const args = [cliPath, "vectorize", projectPath, "--force", "--scan-all"];

  return new Promise<VectorizationResult>((resolve, reject) => {
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });

    let stdoutAll = "";
    let buffered = "";
    let lastEmit = 0;
    let totalFiles: number | null = null;
    let processedFiles = 0;

    const emitThrottled = (detail: string, percent?: number) => {
      const now = Date.now();
      if (now - lastEmit < 750) return;
      lastEmit = now;
      onProgress(detail, percent);
    };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Strong signal: OpenAI embedding provider prints
      // "Progress: X/Y chunks" (with carriage returns)
      const mChunks = /Progress:\s*(\d+)\/(\d+)\s*chunks/i.exec(trimmed);
      if (mChunks) {
        const done = parseInt(mChunks[1], 10);
        const total = parseInt(mChunks[2], 10);
        if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
          const percent = Math.round((done / total) * 100);
          emitThrottled(`Embedding chunks ${done}/${total}`, percent);
        }
        return;
      }

      // Fallback: per-file processing.
      const mTotal = /Found\s+(\d+)\s+files\s+to\s+update/i.exec(trimmed);
      if (mTotal) {
        totalFiles = parseInt(mTotal[1], 10);
        emitThrottled(`Preparing ${totalFiles} files`, 0);
        return;
      }

      if (/Processing:\s+/i.test(trimmed)) {
        processedFiles++;
        if (totalFiles && totalFiles > 0) {
          const percent = Math.round((processedFiles / totalFiles) * 100);
          emitThrottled(`Processing files ${processedFiles}/${totalFiles}`, percent);
        } else {
          emitThrottled(`Processing files ${processedFiles}`);
        }
        return;
      }
    };

    const onStdoutChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutAll += text;

      // Handle both \n and carriage-return progress.
      buffered += text.replace(/\r/g, "\n");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const l of lines) processLine(l);
    };

    child.stdout?.on("data", onStdoutChunk);
    let stderrAll = "";
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderrAll += text;
      stdoutAll += `\n${text}`;
    });

    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("Vectorization cancelled"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("Vectorization timed out"));
    }, 900_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (code !== 0) {
        const detail = stderrAll.trim().slice(-500);
        return reject(
          new Error(`Vectorize failed (${code ?? "?"}): ${detail || "no stderr"}`),
        );
      }

      // Ensure we process any remaining buffered line
      if (buffered.trim()) processLine(buffered);
      resolve(parseVectorizeOutput(stdoutAll));
    });
  });
}

// ─── Output Parser ───────────────────────────────────────────────────────────

/** Parse the CLI's stdout to extract chunk/file counts. */
export function parseVectorizeOutput(stdout: string): VectorizationResult {
  const chunksMatch = /Chunks:\s*(\d+)/i.exec(stdout);
  const filesMatch = /Files:\s*(\d+)/i.exec(stdout);

  return {
    chunks: chunksMatch ? parseInt(chunksMatch[1], 10) : 0,
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    success: /indexed successfully/i.test(stdout),
  };
}
