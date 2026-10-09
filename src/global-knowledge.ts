/**
 * Global Knowledge — Cross-project knowledge inheritance.
 *
 * Manages the promotion and import of opinions, learnings, and
 * troubleshooting entries across projects via globalStorageUri.
 *
 * Design: knowledge flows UP (promote high-confidence opinions to global)
 * and DOWN (import global knowledge into new projects).
 */

import * as fs from "fs";
import * as path from "path";
import type { Opinion } from "./opinion-bank";
import type { GlobalConfigProvider } from "./global-config-provider";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GlobalKnowledgeEntry {
  id: string;
  content: string;
  source: string; // project name or path hash
  category: "opinion" | "learning" | "troubleshooting";
  createdAt: string;
  confidence?: number; // for opinions
}

export interface GlobalKnowledgeStore {
  entries: GlobalKnowledgeEntry[];
  updatedAt: string;
}

export interface KnowledgeInheritanceResult {
  imported: number;
  skipped: number;
  categories: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const KNOWLEDGE_FILE = "global-knowledge.json";
const MIN_CONFIDENCE_FOR_PROMOTION = 0.7;
const MAX_GLOBAL_ENTRIES = 500;

// ─── GlobalKnowledgeManager ─────────────────────────────────────────────────

export class GlobalKnowledgeManager {
  private store: GlobalKnowledgeStore | null = null;
  private knowledgePath: string;

  constructor(
    private globalConfig: GlobalConfigProvider,
    private log: (msg: string) => void,
  ) {
    const knowledgeDir = this.globalConfig.getKnowledgePath();
    this.knowledgePath = path.join(knowledgeDir, KNOWLEDGE_FILE);
  }

  // ─── Load / Save ────────────────────────────────────────────────

  private load(): GlobalKnowledgeStore {
    if (this.store) return this.store;
    try {
      if (fs.existsSync(this.knowledgePath)) {
        const raw = fs.readFileSync(this.knowledgePath, "utf-8");
        this.store = JSON.parse(raw) as GlobalKnowledgeStore;
      }
    } catch (err) {
      this.log(`[GlobalKnowledge] Failed to load: ${err}`);
    }
    if (!this.store) {
      this.store = { entries: [], updatedAt: new Date().toISOString() };
    }
    return this.store;
  }

  private save(): void {
    if (!this.store) return;
    try {
      const dir = path.dirname(this.knowledgePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.store.updatedAt = new Date().toISOString();
      fs.writeFileSync(
        this.knowledgePath,
        JSON.stringify(this.store, null, 2),
        "utf-8",
      );
    } catch (err) {
      this.log(`[GlobalKnowledge] Failed to save: ${err}`);
    }
  }

  // ─── Promote (project → global) ────────────────────────────────

  /**
   * Promote high-confidence opinions from a project's OpinionBank
   * to the global knowledge store.
   */
  promoteOpinions(
    opinions: Opinion[],
    projectSource: string,
  ): number {
    const store = this.load();
    let promoted = 0;

    for (const op of opinions) {
      if (op.confidence < MIN_CONFIDENCE_FOR_PROMOTION) continue;
      // Skip if already exists with same statement
      const exists = store.entries.some(
        (e) =>
          e.category === "opinion" &&
          e.content === op.statement,
      );
      if (exists) continue;

      store.entries.push({
        id: `op-${op.id}`,
        content: op.statement,
        source: projectSource,
        category: "opinion",
        confidence: op.confidence,
        createdAt: new Date().toISOString(),
      });
      promoted++;
    }

    if (promoted > 0) {
      this.enforceLimit(store);
      this.save();
      this.log(
        `[GlobalKnowledge] Promoted ${promoted} opinions from ${projectSource}`,
      );
    }
    return promoted;
  }

  /**
   * Add a learning entry to global knowledge.
   */
  addLearning(content: string, projectSource: string): void {
    const store = this.load();
    const exists = store.entries.some(
      (e) => e.category === "learning" && e.content === content,
    );
    if (exists) return;

    store.entries.push({
      id: `learn-${Date.now()}`,
      content,
      source: projectSource,
      category: "learning",
      createdAt: new Date().toISOString(),
    });
    this.enforceLimit(store);
    this.save();
    this.log(`[GlobalKnowledge] Added learning from ${projectSource}`);
  }

  /**
   * Add a troubleshooting entry to global knowledge.
   */
  addTroubleshooting(content: string, projectSource: string): void {
    const store = this.load();
    const exists = store.entries.some(
      (e) => e.category === "troubleshooting" && e.content === content,
    );
    if (exists) return;

    store.entries.push({
      id: `ts-${Date.now()}`,
      content,
      source: projectSource,
      category: "troubleshooting",
      createdAt: new Date().toISOString(),
    });
    this.enforceLimit(store);
    this.save();
    this.log(
      `[GlobalKnowledge] Added troubleshooting from ${projectSource}`,
    );
  }

  // ─── Import (global → project) ─────────────────────────────────

  /**
   * Get all global entries suitable for injection into a new project.
   * Filters by category and optional minimum confidence.
   */
  getInheritableEntries(
    categories?: Array<"opinion" | "learning" | "troubleshooting">,
    minConfidence = 0.5,
  ): GlobalKnowledgeEntry[] {
    const store = this.load();
    return store.entries.filter((e) => {
      if (categories && !categories.includes(e.category)) return false;
      if (e.category === "opinion" && (e.confidence ?? 0) < minConfidence) {
        return false;
      }
      return true;
    });
  }

  /**
   * Import global opinions into a local OpinionBank's markdown format.
   * Returns the opinions as Opinion objects ready for merge.
   */
  getGlobalOpinionsForImport(
    minConfidence = 0.6,
  ): Opinion[] {
    const entries = this.getInheritableEntries(["opinion"], minConfidence);
    return entries.map((e) => ({
      id: e.id.replace("op-", "global-"),
      statement: `[Global] ${e.content}`,
      confidence: Math.min((e.confidence ?? 0.7) * 0.9, 0.85), // Slightly reduce on import
      domain: "general" as const,
      evidence: {
        supporting: [`Inherited from ${e.source}`],
        contradicting: [],
      },
      createdAt: e.createdAt,
      lastUpdated: new Date().toISOString(),
    }));
  }

  // ─── Query ──────────────────────────────────────────────────────

  /**
   * Search global knowledge by keyword.
   */
  search(query: string, limit = 10): GlobalKnowledgeEntry[] {
    const store = this.load();
    const q = query.toLowerCase();
    return store.entries
      .filter((e) => e.content.toLowerCase().includes(q))
      .slice(0, limit);
  }

  /**
   * Get stats about global knowledge.
   */
  getStats(): {
    total: number;
    byCategory: Record<string, number>;
    sources: string[];
  } {
    const store = this.load();
    const byCategory: Record<string, number> = {};
    const sources = new Set<string>();

    for (const e of store.entries) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      sources.add(e.source);
    }

    return {
      total: store.entries.length,
      byCategory,
      sources: [...sources],
    };
  }

  // ─── Bootstrap Import (global → local project) ──────────────────

  /**
   * Inject global knowledge entries into a newly initialized project's memory files.
   * Appends learnings to 04_LEARNINGS.md and troubleshooting to 05_TROUBLESHOOTING.md.
   * Returns count of entries injected.
   */
  injectIntoProject(memoryPath: string, projectName: string): number {
    const entries = this.getInheritableEntries(
      ["learning", "troubleshooting"],
      0.5,
    );
    if (entries.length === 0) return 0;

    let injected = 0;
    const learnings = entries.filter((e) => e.category === "learning");
    const troubleshooting = entries.filter(
      (e) => e.category === "troubleshooting",
    );

    if (learnings.length > 0) {
      injected += this.appendToMemoryFile(
        path.join(memoryPath, "04_LEARNINGS.md"),
        learnings,
        "Global Learnings (inherited)",
      );
    }

    if (troubleshooting.length > 0) {
      injected += this.appendToMemoryFile(
        path.join(memoryPath, "05_TROUBLESHOOTING.md"),
        troubleshooting,
        "Global Troubleshooting (inherited)",
      );
    }

    if (injected > 0) {
      this.log(
        `[GlobalKnowledge] Injected ${injected} entries into ${projectName}`,
      );
    }
    return injected;
  }

  /**
   * Append entries as a markdown section to a memory file.
   */
  private appendToMemoryFile(
    filePath: string,
    entries: GlobalKnowledgeEntry[],
    sectionTitle: string,
  ): number {
    try {
      // Dedup: skip if section already exists (prevents duplicate injection on re-init)
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, "utf-8");
        if (existing.includes(`## ${sectionTitle}`)) {
          this.log(`[GlobalKnowledge] Section "${sectionTitle}" already exists, skipping`);
          return 0;
        }
      }

      const section = [
        "",
        `## ${sectionTitle}`,
        "",
        ...entries.map(
          (e) =>
            `- ${e.content} _(from: ${e.source}, ${e.createdAt.split("T")[0]})_`,
        ),
        "",
      ].join("\n");

      if (fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, section, "utf-8");
      } else {
        fs.writeFileSync(filePath, `# ${sectionTitle}\n${section}`, "utf-8");
      }
      return entries.length;
    } catch (err) {
      this.log(`[GlobalKnowledge] Failed to write ${filePath}: ${err}`);
      return 0;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private enforceLimit(store: GlobalKnowledgeStore): void {
    if (store.entries.length <= MAX_GLOBAL_ENTRIES) return;
    // Sort: lowest confidence first, then oldest
    store.entries.sort((a, b) => {
      const confA = a.confidence ?? 0.5;
      const confB = b.confidence ?? 0.5;
      if (confA !== confB) return confA - confB;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const removed = store.entries.length - MAX_GLOBAL_ENTRIES;
    store.entries = store.entries.slice(removed);
    this.log(`[GlobalKnowledge] Pruned ${removed} entries (limit: ${MAX_GLOBAL_ENTRIES})`);
  }
}
