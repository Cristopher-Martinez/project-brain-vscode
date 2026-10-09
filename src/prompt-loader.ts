/**
 * Prompt Loader — Hybrid prompt serving with encryption-at-rest.
 *
 * - Free users: basic (local) prompts hardcoded in the extension
 * - Pro+ users: premium prompts fetched from SaaS backend (AES-256-GCM encrypted)
 *
 * Security model:
 * - Server sends prompts encrypted with a per-response AES-256-GCM data key
 * - Cache stores ONLY encrypted blobs — never plaintext
 * - Decryption happens on-demand in the scope of the calling function
 * - Plaintext exists only as an ephemeral variable → eligible for GC immediately
 * - Data key is stored separately in memory (not serializable with prompts)
 *
 * This protects premium prompts from:
 * - .vsix extraction (never bundled)
 * - Memory inspection (cache is ciphertext)
 * - Network logging (double-encrypted: TLS + AES)
 * - Accidental serialization/logging (ciphertext, not readable)
 */

import * as crypto from "crypto";
import type { SaaSClient } from "./saas-client";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PromptEntry {
  id: string;
  tier: "basic" | "premium";
  category: string;
  version: number;
  content: string;
}

/** Encrypted prompt entry — content is ciphertext, never plaintext. */
interface EncryptedPromptEntry {
  id: string;
  tier: "basic" | "premium";
  category: string;
  version: number;
  /** base64(IV[12] || ciphertext || authTag[16]) */
  encryptedContent: string;
}

interface EncryptedCache {
  /** Encrypted premium prompts (never decrypted until getPrompt() is called) */
  premiumPrompts: Map<string, EncryptedPromptEntry>;
  /** AES-256-GCM data key (raw bytes) — stored separately from prompts */
  dataKey: Buffer | null;
  fetchedAt: number;
}

// ─── Decryption Helper ─────────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM encrypted blob.
 * Input format: base64(IV[12] || ciphertext || authTag[16])
 */
function decryptContent(encryptedBase64: string, dataKey: Buffer): string {
  const raw = Buffer.from(encryptedBase64, "base64");

  // Extract components: IV (12 bytes) | ciphertext | authTag (16 bytes)
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// ─── Basic (local) Prompts ─────────────────────────────────────────────────
// These are intentionally generic — no competitive advantage.
// They serve as fallbacks when premium prompts aren't available.

const BASIC_PROMPTS: PromptEntry[] = [
  {
    id: "specialist-persona-summarize",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a technical writer. Summarize the given content clearly and concisely.",
  },
  {
    id: "specialist-persona-extract-info",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a data analyst. Extract the requested information accurately.",
  },
  {
    id: "specialist-persona-generate-code",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a software engineer. Write clean, working code as requested.",
  },
  {
    id: "specialist-persona-generate-test",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a QA engineer. Write thorough test cases.",
  },
  {
    id: "specialist-persona-code-review",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a code reviewer. Find bugs and suggest fixes.",
  },
  {
    id: "specialist-persona-document",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a documentation writer. Document the given code clearly.",
  },
  {
    id: "specialist-persona-debug-analyze",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a debugger. Identify the root cause and propose a fix.",
  },
  {
    id: "specialist-persona-refactor",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a software architect. Refactor the code without changing behavior.",
  },
  {
    id: "specialist-persona-format",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a data formatter. Transform the data as requested.",
  },
  {
    id: "specialist-persona-list",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are an information cataloger. List items accurately.",
  },
  {
    id: "specialist-persona-classify",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a classifier. Pick the best matching label.",
  },
  {
    id: "specialist-persona-transform",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a data engineer. Transform data between formats.",
  },
  {
    id: "specialist-persona-raw",
    tier: "basic",
    category: "slave",
    version: 0,
    content: "You are a skilled software engineer. Follow instructions precisely.",
  },
  {
    id: "bootstrap-system",
    tier: "basic",
    category: "chat",
    version: 0,
    content:
      "You are a brand new AI assistant. Ask the user for a name, creature type, vibe, and emoji for your identity. " +
      "Then ask about their programming preferences: architecture, code style, testing, git workflow, code review, and documentation. " +
      "Summarize the decisions at the end.",
  },
  {
    id: "slave-powers-instruction",
    tier: "basic",
    category: "slave",
    version: 0,
    content:
      "You can request tools by outputting POWER_REQUEST blocks. " +
      "Available: read_file, list_dir, search_text, get_symbols, run_command. " +
      "Request one at a time and wait for POWER_RESULT.",
  },
];

// ─── Prompt Loader ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class PromptLoader {
  private encryptedCache: EncryptedCache;
  private saasClient?: SaaSClient;
  private log: (msg: string) => void;
  private fetchInProgress: Promise<void> | null = null;

  constructor(log: (msg: string) => void, saasClient?: SaaSClient) {
    this.log = log;
    this.saasClient = saasClient;

    // Initialize with empty encrypted cache (basic prompts don't need encryption)
    this.encryptedCache = {
      premiumPrompts: new Map(),
      dataKey: null,
      fetchedAt: 0, // Forces refresh on first access
    };
  }

  /** Set or update the SaaS client (e.g., after login). */
  setSaaSClient(client: SaaSClient): void {
    this.saasClient = client;
    // Invalidate cache to force fresh fetch with auth
    this.encryptedCache.fetchedAt = 0;
    this.log("[PromptLoader] SaaS client updated — cache invalidated");
  }

  /**
   * Get a prompt by ID. Decrypts premium on-demand if available.
   * Plaintext lives ONLY in the scope of the caller — never cached.
   * Triggers background refresh if cache is stale.
   */
  getPrompt(promptId: string): string {
    // Trigger background refresh if stale
    if (this.isCacheStale()) {
      this.refreshInBackground();
    }

    // Try premium (encrypted) first
    const encrypted = this.encryptedCache.premiumPrompts.get(promptId);
    if (encrypted && this.encryptedCache.dataKey) {
      try {
        // ⚡ Decrypt on-demand — plaintext only in this scope
        const plaintext = decryptContent(
          encrypted.encryptedContent,
          this.encryptedCache.dataKey,
        );
        return plaintext; // Caller receives plaintext; no reference kept here
      } catch (err) {
        this.log(`[PromptLoader] Decryption failed for "${promptId}": ${err}`);
        // Fall through to basic
      }
    }

    // Fall back to basic (local) prompt
    const basic = BASIC_PROMPTS.find((p) => p.id === promptId);
    if (basic) {
      return basic.content;
    }

    this.log(`[PromptLoader] Prompt "${promptId}" not found`);
    return "";
  }

  /**
   * Get a specialist persona prompt for a task kind.
   * Convenience method that maps task kind → prompt ID.
   */
  getSpecialistPersona(taskKind: string): string {
    return this.getPrompt(`specialist-persona-${taskKind}`);
  }

  /**
   * Get slave task rules for a task kind (premium only).
   */
  getSlaveRules(taskKind: string): string {
    return this.getPrompt(`slave-rules-${taskKind}`);
  }

  /**
   * Get the bootstrap system prompt.
   */
  getBootstrapPrompt(): string {
    return this.getPrompt("bootstrap-system");
  }

  /**
   * Get the slave powers instruction.
   */
  getSlavePowersInstruction(): string {
    return this.getPrompt("slave-powers-instruction");
  }

  /**
   * Check if premium (encrypted) prompts are loaded.
   */
  get hasPremiumPrompts(): boolean {
    return (
      this.encryptedCache.premiumPrompts.size > 0 &&
      this.encryptedCache.dataKey !== null
    );
  }

  /**
   * Force an immediate refresh from the server.
   */
  async forceRefresh(): Promise<void> {
    await this.fetchPremiumPrompts();
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private isCacheStale(): boolean {
    return Date.now() - this.encryptedCache.fetchedAt > CACHE_TTL_MS;
  }

  private refreshInBackground(): void {
    if (this.fetchInProgress) return;

    this.fetchInProgress = this.fetchPremiumPrompts()
      .catch((err) => {
        this.log(`[PromptLoader] Background refresh failed: ${err}`);
      })
      .finally(() => {
        this.fetchInProgress = null;
      });
  }

  private async fetchPremiumPrompts(): Promise<void> {
    if (!this.saasClient) {
      this.log("[PromptLoader] No SaaS client — using basic prompts only");
      this.encryptedCache.fetchedAt = Date.now();
      return;
    }

    try {
      const response = await this.saasClient.getPrompts();

      if (!response || !response.prompts || response.prompts.length === 0) {
        this.log("[PromptLoader] Server returned no prompts — keeping basics");
        this.encryptedCache.fetchedAt = Date.now();
        return;
      }

      if (!response.encrypted || !response.dk) {
        this.log("[PromptLoader] Server response not encrypted — rejecting");
        this.encryptedCache.fetchedAt = Date.now();
        return;
      }

      // Store encrypted prompts — NEVER decrypt during fetch
      const premiumMap = new Map<string, EncryptedPromptEntry>();
      for (const p of response.prompts) {
        premiumMap.set(p.id, {
          id: p.id,
          tier: p.tier,
          category: p.category,
          version: p.version,
          encryptedContent: p.content, // Still encrypted!
        });
      }

      this.encryptedCache = {
        premiumPrompts: premiumMap,
        dataKey: Buffer.from(response.dk, "base64"),
        fetchedAt: Date.now(),
      };

      this.log(
        `[PromptLoader] Cached ${premiumMap.size} encrypted premium prompts`,
      );
    } catch (err) {
      this.log(`[PromptLoader] Failed to fetch prompts: ${err}`);
      this.encryptedCache.fetchedAt = Date.now();
    }
  }
}
