/**
 * Capture Patterns — Regex patterns and safety validation for auto-capture.
 *
 * Extracted from auto-capture.ts to comply with 400-line limit.
 * Contains: patterns, blocklist, rate limit constant, safety check, cleanup.
 */

import type { OpinionDomain } from "./opinion-types";

// ─── Security: Content Validation (HIGH-07) ────────────────────────────────

/** Patterns that indicate potentially dangerous/injected opinions. */
export const CAPTURE_BLOCKLIST: RegExp[] = [
  /\b(exec|spawn|execFile|child_process|require\s*\()\b/i,
  /\b(readFile|writeFile|unlink|rmdir|fs\.\w+)\b/i,
  /\b(process\.env|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/i,
  /\b(system\s*prompt|ignore\s*(previous|all)\s*instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\b/i,
  /https?:\/\/(?!github\.com|localhost)/i,
  /\b(curl|wget|fetch|XMLHttpRequest)\b/i,
  /[A-Za-z0-9+/]{50,}={0,2}/,
];

/** Rate limiting: max captures per hour. */
export const MAX_CAPTURES_PER_HOUR = 15;

/** Check if captured text passes security blocklist. */
export function isCaptureSafe(text: string): boolean {
  return !CAPTURE_BLOCKLIST.some((pattern) => pattern.test(text));
}

// ─── Capture Pattern Definition ─────────────────────────────────────────────

export interface CapturePattern {
  /** Regex to match against text. */
  pattern: RegExp;
  /** Domain to assign the opinion. */
  domain: OpinionDomain;
  /** Initial confidence for captured opinions. */
  confidence: number;
  /** How to extract the statement from the match. */
  extract: (match: RegExpMatchArray, fullText: string) => string | null;
}

/** 12 regex patterns for extracting learnings from conversation text. */
export const CAPTURE_PATTERNS: CapturePattern[] = [
  // Error resolution patterns
  {
    pattern:
      /(?:la solución fue|the fix was|se resolvió con|fixed by|resolved by)\s*[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.75,
    extract: (m) => m[1]?.trim() || null,
  },
  {
    pattern: /(?:error resuelto|bug fixed|issue resolved)[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.7,
    extract: (m) => m[1]?.trim() || null,
  },
  // Root cause analysis
  {
    pattern:
      /(?:el problema era que|the root cause was|caused by|the issue was|el error era)\s*[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.75,
    extract: (m) => `Root cause: ${m[1]?.trim()}` || null,
  },
  // Decision patterns
  {
    pattern:
      /(?:decidimos|we decided|decision made|opted for|elegimos)\s*[:-]?\s*(.{10,200})/i,
    domain: "architecture",
    confidence: 0.8,
    extract: (m) => m[1]?.trim() || null,
  },
  // Architecture recommendations
  {
    pattern:
      /(?:deberíamos usar|we should use|la mejor opción es|the best approach is|conviene usar)\s*[:-]?\s*(.{10,200})/i,
    domain: "architecture",
    confidence: 0.7,
    extract: (m) => m[1]?.trim() || null,
  },
  // Learning patterns
  {
    pattern:
      /(?:aprendí que|learned that|lesson learned|nota importante|key insight)\s*[:-]?\s*(.{10,200})/i,
    domain: "general",
    confidence: 0.7,
    extract: (m) => m[1]?.trim() || null,
  },
  // Pattern discovery
  {
    pattern:
      /(?:funciona mejor si|works better when|el truco es|the trick is|best practice)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.65,
    extract: (m) => m[1]?.trim() || null,
  },
  // Anti-patterns / warnings
  {
    pattern:
      /(?:cuidado con|watch out for|esto causa problemas|this causes issues|ojo con|beware of)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.7,
    extract: (m) => `Warning: ${m[1]?.trim()}` || null,
  },
  // Tool/workflow preferences
  {
    pattern:
      /(?:usar siempre|always use|nunca usar|never use|preferir|prefer)\s+(.{5,150})/i,
    domain: "tools",
    confidence: 0.7,
    extract: (m) => m[1]?.trim() || null,
  },
  // Convention / habit patterns
  {
    pattern:
      /(?:siempre que|every time|cada vez que|whenever you|each time)\s+(.{10,200})/i,
    domain: "workflow",
    confidence: 0.6,
    extract: (m) => m[1]?.trim() || null,
  },
  // Performance insights
  {
    pattern:
      /(?:más rápido si|faster when|performance tip|optimizar con|optimize with|mejora el rendimiento)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.65,
    extract: (m) => `Perf: ${m[1]?.trim()}` || null,
  },
  // Explicit "remember this" patterns
  {
    pattern:
      /(?:recuerda que|remember that|no olvidar|don't forget)\s*[:-]?\s*(.{10,200})/i,
    domain: "general",
    confidence: 0.85,
    extract: (m) => m[1]?.trim() || null,
  },
];

// ─── Statement Cleanup ─────────────────────────────────────────────────────

/** Clean raw captured text into a valid opinion statement. */
export function cleanStatement(raw: string): string | null {
  let s = raw.trim();

  s = s.replace(/[.;,]+$/, "").trim();
  s = s.replace(/^(que|that|porque|because|ya que|since)\s+/i, "").trim();
  s = s
    .replace(/^\|+\s*/, "")
    .replace(/\s*\|+$/, "")
    .trim();
  s = s
    .replace(/^\*+\s*/, "")
    .replace(/\s*\*+$/, "")
    .trim();

  if (/^[|`*#>-]/.test(s) || /[|]$/.test(s)) return null;
  if (/^`[^`]+`$/.test(s)) return null;
  if (s.length < 15 || s.length > 200) return null;

  const wordCount = s.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount < 3) return null;

  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}
