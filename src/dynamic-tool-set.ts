// ============================================================
// SOURCE MAP — dynamic-tool-set.ts
// Dynamic tool loading system inspired by GitHub Copilot's
// deferred tools pattern. Instead of sending ALL tools upfront
// (hitting the 128 cap), send a core set + meta-tools that let
// the agent discover and load tools on demand.
// ============================================================
// L1-16:       Source map
// L18-57:      Auto-categorization + keyword-to-category map
// L59-120:     Meta-tool definitions (discover + load)
// L122-170:    Interfaces & options
// L172-520:    DynamicToolSet class (with preloadForTask, tryAutoLoad)
// ============================================================

import * as vscode from "vscode";

// ─── Auto-Categorization ──────────────────────────────────────────────

/**
 * Map tool name prefixes to human-readable categories.
 * Order matters: more specific patterns first.
 */
const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/^projectBrain_/, "brain"],
  [/^mcp_rag-docs_/, "memory"],
  [/^mcp_github_/, "github"],
  [/^mcp_gitkraken_/, "git"],
  [/^mcp_pylance_/, "python"],
  [/^mcp_io_github_chr_/, "browser"],
  [/^mcp_microsoft_pla_/, "browser"],
  [/^mcp_supabase_/, "database"],
  [/^mcp_console-ninja_/, "debugging"],
  [/^mcp_com_postman_/, "api"],
  [/^mcp_aws_/, "aws"],
  [/^mcp_agent-orchest_/, "orchestration"],
  [/^copilot_/, "copilot"],
];

function categorize(toolName: string): string {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(toolName)) return category;
  }
  // Fallback: extract namespace from mcp_ prefix
  const mcpMatch = toolName.match(/^mcp_([^_]+(?:_[^_]+)?)_/);
  if (mcpMatch) return mcpMatch[1].replace(/_/g, "-");
  return "other";
}

/**
 * Keyword-to-category map for task-aware preloading.
 * If a task description contains any of these keywords,
 * the corresponding category is pre-loaded automatically.
 */
const TASK_KEYWORD_MAP: [RegExp, string][] = [
  [
    /\b(git|commit|branch|merge|blame|diff|log|push|pull|stash|rebase|cherry-pick)\b/i,
    "git",
  ],
  [
    /\b(github|issue|pull\s*request|PR|repo|repository|fork|release|tag)\b/i,
    "github",
  ],
  [/\b(python|pylance|pip|import|docstring|type\s*hint)\b/i, "python"],
  [
    /\b(browser|playwright|screenshot|click|navigate|page|DOM|selenium|chrome)\b/i,
    "browser",
  ],
  [
    /\b(database|sql|supabase|table|migration|query|schema|postgres)\b/i,
    "database",
  ],
  [/\b(debug|console|log|error|runtime|trace|breakpoint)\b/i, "debugging"],
  [
    /\b(api|postman|endpoint|REST|request|collection|mock|swagger|openapi)\b/i,
    "api",
  ],
  [/\b(aws|amazon|location|geocode|route|cloud)\b/i, "aws"],
  [/\b(orchestrat|swarm|agent|delegate|workflow|session)\b/i, "orchestration"],
  [/\b(copilot|notebook|kernel)\b/i, "copilot"],
  [/\b(memory|docs|search|RAG|vectoriz|brain|opinion|learning)\b/i, "memory"],
];

// ─── Meta-Tool Definitions ────────────────────────────────────────────

export const DISCOVER_TOOL_NAME = "swarm_discover_tools";
export const LOAD_TOOLS_NAME = "swarm_load_tools";

const DISCOVER_TOOL_DEF: vscode.LanguageModelChatTool = {
  name: DISCOVER_TOOL_NAME,
  description:
    "Search for available tools you can load. Query by name pattern, description keywords, or category. " +
    "Returns matching tools with descriptions. Use swarm_load_tools to activate them. " +
    "Known categories: brain, memory, github, git, python, browser, database, debugging, api, aws, orchestration, copilot.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search pattern matched against tool name and description (case-insensitive). " +
          "Examples: 'file', 'search', 'git blame', 'pull request'.",
      },
      category: {
        type: "string",
        description:
          "Filter by category. Examples: 'github', 'browser', 'database', 'git'.",
      },
    },
    required: [],
  },
};

const LOAD_TOOLS_DEF: vscode.LanguageModelChatTool = {
  name: LOAD_TOOLS_NAME,
  description:
    "Activate tools so they become available for use. " +
    "Provide specific tool names OR a category to load all tools in that group. " +
    "Loaded tools persist for the rest of the session. Check capacity before mass-loading.",
  inputSchema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Specific tool names to load (from discover results).",
      },
      category: {
        type: "string",
        description:
          "Load ALL tools in this category at once (e.g., 'github', 'browser').",
      },
    },
    required: [],
  },
};

// ─── Interfaces ───────────────────────────────────────────────────────

interface ToolEntry {
  tool: vscode.LanguageModelChatTool;
  category: string;
  loaded: boolean;
}

interface DiscoverResult {
  name: string;
  category: string;
  description: string;
  loaded: boolean;
}

export interface DynamicToolSetOptions {
  /**
   * Tool name prefixes that are always included in the core set.
   * Default: ["projectBrain_", "mcp_rag-docs_"]
   *
   * IMPORTANT: memory/search tools (projectBrain_, mcp_rag-docs_) MUST
   * always be core — they are indispensable for the agent to function.
   * Never remove these defaults.
   */
  corePrefixes?: string[];

  /**
   * Exact tool names always included (e.g., specific MCP tools the agent needs).
   */
  coreNames?: string[];

  /**
   * Hard limit for tools per request.
   * Default: 128 (OpenAI/Claude limit).
   */
  maxPerRequest?: number;

  /**
   * If total filtered tools ≤ this number, skip dynamic loading
   * and send everything (passthrough mode). No overhead when not needed.
   * Default: 40
   */
  autoThreshold?: number;

  /** Logger function */
  log?: (msg: string) => void;
}

// ─── DynamicToolSet ───────────────────────────────────────────────────

/**
 * Manages dynamic tool loading for agentic workers.
 *
 * **How it works:**
 *
 * 1. `initialize()` with all available tools after filtering
 * 2. If tool count ≤ threshold → passthrough mode (all tools sent, no overhead)
 * 3. If tool count > threshold → dynamic mode:
 *    - Core tools (matching corePrefixes/coreNames) always available
 *    - Meta-tools (discover + load) always available
 *    - Agent uses discover → load cycle to get additional tools
 *    - Loaded tools persist for the session, added to subsequent requests
 *
 * 4. Call `getActiveTools()` each round to get the current tool set
 * 5. Intercept tool calls with `isMetaTool()` + `handleToolCall()`
 *
 * Inspired by GitHub Copilot's deferred tool pattern (tool_search_tool_regex).
 */
export class DynamicToolSet {
  private registry: Map<string, ToolEntry> = new Map();
  private coreTools: Map<string, vscode.LanguageModelChatTool> = new Map();
  private loadedTools: Map<string, vscode.LanguageModelChatTool> = new Map();
  private readonly corePrefixes: string[];
  private readonly coreNames: Set<string>;
  private readonly maxPerRequest: number;
  private readonly autoThreshold: number;
  private readonly log: (msg: string) => void;
  private active = false;
  /** Cached list of category names for the system prompt hint */
  private categoryList: string[] = [];

  constructor(options: DynamicToolSetOptions = {}) {
    this.corePrefixes = options.corePrefixes ?? [
      "projectBrain_",
      "mcp_rag-docs_",
    ];
    this.coreNames = new Set(options.coreNames ?? []);
    this.maxPerRequest = options.maxPerRequest ?? 128;
    this.autoThreshold = options.autoThreshold ?? 40;
    this.log = options.log ?? (() => {});
  }

  /**
   * Initialize from the pre-filtered tool list.
   * Call this AFTER applying defaultToolFilter/planOnlyToolFilter.
   *
   * @param filteredTools - Tools that passed the filter
   * @param virtualToolCount - Number of extra virtual tools (mailbox, etc.)
   * @returns true if dynamic mode is active (tools > threshold)
   */
  initialize(
    filteredTools: vscode.LanguageModelChatTool[],
    virtualToolCount: number = 0,
  ): boolean {
    this.registry.clear();
    this.coreTools.clear();
    this.loadedTools.clear();
    this.categoryList = [];

    // If tools + virtual + meta-tools fit comfortably, passthrough
    const totalNeeded = filteredTools.length + virtualToolCount + 2; // +2 meta
    if (filteredTools.length <= this.autoThreshold) {
      this.active = false;
      this.log(
        `[DynamicToolSet] Passthrough: ${filteredTools.length} tools ≤ ${this.autoThreshold} threshold`,
      );
      return false;
    }

    this.active = true;
    this.log(
      `[DynamicToolSet] DYNAMIC MODE: ${filteredTools.length} tools > ${this.autoThreshold} threshold (would need ${totalNeeded} slots)`,
    );

    // Build registry and identify core tools
    const categoryCounts = new Map<string, number>();
    for (const tool of filteredTools) {
      const category = categorize(tool.name);
      const isCore = this.isCoreToolName(tool.name);

      this.registry.set(tool.name, { tool, category, loaded: isCore });
      if (isCore) {
        this.coreTools.set(tool.name, tool);
      }

      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }

    // Cache categories for prompt hint
    this.categoryList = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}(${count})`);

    this.log(
      `[DynamicToolSet] Registry: ${this.registry.size} total, ${this.coreTools.size} core`,
    );
    this.log(`[DynamicToolSet] Categories: ${this.categoryList.join(", ")}`);

    return true;
  }

  /** Is dynamic loading active? */
  isDynamic(): boolean {
    return this.active;
  }

  /**
   * Get tools to include in the current request.
   *
   * In passthrough mode: returns allFilteredTools + virtualTools capped to limit.
   * In dynamic mode: returns core + loaded + meta-tools + virtualTools.
   */
  getActiveTools(
    allFilteredTools: vscode.LanguageModelChatTool[],
    virtualTools?: vscode.LanguageModelChatTool[],
  ): vscode.LanguageModelChatTool[] {
    const extras = virtualTools ?? [];

    if (!this.active) {
      // Passthrough — everything
      const all = [...allFilteredTools, ...extras];
      if (all.length > this.maxPerRequest) {
        this.log(
          `[DynamicToolSet] Passthrough cap: ${all.length} → ${this.maxPerRequest}`,
        );
        return all.slice(0, this.maxPerRequest);
      }
      return all;
    }

    // Dynamic: core + loaded + meta + virtual
    const result: vscode.LanguageModelChatTool[] = [
      ...this.coreTools.values(),
      ...this.loadedTools.values(),
      DISCOVER_TOOL_DEF,
      LOAD_TOOLS_DEF,
      ...extras,
    ];

    if (result.length > this.maxPerRequest) {
      this.log(
        `[DynamicToolSet] OVERFLOW: ${result.length} > ${this.maxPerRequest}, truncating loaded tools`,
      );
      return result.slice(0, this.maxPerRequest);
    }

    return result;
  }

  /** Get count of currently active tools */
  getActiveCount(): number {
    if (!this.active) return 0; // N/A in passthrough
    return this.coreTools.size + this.loadedTools.size + 2; // +2 meta
  }

  /** Get total tools in registry */
  getRegistrySize(): number {
    return this.registry.size;
  }

  /** Check if a tool call targets a meta-tool */
  isMetaTool(name: string): boolean {
    return name === DISCOVER_TOOL_NAME || name === LOAD_TOOLS_NAME;
  }

  /**
   * Handle a meta-tool call.
   * @returns result text, or null if not a meta-tool
   */
  handleToolCall(name: string, input: unknown): string | null {
    if (name === DISCOVER_TOOL_NAME) {
      return this.handleDiscover(
        input as { query?: string; category?: string },
      );
    }
    if (name === LOAD_TOOLS_NAME) {
      return this.handleLoad(input as { names?: string[]; category?: string });
    }
    return null;
  }

  /**
   * Build a system prompt hint explaining the dynamic tool system.
   * Should be appended to the worker's system prompt when active.
   */
  getSystemPromptHint(): string {
    if (!this.active) return "";

    return [
      "",
      "DYNAMIC TOOLS:",
      `You have ${this.coreTools.size} core tools loaded. ${this.registry.size - this.coreTools.size} more are available on demand.`,
      `Available categories: ${this.categoryList.map((c) => c.split("(")[0]).join(", ")}.`,
      "To find tools: call `swarm_discover_tools` with a query or category.",
      "To activate tools: call `swarm_load_tools` with tool names or a category.",
      "Loaded tools become available immediately in your next action.",
      "Load only what you need — don't load entire categories unnecessarily.",
    ].join("\n");
  }

  // ─── Private Handlers ──────────────────────────────────────────────

  private handleDiscover(input: { query?: string; category?: string }): string {
    const results: DiscoverResult[] = [];
    const queryLower = input.query?.toLowerCase();
    const categoryFilter = input.category?.toLowerCase();

    for (const [name, entry] of this.registry) {
      let matches = true;

      if (categoryFilter) {
        matches = entry.category === categoryFilter;
      }
      if (queryLower && matches) {
        matches =
          name.toLowerCase().includes(queryLower) ||
          entry.tool.description.toLowerCase().includes(queryLower);
      }
      // No filters = show all
      if (!queryLower && !categoryFilter) {
        matches = true;
      }

      if (matches) {
        const isLoaded = this.coreTools.has(name) || this.loadedTools.has(name);
        results.push({
          name,
          category: entry.category,
          description: entry.tool.description.substring(0, 100),
          loaded: isLoaded,
        });
      }
    }

    // Unloaded first, then alphabetical
    results.sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    if (results.length === 0) {
      return `No tools found matching query="${input.query ?? ""}" category="${input.category ?? ""}". Try a broader search or different category.`;
    }

    const shown = results.slice(0, 30);
    const lines = shown.map((r) => {
      const status = r.loaded ? "✅" : "⬜";
      return `${status} [${r.category}] ${r.name}: ${r.description}`;
    });

    const remaining = results.length - shown.length;
    const header =
      `Found ${results.length} tools` +
      (remaining > 0 ? ` (showing 30, ${remaining} more available)` : "") +
      ":";

    this.log(
      `[DynamicToolSet] Discover: query="${input.query ?? ""}" cat="${input.category ?? ""}" → ${results.length} results`,
    );

    return [
      header,
      ...lines,
      "",
      'Call swarm_load_tools with { names: [...] } or { category: "..." } to activate.',
    ].join("\n");
  }

  private handleLoad(input: { names?: string[]; category?: string }): string {
    const loaded: string[] = [];
    const notFound: string[] = [];
    const alreadyLoaded: string[] = [];
    const overflow: string[] = [];

    // Collect tool names to load
    const namesToLoad: string[] = [];

    if (input.names && Array.isArray(input.names)) {
      namesToLoad.push(...input.names);
    }

    if (input.category) {
      const catLower = input.category.toLowerCase();
      for (const [name, entry] of this.registry) {
        if (entry.category === catLower && !this.coreTools.has(name)) {
          namesToLoad.push(name);
        }
      }
    }

    // Deduplicate
    const unique = [...new Set(namesToLoad)];

    for (const name of unique) {
      const entry = this.registry.get(name);
      if (!entry) {
        notFound.push(name);
        continue;
      }
      if (this.coreTools.has(name) || this.loadedTools.has(name)) {
        alreadyLoaded.push(name);
        continue;
      }

      // Check capacity (core + loaded + 2 meta + virtual slack)
      const currentActive = this.coreTools.size + this.loadedTools.size + 2;
      if (currentActive >= this.maxPerRequest - 5) {
        // Leave 5 slots for virtual tools
        overflow.push(name);
        continue;
      }

      this.loadedTools.set(name, entry.tool);
      entry.loaded = true;
      loaded.push(name);
    }

    // Build response
    const parts: string[] = [];
    if (loaded.length > 0) {
      parts.push(`✅ Loaded ${loaded.length} tools: ${loaded.join(", ")}`);
    }
    if (alreadyLoaded.length > 0) {
      parts.push(`ℹ️ Already loaded: ${alreadyLoaded.join(", ")}`);
    }
    if (notFound.length > 0) {
      parts.push(`❌ Not found: ${notFound.join(", ")}`);
    }
    if (overflow.length > 0) {
      parts.push(`⚠️ Skipped (at capacity): ${overflow.join(", ")}`);
    }

    const totalActive = this.coreTools.size + this.loadedTools.size + 2;
    parts.push(`\nActive tools: ${totalActive}/${this.maxPerRequest}`);
    parts.push("These tools are now available for use in your next action.");

    this.log(
      `[DynamicToolSet] Load: +${loaded.length} new, ${alreadyLoaded.length} existing, ${notFound.length} not found, ${overflow.length} overflow`,
    );

    return parts.join("\n");
  }

  /**
   * Analyze a task description and pre-load tools from matching categories.
   * Call AFTER initialize() and BEFORE the first agentic round.
   *
   * @param taskText - Task description, prompt, or system message
   * @returns List of categories that were pre-loaded
   */
  preloadForTask(taskText: string): string[] {
    if (!this.active) return []; // Passthrough mode — everything already available

    const matchedCategories = new Set<string>();
    for (const [pattern, category] of TASK_KEYWORD_MAP) {
      if (pattern.test(taskText)) {
        matchedCategories.add(category);
      }
    }

    if (matchedCategories.size === 0) {
      this.log(
        `[DynamicToolSet] preloadForTask: no category keywords found in task`,
      );
      return [];
    }

    const preloaded: string[] = [];
    for (const category of matchedCategories) {
      let count = 0;
      for (const [name, entry] of this.registry) {
        if (
          entry.category === category &&
          !this.coreTools.has(name) &&
          !this.loadedTools.has(name)
        ) {
          // Capacity check
          const currentActive = this.coreTools.size + this.loadedTools.size + 2;
          if (currentActive >= this.maxPerRequest - 5) {
            this.log(
              `[DynamicToolSet] preloadForTask: capacity reached, stopping`,
            );
            break;
          }
          this.loadedTools.set(name, entry.tool);
          entry.loaded = true;
          count++;
        }
      }
      if (count > 0) {
        preloaded.push(`${category}(${count})`);
      }
    }

    if (preloaded.length > 0) {
      this.log(
        `[DynamicToolSet] preloadForTask: auto-loaded ${preloaded.join(", ")}`,
      );
    }
    return preloaded.map((p) => p.split("(")[0]);
  }

  /**
   * Try to auto-load a tool that the agent called but isn't in the active set.
   * Returns the tool if found in registry, null otherwise.
   *
   * This prevents "wasted turns" when the model hallucinates or remembers
   * a tool name from context (e.g., system prompt listing available categories).
   */
  tryAutoLoad(toolName: string): vscode.LanguageModelChatTool | null {
    if (!this.active) return null;

    // Already loaded?
    if (this.coreTools.has(toolName) || this.loadedTools.has(toolName)) {
      return null; // Already available, error is from something else
    }

    const entry = this.registry.get(toolName);
    if (!entry) return null; // Truly unknown tool

    // Capacity check
    const currentActive = this.coreTools.size + this.loadedTools.size + 2;
    if (currentActive >= this.maxPerRequest - 5) {
      this.log(
        `[DynamicToolSet] tryAutoLoad: at capacity, can't auto-load ${toolName}`,
      );
      return null;
    }

    this.loadedTools.set(toolName, entry.tool);
    entry.loaded = true;
    this.log(
      `[DynamicToolSet] tryAutoLoad: auto-loaded ${toolName} (category: ${entry.category})`,
    );
    return entry.tool;
  }

  private isCoreToolName(name: string): boolean {
    if (this.coreNames.has(name)) return true;
    return this.corePrefixes.some((prefix) => name.startsWith(prefix));
  }
}
