/**
 * Reflection quality gate — portable (zero vscode deps).
 *
 * Classifies captured text as "genuine" (insightful) vs "mechanical"
 * (autopilot). Migrated from the extension's reflection-validator so the
 * quality gate works from ANY MCP client (Codex, Cursor, OpenCode…).
 *
 * Modes (priority order):
 *   1. HTTP API  — remote BERT endpoint (if reflectionApiUrl reachable)
 *   2. Heuristic — local keyword/pattern classifier (zero cost)
 *   3. Fail-open — passes when API errors
 *
 * The VS Code LanguageModel fallback is intentionally NOT migrated (it is
 * Copilot-specific). Local-first is preserved: heuristic always works offline.
 */

import * as http from "http";
import * as https from "https";

export interface ValidationResult {
  isGenuine: boolean;
  score: number;
  mode: "api" | "heuristic" | "fail-open";
  signals?: string[];
}

interface ApiValidateResponse {
  genuine_score: number;
  is_genuine: boolean;
  latency_ms: number;
}

export interface ValidateOptions {
  threshold?: number;
  apiUrl?: string;
  apiKey?: string;
}

/** Keywords that signal genuine insight (EN + ES). */
const GENUINE_KEYWORDS = [
  "learned", "realized", "discovered", "decided", "because", "important",
  "lesson", "insight", "pattern", "mistake", "better", "worse", "avoid",
  "prefer", "never", "always", "should", "strategy", "approach", "tradeoff",
  "root cause", "turned out", "key takeaway", "works because", "fails when",
  "aprendí", "descubrí", "entendí", "decidí", "porque", "importante",
  "lección", "patrón", "error", "mejor", "peor", "evitar", "preferir",
  "nunca", "siempre", "debería", "estrategia", "enfoque", "resulta que",
  "clave", "causa raíz", "funciona porque", "falla cuando",
];

/** Patterns that signal mechanical/autopilot text. */
const MECHANICAL_PATTERNS = [
  /^(ok|done|yes|no|sure|sí|listo|hecho|vale|bien|next|siguiente)\b/i,
  /^(updated|fixed|added|removed|changed|created|deleted)\b\.?$/i,
  /^(actualizado|corregido|agregado|eliminado|cambiado|creado)\b\.?$/i,
  /^\d+\s*(files?|archivos?)\s*(changed|modified|cambiados)/i,
  /^(commit|merge|push|pull|deploy|build)\s*(done|complete|ok|listo)/i,
];

const DEFAULT_THRESHOLD = 0.85;

function httpPost(url: string, body: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

/** Zero-cost local classifier. Mirrors the extension heuristic exactly. */
function validateViaHeuristic(text: string, threshold: number): ValidationResult {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const signals: string[] = [];

  if (words.length < 5) return { isGenuine: false, score: 0.1, mode: "heuristic", signals: ["too_short"] };

  if (MECHANICAL_PATTERNS.some((p) => p.test(text.trim()))) {
    return { isGenuine: false, score: 0.1, mode: "heuristic", signals: ["mechanical_pattern"] };
  }

  let insightHits = 0;
  for (const kw of GENUINE_KEYWORDS) {
    if (lower.includes(kw)) {
      insightHits++;
      signals.push(`keyword:${kw}`);
    }
  }

  let score = 0.5;
  score += Math.min(insightHits * 0.15, 0.4);
  if (insightHits > 0) signals.push("has_insight_keywords");
  if (words.length > 12) {
    score += 0.1;
    signals.push("sufficient_length");
  }
  score = Math.max(0, Math.min(1, score));

  return { isGenuine: score >= threshold, score, mode: "heuristic", signals };
}

async function validateViaApi(
  text: string,
  threshold: number,
  apiUrl: string,
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const body = JSON.stringify({ text, threshold });
    const res = await httpPost(`${apiUrl}/validate`, body, apiKey);
    const data: ApiValidateResponse = JSON.parse(res);
    return { isGenuine: data.is_genuine, score: data.genuine_score, mode: "api" };
  } catch {
    return { isGenuine: true, score: 1.0, mode: "fail-open" };
  }
}

/**
 * Validate a captured text. Tries the remote BERT API if configured/reachable,
 * else falls back to the local heuristic. Never throws — fail-open by design.
 */
export async function validateCapture(
  text: string,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const apiUrl = opts.apiUrl?.trim();
  const apiKey = opts.apiKey?.trim() || "pb-reflection-2026";

  if (apiUrl) {
    const apiResult = await validateViaApi(text, threshold, apiUrl, apiKey);
    if (apiResult.mode === "api") return apiResult;
    // API failed → fall through to heuristic
  }

  return validateViaHeuristic(text, threshold);
}
