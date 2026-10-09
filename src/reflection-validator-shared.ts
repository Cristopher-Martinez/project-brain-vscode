/**
 * Shared constants, types, and HTTP helpers for ReflectionValidator.
 *
 * Extracted to keep reflection-validator.ts under the 400-line limit.
 * Contains zero-cost heuristic data and HTTP primitives.
 */

import * as http from "http";
import * as https from "https";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result from any validation mode */
export interface ValidationResult {
  isGenuine: boolean;
  score: number;
}

/** API response shape from the BERT VPS endpoint */
export interface ApiValidateResponse {
  genuine_score: number;
  is_genuine: boolean;
  latency_ms: number;
}

// ─── Heuristic classifier data (zero-cost, zero-credits) ────────────────────

/** Keywords that signal genuine insight (EN + ES) */
export const GENUINE_KEYWORDS = [
  // English
  "learned",
  "realized",
  "discovered",
  "decided",
  "because",
  "important",
  "lesson",
  "insight",
  "pattern",
  "mistake",
  "better",
  "worse",
  "avoid",
  "prefer",
  "never",
  "always",
  "should",
  "strategy",
  "approach",
  "tradeoff",
  "root cause",
  "turned out",
  "key takeaway",
  "works because",
  "fails when",
  // Spanish
  "aprendí",
  "descubrí",
  "entendí",
  "decidí",
  "porque",
  "importante",
  "lección",
  "patrón",
  "error",
  "mejor",
  "peor",
  "evitar",
  "preferir",
  "nunca",
  "siempre",
  "debería",
  "estrategia",
  "enfoque",
  "resulta que",
  "clave",
  "causa raíz",
  "funciona porque",
  "falla cuando",
];

/** Patterns that signal mechanical/autopilot text */
export const MECHANICAL_PATTERNS = [
  /^(ok|done|yes|no|sure|sí|listo|hecho|vale|bien|next|siguiente)\b/i,
  /^(updated|fixed|added|removed|changed|created|deleted)\b\.?$/i,
  /^(actualizado|corregido|agregado|eliminado|cambiado|creado)\b\.?$/i,
  /^\d+\s*(files?|archivos?)\s*(changed|modified|cambiados)/i,
  /^(commit|merge|push|pull|deploy|build)\s*(done|complete|ok|listo)/i,
];

/** Classification prompt for VS Code LM API (opt-in only) */
export const LM_CLASSIFY_PROMPT = `You are a binary classifier. Your ONLY job is to determine if a text is a "genuine" reflection (insightful, contains a lesson learned, architectural decision, or debugging insight) or "mechanical" (autopilot text like "done", "ok", "updated", status reports with no insight).

Respond with ONLY a JSON object, nothing else:
{"score": <float 0-1>, "label": "genuine" | "mechanical"}

Examples:
- "Aprendí que validar inputs temprano evita bugs downstream" → {"score": 0.92, "label": "genuine"}
- "ok done next" → {"score": 0.05, "label": "mechanical"}
- "La estrategia fail-open asegura que el sistema no se rompa" → {"score": 0.88, "label": "genuine"}
- "Updated. Listo." → {"score": 0.08, "label": "mechanical"}

Classify this text:`;

// ─── HTTP helpers (zero-dep) ────────────────────────────────────────────────

export function httpGet(url: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      { headers: { "X-API-Key": apiKey }, timeout: 5000 },
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
  });
}

export function httpPost(
  url: string,
  body: string,
  apiKey: string,
): Promise<string> {
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
