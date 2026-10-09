/**
 * sanitize.mjs — ESM-pure sanitization for Copilot hooks.
 * Combines:
 *   - security-utils.ts INJECTION_PATTERNS (prompt injection defense)
 *   - auto-capture.ts CAPTURE_BLOCKLIST (dangerous opinion content)
 *   - Unicode normalization (homoglyph attacks)
 *   - agent_id path sanitization
 * Why ESM-pure? Hooks run as child processes (.mjs) and CANNOT import
 * CJS modules from the extension. This is the hook-side security layer.
 */

// ─── Prompt Injection Patterns (from security-utils.ts) ─────────────────────

const INJECTION_PATTERNS = [
  /^(system|assistant|user)\s*:/gim,
  /\b(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?))/gi,
  /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be)/gi,
  /\b(override|bypass|disable)\s+(security|auth|validation|rules?)/gi,
  /<\/?script\b[^>]*>/gi,
  /\beval\s*\(/gi,
];

// ─── Dangerous Content Patterns (from auto-capture.ts CAPTURE_BLOCKLIST) ────

const CONTENT_BLOCKLIST = [
  /\b(exec|spawn|execFile|child_process|require\s*\()\b/i,
  /\b(readFile|writeFile|unlink|rmdir|fs\.\w+)\b/i,
  /\b(process\.env|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/i,
  /\b(system\s*prompt|ignore\s*(previous|all)\s*instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\b/i,
  /https?:\/\/(?!github\.com|localhost)/i,
  /\b(curl|wget|fetch|XMLHttpRequest)\b/i,
  /[A-Za-z0-9+/]{50,}={0,2}/, // suspicious base64
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sanitize text by replacing injection patterns with [FILTERED].
 * Safe for any string — returns unchanged if clean.
 * @param {string} text - Raw text to sanitize
 * @returns {string} Sanitized text
 */
export function sanitizeContent(text) {
  if (!text || typeof text !== "string") return "";
  // Unicode normalization: collapse homoglyphs to ASCII-equivalent
  let result = text.normalize("NFKC");
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[FILTERED]");
  }
  return result;
}

/**
 * Check if content is safe for opinion/learning storage.
 * Returns false if any dangerous pattern matches.
 * @param {string} text - Content to validate
 * @returns {boolean} true if safe
 */
export function isContentSafe(text) {
  if (!text || typeof text !== "string") return false;
  return !CONTENT_BLOCKLIST.some((p) => p.test(text));
}

/**
 * Sanitize agent_id for use in file paths.
 * Allowlist: a-z, A-Z, 0-9, underscore, hyphen. Max 64 chars.
 * Everything else → underscore.
 * @param {string} agentId - Raw agent identifier
 * @returns {string} Safe path component
 */
export function sanitizeAgentId(agentId) {
  if (!agentId || typeof agentId !== "string") return "unknown";
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

/**
 * Sanitize an entire block of text for context injection.
 * Applies: Unicode normalization + injection filtering + length cap.
 * @param {string} text - Raw text
 * @param {number} [maxLen=2000] - Maximum length after sanitization
 * @returns {string} Safe, capped text
 */
export function sanitizeForInjection(text, maxLen = 2000) {
  const sanitized = sanitizeContent(text);
  if (sanitized.length <= maxLen) return sanitized;
  // Cut at last newline before maxLen to avoid mid-line truncation
  const cutIndex = sanitized.lastIndexOf("\n", maxLen);
  return cutIndex > maxLen * 0.5
    ? sanitized.slice(0, cutIndex) + "\n[...truncated]"
    : sanitized.slice(0, maxLen) + "[...truncated]";
}
