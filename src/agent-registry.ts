/**
 * Agent Registry — Discovers and catalogs available agents.
 *
 * Reads `.agent.md` files from:
 *   1. `static/agents/` (built-in agents bundled with extension)
 *   2. `.project-brain/memory/agents/` (custom user-defined agents)
 *
 * Provides the marketplace catalog for Brain HQ Orchestration tab
 * and the model list from ModelRouter for LLM assignment.
 */

import * as fs from "fs";
import matter from "gray-matter";
import * as path from "path";
import * as vscode from "vscode";
import type { ModelTier } from "./model-router-types";
import { TIER_MAP } from "./model-router-types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Unique slug: "researcher", "qa", "frontend" */
  id: string;
  /** Display name with emoji: "🔍 Researcher" */
  name: string;
  /** Short description */
  description: string;
  /** Where it came from */
  source: "builtin" | "custom";
  /** Full system prompt (body of the .agent.md) */
  systemPrompt: string;
  /** Suggested default tier */
  defaultTier: ModelTier;
  /** Tool names this agent can use */
  tools: string[];
  /** Emoji icon extracted from name */
  icon: string;
}

export interface AvailableModel {
  id: string;
  family: string;
  vendor: string;
  tier: ModelTier;
  maxInputTokens: number;
}

// ─── AgentRegistry ──────────────────────────────────────────────────────────

export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();
  private readonly builtinDir: string;
  private readonly customDir: string;
  private readonly log: (msg: string) => void;

  constructor(
    extensionPath: string,
    memoryPath: string,
    log: (msg: string) => void,
  ) {
    this.builtinDir = path.join(extensionPath, "static", "agents");
    this.customDir = path.join(memoryPath, "agents");
    this.log = log;
  }

  /**
   * Load all agents from builtin + custom directories.
   * Call this once at startup, or when refreshing the catalog.
   */
  async loadAgents(): Promise<void> {
    this.agents.clear();

    // Built-in agents
    await this.loadFromDir(this.builtinDir, "builtin");

    // Custom user agents
    await this.loadFromDir(this.customDir, "custom");

    this.log(
      `[AgentRegistry] Loaded ${this.agents.size} agents (builtin=${this.countBySource("builtin")}, custom=${this.countBySource("custom")})`,
    );
  }

  private async loadFromDir(
    dir: string,
    source: "builtin" | "custom",
  ): Promise<void> {
    try {
      if (!fs.existsSync(dir)) return;

      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".agent.md"));

      for (const file of files) {
        try {
          const filePath = path.join(dir, file);
          const raw = fs.readFileSync(filePath, "utf-8");
          const agent = this.parseAgentFile(raw, file, source);
          if (agent) {
            this.agents.set(agent.id, agent);
          }
        } catch (err) {
          this.log(`[AgentRegistry] Failed to parse ${file}: ${err}`);
        }
      }
    } catch (err) {
      this.log(`[AgentRegistry] Failed to read dir ${dir}: ${err}`);
    }
  }

  /**
   * Parse a `.agent.md` file into an AgentDefinition.
   *
   * Expected format (chatagent frontmatter):
   * ```
   * ```chatagent
   * ---
   * name: 🔍 Researcher
   * description: Research-only agent
   * tools: ["search", "read"]
   * ---
   * System prompt content here...
   * ```
   * ```
   */
  private parseAgentFile(
    raw: string,
    filename: string,
    source: "builtin" | "custom",
  ): AgentDefinition | null {
    // Strip chatagent code fence wrappers if present
    let content = raw;
    // Remove outer markdown code fences that wrap chatagent blocks
    content = content.replace(/^`{3,}chatagent\s*\n/gm, "");
    content = content.replace(/^`{3,}\s*$/gm, "");
    content = content.trim();

    // Now parse with gray-matter
    const parsed = matter(content);
    const data = parsed.data as Record<string, unknown>;
    const body = parsed.content.trim();

    if (!data.name) {
      this.log(`[AgentRegistry] Skipping ${filename}: no name in frontmatter`);
      return null;
    }

    const name = String(data.name);
    // Extract emoji from name (first character if it's an emoji)
    /* eslint-disable no-misleading-character-class */
    const emojiMatch = name.match(
      /^([\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{2764}]+)/u,
    );
    /* eslint-enable no-misleading-character-class */
    const icon = emojiMatch ? emojiMatch[1] : "🤖";

    // Derive ID from filename: "researcher.agent.md" → "researcher"
    const id = filename.replace(/\.agent\.md$/, "").toLowerCase();

    // Parse tools array
    let tools: string[] = [];
    if (Array.isArray(data.tools)) {
      tools = data.tools.map(String);
    }

    // Default tier based on agent role
    const defaultTier = this.inferDefaultTier(id);

    return {
      id,
      name,
      description: String(data.description || ""),
      source,
      systemPrompt: body,
      defaultTier,
      tools,
      icon,
    };
  }

  /**
   * Infer a sensible default tier based on agent role.
   * Research/doc = cheap, QA/review = standard, security/architecture = premium.
   */
  private inferDefaultTier(agentId: string): ModelTier {
    switch (agentId) {
      case "onboard":
      case "documenter":
        return "free";
      case "researcher":
      case "planner":
        return "cheap";
      case "reviewer":
      case "qa":
      case "frontend":
      case "backend":
        return "standard";
      case "security":
        return "premium";
      default:
        return "free";
    }
  }

  private countBySource(source: "builtin" | "custom"): number {
    let n = 0;
    for (const a of this.agents.values()) {
      if (a.source === source) n++;
    }
    return n;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Get all available agents */
  getAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /** Get a specific agent by ID */
  getAgent(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /** Get available LLM models for assignment */
  static async getAvailableModels(): Promise<AvailableModel[]> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({
        id: m.id,
        family: m.family,
        vendor: m.vendor,
        tier: (TIER_MAP[m.family] || "free") as ModelTier,
        maxInputTokens: m.maxInputTokens,
      }));
    } catch {
      return [];
    }
  }

  /** Get number of loaded agents */
  get count(): number {
    return this.agents.size;
  }
}
