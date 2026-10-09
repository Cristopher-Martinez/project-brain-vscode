/**
 * fix-mojibake.mjs — Fixes double-encoded UTF-8 (mojibake) in source files.
 *
 * Problem: Some files had UTF-8 chars (like — → ═ etc.) read as Windows-1252,
 * then re-saved as UTF-8. This creates sequences like â€" instead of —.
 *
 * Solution: Find sequences of chars whose Unicode codepoints match Win-1252
 * byte values, try to decode them as UTF-8. If valid, replace.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// Windows-1252 special mappings (bytes 0x80-0x9F that differ from Latin-1)
const unicodeToWin1252Byte = new Map([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201c, 0x93], // "
  [0x201d, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

/** Map a Unicode codepoint back to its Windows-1252 byte value, or null. */
function cpToByte(cp) {
  if (cp <= 0x7f) return cp; // ASCII
  if (cp >= 0xa0 && cp <= 0xff) return cp; // Latin-1 supplement (same in Win-1252)
  const mapped = unicodeToWin1252Byte.get(cp);
  if (mapped !== undefined) return mapped;
  // C1 control chars (0x80-0x9F) that aren't remapped by Win-1252 (0x81, 0x8D, 0x8F, 0x90, 0x9D)
  // Their Unicode codepoint IS the byte value directly
  if (cp >= 0x80 && cp <= 0x9f) return cp;
  return null;
}

/** Check if a byte is a UTF-8 leading byte (0xC0-0xFD). */
function utf8LeadBytes(b) {
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

/** Check if a byte is a UTF-8 continuation byte (0x80-0xBF). */
function isContinuation(b) {
  return b >= 0x80 && b <= 0xbf;
}

/**
 * Scan text and fix double-encoded UTF-8 sequences.
 * Returns { fixed: string, count: number }.
 */
function fixMojibake(content) {
  let result = "";
  let count = 0;
  let i = 0;

  while (i < content.length) {
    const cp = content.codePointAt(i);
    const charLen = cp > 0xffff ? 2 : 1;
    const b = cpToByte(cp);

    // If this char maps to a byte that could start a multi-byte UTF-8 sequence
    if (b !== null && utf8LeadBytes(b) > 0) {
      const seqLen = utf8LeadBytes(b);
      const bytes = [b];
      let valid = true;
      let charsConsumed = charLen;

      for (let j = 1; j < seqLen; j++) {
        if (i + charsConsumed >= content.length) {
          valid = false;
          break;
        }
        const nextCp = content.codePointAt(i + charsConsumed);
        const nextB = cpToByte(nextCp);
        if (nextB === null || !isContinuation(nextB)) {
          valid = false;
          break;
        }
        bytes.push(nextB);
        charsConsumed += nextCp > 0xffff ? 2 : 1;
      }

      if (valid && bytes.length === seqLen) {
        // Decode bytes as UTF-8
        const buf = Buffer.from(bytes);
        const decoded = buf.toString("utf8");
        // Verify it's a single valid character (not replacement char)
        if (decoded.length >= 1 && !decoded.includes("\ufffd")) {
          result += decoded;
          i += charsConsumed;
          count++;
          continue;
        }
      }
    }

    // No mojibake match — keep original character
    if (cp > 0xffff) {
      result += String.fromCodePoint(cp);
      i += 2;
    } else {
      result += content[i];
      i += 1;
    }
  }

  return { fixed: result, count };
}

// --- Main ---
const root = resolve(import.meta.dirname, "..");
const files = [
  "src/commit-message-builder.ts",
  "src/lm-tools-shared.ts",
  "src/lm-tools.ts",
  "src/lm-tools-registration.ts",
  "src/test-classifier.ts",
  "src/loop-migration.ts",
  // i18n.ts excluded — its â chars are legit French/Portuguese text
  // Webview UI files
  "webview-ui/src/components/loop/FeedbackPanel.tsx",
  "webview-ui/src/components/loop/IterationCard.tsx",
  "webview-ui/src/tabs/LoopTab.tsx",
];

let totalFixes = 0;
for (const rel of files) {
  const abs = resolve(root, rel);
  const content = readFileSync(abs, "utf8");
  const { fixed, count } = fixMojibake(content);
  if (count > 0) {
    writeFileSync(abs, fixed, "utf8");
    console.log(`✅ ${rel}: ${count} sequences fixed`);
    totalFixes += count;
  } else {
    console.log(`⏭️  ${rel}: no mojibake found`);
  }
}

// Also check fix-encoding.mjs (but don't fix itself)
console.log(
  `\nTotal: ${totalFixes} mojibake sequences fixed across ${files.length} files.`,
);
