/**
 * Capture Patterns (MJS) — Ported from src/capture-patterns.ts for hooks.
 * 12 regex patterns for extracting learnings from agent text in agent mode.
 * These patterns match phrases that indicate the agent has learned something,
 * made a decision, or discovered a root cause.
 * Used by: capture-buffer.mjs (processBuffer → scanForCaptures)
 */

// ─── Security Blocklist ─────────────────────────────────────────────────────

/** Patterns that indicate potentially dangerous/injected content. */
export const CAPTURE_BLOCKLIST = [
  /\b(exec|spawn|execFile|child_process|require\s*\()\b/i,
  /\b(readFile|writeFile|unlink|rmdir|fs\.\w+)\b/i,
  /\b(process\.env|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/i,
  /\b(system\s*prompt|ignore\s*(previous|all)\s*instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\b/i,
  /https?:\/\/(?!github\.com|localhost)/i,
  /\b(curl|wget|fetch|XMLHttpRequest)\b/i,
  /[A-Za-z0-9+/]{50,}={0,2}/, // base64 blobs
];

/** Check if captured text passes the security blocklist. */
export function isCaptureSafe(text) {
  return !CAPTURE_BLOCKLIST.some((pattern) => pattern.test(text));
}

// ─── 12 Capture Patterns ────────────────────────────────────────────────────

/**
 * Each pattern has:
 * - regex: the pattern to match
 * - domain: category for the learning
 * - confidence: initial confidence score
 * - prefix: optional prefix to prepend to extracted text
 */
export const CAPTURE_PATTERNS = [
  // 1-2: Error resolution
  {
    regex:
      /(?:la solución fue|the fix was|se resolvió con|fixed by|resolved by)\s*[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.75,
    prefix: "",
  },
  {
    regex: /(?:error resuelto|bug fixed|issue resolved)[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.7,
    prefix: "",
  },
  // 3: Root cause
  {
    regex:
      /(?:el problema era que|the root cause was|caused by|the issue was|el error era)\s*[:-]?\s*(.{10,200})/i,
    domain: "debugging",
    confidence: 0.75,
    prefix: "Root cause: ",
  },
  // 4: Decisions
  {
    regex:
      /(?:decidimos|we decided|decision made|opted for|elegimos)\s*[:-]?\s*(.{10,200})/i,
    domain: "architecture",
    confidence: 0.8,
    prefix: "",
  },
  // 5: Architecture recommendations
  {
    regex:
      /(?:deberíamos usar|we should use|la mejor opción es|the best approach is|conviene usar)\s*[:-]?\s*(.{10,200})/i,
    domain: "architecture",
    confidence: 0.7,
    prefix: "",
  },
  // 6: Learnings
  {
    regex:
      /(?:aprendí que|learned that|lesson learned|nota importante|key insight)\s*[:-]?\s*(.{10,200})/i,
    domain: "general",
    confidence: 0.7,
    prefix: "",
  },
  // 7: Pattern discovery
  {
    regex:
      /(?:funciona mejor si|works better when|el truco es|the trick is|best practice)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.65,
    prefix: "",
  },
  // 8: Anti-patterns
  {
    regex:
      /(?:cuidado con|watch out for|esto causa problemas|this causes issues|ojo con|beware of)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.7,
    prefix: "Warning: ",
  },
  // 9: Tool preferences
  {
    regex:
      /(?:usar siempre|always use|nunca usar|never use|preferir|prefer)\s+(.{5,150})/i,
    domain: "tools",
    confidence: 0.7,
    prefix: "",
  },
  // 10: Conventions
  {
    regex:
      /(?:siempre que|every time|cada vez que|whenever you|each time)\s+(.{10,200})/i,
    domain: "workflow",
    confidence: 0.6,
    prefix: "",
  },
  // 11: Performance
  {
    regex:
      /(?:más rápido si|faster when|performance tip|optimizar con|optimize with|mejora el rendimiento)\s*[:-]?\s*(.{10,200})/i,
    domain: "patterns",
    confidence: 0.65,
    prefix: "Perf: ",
  },
  // 12: Explicit "remember this"
  {
    regex:
      /(?:recuerda que|remember that|no olvidar|don't forget)\s*[:-]?\s*(.{10,200})/i,
    domain: "general",
    confidence: 0.85,
    prefix: "",
  },
];

// ─── Statement Cleanup ──────────────────────────────────────────────────────

/** Clean raw captured text into a valid learning statement. */
export function cleanStatement(raw) {
  let s = (raw || "").trim();

  // Remove trailing punctuation
  s = s.replace(/[.;,]+$/, "").trim();
  // Remove leading connectors
  s = s.replace(/^(que|that|porque|because|ya que|since)\s+/i, "").trim();
  // Remove markdown artifacts
  s = s
    .replace(/^\|+\s*/, "")
    .replace(/\s*\|+$/, "")
    .trim();
  s = s
    .replace(/^\*+\s*/, "")
    .replace(/\s*\*+$/, "")
    .trim();

  // Reject if still has markdown artifacts
  if (/^[|`*#>\-]/.test(s) || /[|]$/.test(s)) return null;
  if (/^`[^`]+`$/.test(s)) return null;

  // Length and word count validation
  if (s.length < 15 || s.length > 200) return null;
  const wordCount = s.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount < 3) return null;

  // Capitalize first letter
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

/**
 * Scan text for matching capture patterns.
 * Returns array of { statement, domain, confidence }.
 */
export function scanForCaptures(text) {
  if (!text || text.length < 20) return [];

  const captures = [];
  for (const pattern of CAPTURE_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.regex, "gi"));
    for (const match of matches) {
      const raw = match[1];
      if (!raw) continue;

      const cleaned = cleanStatement(raw);
      if (!cleaned) continue;
      if (!isCaptureSafe(cleaned)) continue;

      const statement = pattern.prefix
        ? `${pattern.prefix}${cleaned}`
        : cleaned;

      // Deduplicate within this scan
      if (captures.some((c) => c.statement === statement)) continue;

      captures.push({
        statement,
        domain: pattern.domain,
        confidence: pattern.confidence,
      });
    }
  }

  return captures;
}
