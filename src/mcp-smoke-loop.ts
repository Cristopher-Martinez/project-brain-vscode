import { EventEmitter } from "events";

export interface McpSmokeLoopUpdate {
  attempt: number;
  consecutiveOk: number;
  lastError?: string;
  toolsCount?: number;
  running: boolean;
  done: boolean;
  pass?: boolean;
}

export class McpSmokeLoop extends EventEmitter {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly requiredConsecutive: number;
  private readonly delayMs: number;
  private readonly timeoutMs: number;

  private abortController: AbortController | undefined;
  private runningPromise: Promise<void> | undefined;

  private state: McpSmokeLoopUpdate = {
    attempt: 0,
    consecutiveOk: 0,
    running: false,
    done: false,
    pass: undefined,
  };

  constructor(opts?: {
    baseUrl?: string;
    maxAttempts?: number;
    requiredConsecutive?: number;
    delayMs?: number;
    timeoutMs?: number;
  }) {
    super();
    this.baseUrl = opts?.baseUrl ?? "http://localhost:3101";
    this.maxAttempts = opts?.maxAttempts ?? 10;
    this.requiredConsecutive = opts?.requiredConsecutive ?? 3;
    this.delayMs = opts?.delayMs ?? 1000;
    this.timeoutMs = opts?.timeoutMs ?? 5000;
  }

  public getState(): McpSmokeLoopUpdate {
    return { ...this.state };
  }

  public start(): void {
    if (this.runningPromise) return;

    this.abortController = new AbortController();
    this.state = {
      attempt: 0,
      consecutiveOk: 0,
      lastError: undefined,
      toolsCount: undefined,
      running: true,
      done: false,
      pass: undefined,
    };
    this.emitUpdate();

    this.runningPromise = this.runLoop(this.abortController.signal).finally(
      () => {
        this.runningPromise = undefined;
        this.abortController = undefined;
      },
    );
  }

  public stop(): void {
    this.abortController?.abort();
  }

  public dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private emitUpdate(): void {
    this.emit("update", this.getState());
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal.aborted) {
        this.state = {
          ...this.state,
          running: false,
          done: true,
          pass: false,
          lastError: this.state.lastError || "Stopped",
        };
        this.emitUpdate();
        return;
      }

      this.state = {
        ...this.state,
        attempt,
        running: true,
        done: false,
        pass: undefined,
      };
      this.emitUpdate();

      try {
        const toolsCount = await this.runAttempt(signal);
        this.state = {
          ...this.state,
          consecutiveOk: this.state.consecutiveOk + 1,
          lastError: undefined,
          toolsCount,
        };
        this.emitUpdate();

        if (this.state.consecutiveOk >= this.requiredConsecutive) {
          this.state = {
            ...this.state,
            running: false,
            done: true,
            pass: true,
          };
          this.emitUpdate();
          return;
        }
      } catch (err) {
        lastError = toErrString(err);
        this.state = {
          ...this.state,
          consecutiveOk: 0,
          lastError,
        };
        this.emitUpdate();
      }

      if (attempt < this.maxAttempts) {
        await sleep(this.delayMs, signal);
      }
    }

    this.state = {
      ...this.state,
      running: false,
      done: true,
      pass: false,
      lastError: lastError ?? this.state.lastError ?? "Max attempts reached",
    };
    this.emitUpdate();
  }

  private async runAttempt(signal: AbortSignal): Promise<number | undefined> {
    // 1) GET /health
    await this.fetchOk(`${this.baseUrl}/health`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    });

    // 2) POST / with JSON-RPC initialize (MCP Streamable HTTP protocol)
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "brain-hq-smoke", version: "1.0" },
      },
    });
    const initRes = await fetchWithTimeout(
      `${this.baseUrl}/`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: initBody,
        signal,
      },
      this.timeoutMs,
    );

    if (!initRes.ok) {
      safeCancelBody(initRes);
      throw new Error(`initialize HTTP ${initRes.status}`);
    }

    const sessionId = initRes.headers.get("mcp-session-id") || undefined;
    safeCancelBody(initRes);

    if (!sessionId) {
      throw new Error("initialize missing mcp-session-id header");
    }

    // 3) POST / with JSON-RPC tools/list (MCP Streamable HTTP protocol)
    const toolsBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const toolsRes = await fetchWithTimeout(
      `${this.baseUrl}/`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: toolsBody,
        signal,
      },
      this.timeoutMs,
    );

    if (!toolsRes.ok) {
      safeCancelBody(toolsRes);
      throw new Error(`tools/list HTTP ${toolsRes.status}`);
    }

    let toolsCount: number | undefined;
    try {
      const contentType = toolsRes.headers.get("content-type") ?? "";
      let data: unknown;
      if (contentType.includes("text/event-stream")) {
        data = await parseSseJsonPayload(toolsRes);
      } else {
        data = await toolsRes.json();
      }
      toolsCount = inferToolsCount(data);
    } finally {
      safeCancelBody(toolsRes);
    }

    // 4) DELETE / (close session if supported)
    try {
      const closeRes = await fetchWithTimeout(
        `${this.baseUrl}/`,
        {
          method: "DELETE",
          headers: {
            "mcp-session-id": sessionId,
          },
          signal,
        },
        this.timeoutMs,
      );
      safeCancelBody(closeRes);
    } catch {
      // ignore — some servers may not implement explicit close
    }

    return toolsCount;
  }

  private async fetchOk(url: string, init: RequestInit): Promise<void> {
    const res = await fetchWithTimeout(url, init, this.timeoutMs);
    if (!res.ok) {
      safeCancelBody(res);
      throw new Error(`${new URL(url).pathname} HTTP ${res.status}`);
    }
    safeCancelBody(res);
  }
}

async function parseSseJsonPayload(res: Response): Promise<unknown> {
  const text = await res.text();
  // SSE format: lines of "data: {...}" — find the line with actual JSON-RPC payload
  // Some servers emit metadata events before the real data, so we scan ALL data lines
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr) {
        dataLines.push(jsonStr);
      }
    }
  }
  // Prefer the last data line (most likely the actual response, not SSE metadata)
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(dataLines[i]) as unknown;
      // JSON-RPC responses have "jsonrpc" or "result" fields
      if (
        parsed &&
        typeof parsed === "object" &&
        ("jsonrpc" in parsed || "result" in parsed)
      ) {
        return parsed;
      }
    } catch {
      /* not valid JSON, skip */
    }
  }
  // Fallback: return first parseable data line
  for (const jsonStr of dataLines) {
    try {
      return JSON.parse(jsonStr) as unknown;
    } catch {
      /* skip */
    }
  }
  throw new Error("SSE response contained no data payload");
}

function toErrString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function safeCancelBody(res: Response): void {
  try {
    res.body?.cancel();
  } catch {
    /* ignore */
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }).catch(() => {
    /* ignore */
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  const mergedSignal = mergeSignals(init.signal, ctrl.signal);
  try {
    const res = await fetch(url, { ...init, signal: mergedSignal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function mergeSignals(
  a: AbortSignal | null | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

function inferToolsCount(data: unknown): number | undefined {
  if (!data) return undefined;

  if (Array.isArray(data)) return data.length;

  if (typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;

  const tools = obj["tools"];
  if (Array.isArray(tools)) return tools.length;

  const result = obj["result"];
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const rTools = r["tools"];
    if (Array.isArray(rTools)) return rTools.length;
  }

  const innerData = obj["data"];
  if (innerData && typeof innerData === "object") {
    const d = innerData as Record<string, unknown>;
    const dTools = d["tools"];
    if (Array.isArray(dTools)) return dTools.length;
  }

  return undefined;
}
