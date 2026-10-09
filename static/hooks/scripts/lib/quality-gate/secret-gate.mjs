// quality-gate/secret-gate.mjs
// Portable gate: block credential/secret exposure in written file content.
//
// Extracted (R1 parity) from the VS Code PreToolUse hook
// (`.github/hooks/scripts/pre-tool-security.mjs`, section "6. INTENT
// CLASSIFICATION GATE — Secret exposure detection"). This pattern list is the
// single source of truth — both facades must consume THIS array.
//
// Unlike the destructive gate (which inspects COMMANDS), this gate inspects
// CONTENT being written to files. Pure function. No I/O, no env, no shell.

import { allow, deny } from "./types.mjs";

export const GATE_ID = "secret-exposure";

/**
 * High-confidence secret patterns. Kept tight on purpose to avoid false
 * positives — every entry is a credential prefix/shape that is unambiguous.
 * @type {{ re: RegExp, label: string }[]}
 */
export const SECRET_PATTERNS = [
  { re: /ghp_[a-zA-Z0-9]{36,}/, label: "GitHub PAT" },
  { re: /github_pat_[a-zA-Z0-9_]{79,}/, label: "GitHub fine-grained PAT" },
  { re: /sk-[a-zA-Z0-9]{48,}/, label: "OpenAI API key" },
  { re: /sk-proj-[a-zA-Z0-9_-]{80,}/, label: "OpenAI project key" },
  { re: /CLOUDFLARE_API_TOKEN=[a-zA-Z0-9_-]{35,}/, label: "Cloudflare token" },
  { re: /PrivateKey\s*=\s*[a-zA-Z0-9+/=]{44}/, label: "WireGuard private key" },
];

/**
 * Paths to skip — test files, specs and fixtures routinely carry fake secrets.
 * Mirrors the hook's skip rule exactly for parity.
 */
const SKIP_PATH = /(__tests__|\.test\.|\.spec\.|fixtures?|examples?)/i;

/**
 * Evaluate file content against the secret-exposure catalog.
 *
 * @param {string} content - The content about to be written.
 * @param {string} [filePath] - Destination path (used to skip test/fixtures).
 * @returns {import("./types.mjs").GateVerdict}
 */
export function checkSecretExposure(content, filePath = "") {
  const text = typeof content === "string" ? content : "";
  const path = typeof filePath === "string" ? filePath : "";
  if (path && SKIP_PATH.test(path)) {
    return allow(GATE_ID, "Skipped (test/fixture path).");
  }
  if (!text) return allow(GATE_ID, "No content to inspect.");
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(text)) {
      return deny(
        GATE_ID,
        `Secret exposure detected: ${label}. Rotate the credential and remove it from code.`,
        label,
      );
    }
  }
  return allow(GATE_ID, "No secret pattern matched.");
}
