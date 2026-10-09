/**
 * Prompt Manager — Save, retrieve, list, and delete reusable prompts.
 *
 * Storage: .project-brain/memory/user-prompts.json (versioned with git).
 * Usage via @brain /prompt:
 *   /prompt --save <name> <text>  → Save a prompt
 *   /prompt <name>               → Inject saved prompt
 *   /prompt --list                → List all prompts
 *   /prompt --delete <name>       → Delete a prompt
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SavedPrompt {
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface PromptStore {
  version: 1;
  prompts: SavedPrompt[];
}

// ─── PromptManager ─────────────────────────────────────────────────────────

export class PromptManager {
  private readonly filePath: string;
  private cache: PromptStore | null = null;

  constructor(
    private readonly memoryPath: string,
    private readonly log: (msg: string) => void,
  ) {
    this.filePath = path.join(memoryPath, "user-prompts.json");
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Save or update a prompt by name.
   */
  save(name: string, content: string): SavedPrompt {
    const store = this.load();
    const normalized = this.normalize(name);
    const now = new Date().toISOString();

    const existing = store.prompts.find(
      (p) => this.normalize(p.name) === normalized,
    );

    if (existing) {
      existing.content = content;
      existing.updatedAt = now;
      this.persist(store);
      this.log(`[PromptManager] Updated prompt: "${existing.name}"`);
      return existing;
    }

    const prompt: SavedPrompt = {
      name: normalized,
      content,
      createdAt: now,
      updatedAt: now,
    };
    store.prompts.push(prompt);
    this.persist(store);
    this.log(`[PromptManager] Saved new prompt: "${normalized}"`);
    return prompt;
  }

  /**
   * Get a prompt by name. Returns null if not found.
   */
  get(name: string): SavedPrompt | null {
    const store = this.load();
    const normalized = this.normalize(name);
    return (
      store.prompts.find((p) => this.normalize(p.name) === normalized) ?? null
    );
  }

  /**
   * Delete a prompt by name. Returns true if deleted.
   */
  delete(name: string): boolean {
    const store = this.load();
    const normalized = this.normalize(name);
    const idx = store.prompts.findIndex(
      (p) => this.normalize(p.name) === normalized,
    );
    if (idx === -1) return false;

    store.prompts.splice(idx, 1);
    this.persist(store);
    this.log(`[PromptManager] Deleted prompt: "${normalized}"`);
    return true;
  }

  /**
   * List all saved prompts.
   */
  list(): SavedPrompt[] {
    return this.load().prompts;
  }

  /**
   * Search prompts by partial name match.
   */
  search(query: string): SavedPrompt[] {
    const q = query.toLowerCase();
    return this.load().prompts.filter((p) => p.name.toLowerCase().includes(q));
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private normalize(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/^-+/, "") // strip leading dashes (--moderador → moderador)
      .replace(/\s+/g, "-"); // spaces → hyphens
  }

  private load(): PromptStore {
    if (this.cache) return this.cache;

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.cache = JSON.parse(raw) as PromptStore;
        return this.cache;
      }
    } catch (err) {
      this.log(`[PromptManager] Failed to load prompts: ${err}`);
    }

    this.cache = { version: 1, prompts: [] };
    return this.cache;
  }

  private persist(store: PromptStore): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf-8");
      this.cache = store;
    } catch (err) {
      this.log(`[PromptManager] Failed to persist prompts: ${err}`);
    }
  }
}

// ─── Parser ────────────────────────────────────────────────────────────────

export interface ParsedPromptCommand {
  action: "save" | "get" | "list" | "delete" | "help";
  name?: string;
  content?: string;
}

/**
 * Parse a /prompt command string into a structured action.
 *
 * Examples:
 *   "--save moderador You are a discussion moderator..."
 *     → { action: "save", name: "moderador", content: "You are a discussion moderator..." }
 *   "--moderador" or "moderador"
 *     → { action: "get", name: "moderador" }
 *   "--list"
 *     → { action: "list" }
 *   "--delete moderador"
 *     → { action: "delete", name: "moderador" }
 *   "" (empty)
 *     → { action: "help" }
 */
export function parsePromptCommand(input: string): ParsedPromptCommand {
  const trimmed = input.trim();

  if (!trimmed) {
    return { action: "help" };
  }

  // --list
  if (/^--?list$/i.test(trimmed)) {
    return { action: "list" };
  }

  // --help
  if (/^--?help$/i.test(trimmed)) {
    return { action: "help" };
  }

  // --save <name> <content>
  const saveMatch = trimmed.match(/^--?save\s+(\S+)\s+([\s\S]+)$/i);
  if (saveMatch) {
    return {
      action: "save",
      name: saveMatch[1],
      content: saveMatch[2].trim(),
    };
  }

  // --save <name> (no content — error case, but we'll handle it)
  const saveNoContent = trimmed.match(/^--?save\s+(\S+)\s*$/i);
  if (saveNoContent) {
    return {
      action: "save",
      name: saveNoContent[1],
    };
  }

  // --delete <name>
  const deleteMatch = trimmed.match(/^--?delete\s+(\S+)/i);
  if (deleteMatch) {
    return { action: "delete", name: deleteMatch[1] };
  }

  // --<name> (with dashes) or just <name>
  const getName = trimmed.match(/^--?(\S+)$/);
  if (getName) {
    return { action: "get", name: getName[1] };
  }

  // Bare name (could have spaces — treat first word as name)
  const firstWord = trimmed.split(/\s+/)[0];
  return { action: "get", name: firstWord };
}
