/**
 * Vault Manager — Secure credential + instruction storage for AI agents.
 *
 * The vault file (`.project-brain/vault/project.brain.vault.env`) is a
 * "supercharged" env file: each entry can have an optional instruction
 * block that teaches agents HOW to use the credential, not just the value.
 *
 * Format:
 * ```
 * ## [LABEL]
 * # Instructions: Free-form text explaining how/when to use this secret.
 * KEY=value
 * ```
 *
 * The vault file is auto-added to .gitignore to prevent accidental commits.
 *
 * @module VaultManager
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError, logWarn } from "./logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VaultEntry {
  /** Unique identifier / label for this credential group */
  label: string;
  /** Free-form instructions for agents on how to use these credentials */
  instructions: string;
  /** Key-value pairs (the actual secrets) */
  secrets: Record<string, string>;
}

export interface VaultData {
  entries: VaultEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VAULT_DIR = "vault";
const VAULT_FILE = "project.brain.vault.env";
const VAULT_RELATIVE = `.project-brain/${VAULT_DIR}/${VAULT_FILE}`;

// ─── Paths ──────────────────────────────────────────────────────────────────

function getVaultDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".project-brain", VAULT_DIR);
}

function getVaultPath(workspaceRoot: string): string {
  return path.join(getVaultDir(workspaceRoot), VAULT_FILE);
}

// ─── Gitignore Protection ───────────────────────────────────────────────────

/** Ensure the vault file is in .gitignore so it's never committed. */
export function ensureVaultGitignored(workspaceRoot: string): void {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const vaultPattern = VAULT_RELATIVE;

  try {
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
    }

    // Check if already present
    const lines = content.split(/\r?\n/);
    const alreadyIgnored = lines.some(
      (line) =>
        line.trim() === vaultPattern ||
        line.trim() === `/${vaultPattern}` ||
        line.trim() === "*.vault.env",
    );

    if (!alreadyIgnored) {
      const suffix = content.endsWith("\n") ? "" : "\n";
      const addition = `${suffix}\n# Project Brain Vault (NEVER commit secrets)\n${vaultPattern}\n`;
      fs.writeFileSync(gitignorePath, content + addition, "utf-8");
      log(`[Vault] Added ${vaultPattern} to .gitignore`);
    }
  } catch (err) {
    logWarn(`[Vault] Could not update .gitignore: ${err}`);
  }
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/** Parse the vault.env file into structured VaultEntry array. */
export function parseVaultFile(content: string): VaultEntry[] {
  const entries: VaultEntry[] = [];
  const lines = content.split(/\r?\n/);

  let current: VaultEntry | null = null;
  let instructionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // New entry header: ## [LABEL]
    const headerMatch = trimmed.match(/^##\s+\[(.+)\]\s*$/);
    if (headerMatch) {
      // Flush previous entry
      if (current) {
        current.instructions = instructionLines.join("\n").trim();
        entries.push(current);
      }
      current = { label: headerMatch[1], instructions: "", secrets: {} };
      instructionLines = [];
      continue;
    }

    if (!current) continue;

    // Instruction line: # Instructions: ...  or continuation # ...
    const instrMatch = trimmed.match(/^#\s*Instructions?:\s*(.*)$/i);
    if (instrMatch) {
      instructionLines.push(instrMatch[1]);
      continue;
    }

    // Continuation instruction line (starts with # but not a header)
    if (trimmed.startsWith("#") && !trimmed.startsWith("##")) {
      const commentContent = trimmed.replace(/^#\s?/, "");
      // Only add to instructions if we've already started collecting them
      if (instructionLines.length > 0) {
        instructionLines.push(commentContent);
      }
      continue;
    }

    // Key=Value line
    const kvMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_./-]*)=(.*)$/);
    if (kvMatch) {
      let value = kvMatch[2];
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Unescape sequences (written by serializer)
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
      current.secrets[kvMatch[1]] = value;
    }
  }

  // Flush last entry
  if (current) {
    current.instructions = instructionLines.join("\n").trim();
    entries.push(current);
  }

  return entries;
}

// ─── Serializer ─────────────────────────────────────────────────────────────

/** Serialize VaultEntry array back to vault.env format. */
export function serializeVaultEntries(entries: VaultEntry[]): string {
  const blocks: string[] = [];

  for (const entry of entries) {
    const lines: string[] = [];
    lines.push(`## [${entry.label}]`);

    if (entry.instructions.trim()) {
      lines.push(`# Instructions: ${entry.instructions.split("\n")[0]}`);
      for (const extra of entry.instructions.split("\n").slice(1)) {
        lines.push(`# ${extra}`);
      }
    }

    for (const [key, value] of Object.entries(entry.secrets)) {
      // Escape newlines so multi-line values stay on one line
      const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
      // Quote values that contain spaces, special chars, or escape sequences
      const needsQuote = /[\s#=\\]/.test(escaped);
      lines.push(`${key}=${needsQuote ? `"${escaped}"` : escaped}`);
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n") + "\n";
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** Read all vault entries from the workspace. */
export function readVault(workspaceRoot: string): VaultEntry[] {
  const vaultPath = getVaultPath(workspaceRoot);
  if (!fs.existsSync(vaultPath)) return [];

  try {
    const content = fs.readFileSync(vaultPath, "utf-8");
    return parseVaultFile(content);
  } catch (err) {
    logError(`[Vault] Failed to read vault: ${err}`);
    return [];
  }
}

/** Write all vault entries to disk. */
export function writeVault(
  workspaceRoot: string,
  entries: VaultEntry[],
): void {
  const vaultDir = getVaultDir(workspaceRoot);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const vaultPath = getVaultPath(workspaceRoot);
  const content = serializeVaultEntries(entries);
  fs.writeFileSync(vaultPath, content, "utf-8");

  // Verify write was successful by reading back
  const verification = fs.readFileSync(vaultPath, "utf-8");
  if (verification !== content) {
    logError(`[Vault] Write verification FAILED — content mismatch at ${vaultPath}`);
  }

  log(`[Vault] Written ${entries.length} entries to ${vaultPath}`);
}

/** Add or update a vault entry by label. */
export function upsertVaultEntry(
  workspaceRoot: string,
  entry: VaultEntry,
): void {
  const entries = readVault(workspaceRoot);
  const idx = entries.findIndex(
    (e) => e.label.toLowerCase() === entry.label.toLowerCase(),
  );

  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  writeVault(workspaceRoot, entries);
  ensureVaultGitignored(workspaceRoot);
}

/** Remove a vault entry by label. */
export function removeVaultEntry(
  workspaceRoot: string,
  label: string,
): boolean {
  const entries = readVault(workspaceRoot);
  const idx = entries.findIndex(
    (e) => e.label.toLowerCase() === label.toLowerCase(),
  );

  if (idx < 0) return false;

  entries.splice(idx, 1);
  writeVault(workspaceRoot, entries);
  return true;
}

/** Check if vault exists in a workspace. */
export function hasVault(workspaceRoot: string): boolean {
  return fs.existsSync(getVaultPath(workspaceRoot));
}

/** Initialize vault with a starter template. */
export function initVault(workspaceRoot: string): void {
  const vaultPath = getVaultPath(workspaceRoot);
  if (fs.existsSync(vaultPath)) return;

  const vaultDir = getVaultDir(workspaceRoot);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const template = `# ╔════════════════════════════════════════════════════════════╗
# ║  PROJECT BRAIN VAULT — Secure Credential Storage         ║
# ║                                                          ║
# ║  ⚠️  This file is auto-added to .gitignore.              ║
# ║  ⚠️  NEVER commit this file to version control.          ║
# ║                                                          ║
# ║  Format:                                                 ║
# ║    ## [Label]                                             ║
# ║    # Instructions: How/when agents should use this        ║
# ║    KEY=value                                              ║
# ╚════════════════════════════════════════════════════════════╝

## [Example — Production Server]
# Instructions: Use these credentials to SSH into the production server.
# Only use when deploying or debugging production issues.
# SSH_HOST=example.com
# SSH_USER=deploy
# SSH_KEY_PATH=~/.ssh/id_ed25519

`;

  fs.writeFileSync(vaultPath, template, "utf-8");
  ensureVaultGitignored(workspaceRoot);
  log("[Vault] Initialized with starter template");
}

// ─── Agent Context Generation ───────────────────────────────────────────────

/**
 * Generate a context string for injection into agent prompts.
 * Shows labels, instructions, and KEY NAMES (not values) so agents
 * know what's available without leaking secrets into the prompt.
 *
 * When an agent needs the actual value, it should call the vault
 * tool to retrieve it at runtime.
 */
export function generateVaultContext(workspaceRoot: string): string {
  const entries = readVault(workspaceRoot);
  if (entries.length === 0) return "";

  const lines: string[] = [
    "## 🔐 Vault — Available Credentials",
    "",
    "The project has a secure vault at `.project-brain/vault/project.brain.vault.env`.",
    "Use `readVaultEntry` tool to retrieve actual values at runtime.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`### ${entry.label}`);
    if (entry.instructions) {
      lines.push(`**How to use**: ${entry.instructions}`);
    }
    const keys = Object.keys(entry.secrets);
    if (keys.length > 0) {
      lines.push(`**Available keys**: ${keys.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate the full vault content for direct injection (when the agent
 * needs actual values, e.g., during automated deployments).
 *
 * ⚠️ Use sparingly — this includes real secrets.
 */
export function generateVaultFullContext(workspaceRoot: string): string {
  const entries = readVault(workspaceRoot);
  if (entries.length === 0) return "";

  const lines: string[] = [
    "## 🔐 Vault — Credentials (CONFIDENTIAL)",
    "",
  ];

  for (const entry of entries) {
    lines.push(`### ${entry.label}`);
    if (entry.instructions) {
      lines.push(`**Instructions**: ${entry.instructions}`);
    }
    for (const [key, value] of Object.entries(entry.secrets)) {
      lines.push(`- \`${key}\` = \`${value}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}
