// ─── Security Utils ──────────────────────────────────────────────────────────
// Centralized injection detection & sanitization for LLM context.
// Extracted from auto-recall.ts (MED-06) for shared use across:
//   - auto-recall.ts (BOOT.md + opinions injection)
//   - identity-types.ts (soul field sanitization: lore, topics, messageExamples)
//
// These patterns protect against prompt injection via user-editable markdown files.

/** Patterns that indicate prompt injection attempts. */
export const INJECTION_PATTERNS: RegExp[] = [
  /^(system|assistant|user)\s*:/gim,
  /\b(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?))/gi,
  /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be)/gi,
  /\b(override|bypass|disable)\s+(security|auth|validation|rules?)/gi,
  /<\/?script\b[^>]*>/gi,
  /\beval\s*\(/gi,
];

/**
 * Sanitize text by replacing detected injection patterns with [FILTERED].
 * Safe to call on any string — returns it unchanged if clean.
 */
export function sanitizeContent(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex since these regexps have 'g' flag
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[FILTERED]");
  }
  return result;
}
