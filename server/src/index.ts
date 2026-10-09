import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve, join, basename, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import {
  formatGraphStats,
  formatRelations,
  GraphMemory,
  loadOrBuildGraph,
} from "./graph.js";
import {
  formatHistory,
  formatHistoryStats,
  formatHotspots,
  MemoryHistory,
} from "./history.js";
import { formatSearchResults, searchDocuments } from "./search.js";
import { getProjectId, listProjects, loadIndex, getLocalMemoryDir, deleteProjectData } from "./storage.js";
import { validateCapture } from "./reflection.js";
import { appendToDiary, readFullDiary } from "./diary.js";
import { addOpinion, listOpinions } from "./learning.js";
import { captureLearningHybrid } from "./semantic-capture.js";
import { reflectOpinions } from "./reflect.js";
import { runQualityGate } from "./quality-gate-tool.js";
import { vectorizeProject } from "./vectorize.js";
import {
  getWatchedProjects,
  getWatcherStats,
  isWatching,
  projectMutex,
  startWatching,
} from "./watcher.js";

/** Resolve memory directory for READING: checks project dirs first, then local storage */
function resolveMemoryDir(projectPath: string): string | null {
  const candidates = [
    join(projectPath, ".project-brain", "memory"),
    join(projectPath, "docs", "memory"),
    join(projectPath, "memory"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: check local storage (never pollutes the project)
  const localDir = getLocalMemoryDir(projectPath);
  if (existsSync(localDir)) return localDir;
  return null;
}

/**
 * Resolve memory directory for WRITING. Symmetric with `resolveMemoryDir`: if the
 * project already has a committed brain store, write THERE so MCP writes are
 * visible to search/get_context and shared with the repo (reads and writes must
 * resolve to the same place). Only when no project store exists do we fall back
 * to local storage — that keeps the original "never CREATE a brain dir in a
 * project that didn't opt in" guarantee, without diverting writes away from a
 * store the project already has.
 */
function resolveWriteMemoryDir(projectPath: string): string {
  const candidates = [
    join(projectPath, ".project-brain", "memory"),
    join(projectPath, "docs", "memory"),
    join(projectPath, "memory"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return getLocalMemoryDir(projectPath);
}

/**
 * Returns all memory directories that exist for reading (project + local).
 * Used by tools that need to merge content from both sources.
 */
function resolveAllMemoryDirs(projectPath: string): string[] {
  const dirs: string[] = [];
  const candidates = [
    join(projectPath, ".project-brain", "memory"),
    join(projectPath, "docs", "memory"),
    join(projectPath, "memory"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dirs.push(candidate);
      break; // Only take the first project-level match
    }
  }
  const localDir = getLocalMemoryDir(projectPath);
  if (existsSync(localDir) && !dirs.includes(localDir)) {
    dirs.push(localDir);
  }
  return dirs;
}

/** Parse ALLOWED_PATHS env var into resolved absolute paths */
function getAllowedPaths(): string[] {
  const raw = process.env.ALLOWED_PATHS || "";
  return raw.split(",").map(p => p.trim()).filter(Boolean).map(p => resolve(p));
}

/** Validate that a resolved path is within ALLOWED_PATHS (if configured) */
function validatePathAccess(resolvedPath: string): string {
  const allowed = getAllowedPaths();
  if (allowed.length === 0) return resolvedPath; // No restriction configured
  const normalized = resolve(resolvedPath);
  if (allowed.some(a => normalized.startsWith(a))) return resolvedPath;
  throw new Error(
    `Access denied: "${normalized}" is not in ALLOWED_PATHS. ` +
    `Allowed: ${allowed.join(", ")}. Set ALLOWED_PATHS env var to adjust.`
  );
}

/** Resolve projectPath with auto-healing: args → env → cwd walk → single indexed project */
function resolveProjectPath(args: Record<string, unknown>): string {
  // 1. Explicit arg
  const explicit = args.projectPath as string;
  if (explicit) return validatePathAccess(resolve(explicit));

  // 2. Env var
  const envPath = process.env.PROJECT_PATH;
  if (envPath) return validatePathAccess(resolve(envPath));

  // 3. Walk cwd upward looking for .project-brain/ or .project-brain/memory/
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".project-brain", "memory")) || existsSync(join(dir, ".project-brain"))) {
      return validatePathAccess(resolve(dir));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. If exactly one project indexed, use it
  const indexed = listProjects();
  if (indexed.length === 1) {
    // Read the stored index to find original path
    try {
      const idx = loadIndex(indexed[0]);
      if (idx && idx.projectPath) return validatePathAccess(resolve(idx.projectPath));
    } catch { /* fall through */ }
  }

  throw new Error(
    "projectPath could not be resolved. Tried: args.projectPath, PROJECT_PATH env var, " +
    ".project-brain/ in cwd ancestors, single indexed project. " +
    "Please pass projectPath explicitly or set PROJECT_PATH env var."
  );
}

const server = new Server(
  { name: "mcp-rag-docs", version: "3.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_memory",
      description:
        "Search the project documentation/memory for relevant information. Use this when you need context about the project architecture, features, or implementation details.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to find relevant documentation",
          },
          projectPath: {
            type: "string",
            description: "Optional: specific project path to search",
          },
          topK: {
            type: "number",
            description: "Number of results to return (default: 5)",
          },
          hybridWeight: {
            type: "number",
            description:
              "Balance between semantic and keyword search. 0 = pure keyword, 1 = pure semantic. Default: 0.7 (mostly semantic)",
          },
          fileFilter: {
            type: "string",
            description: "Optional: filter results by file path pattern",
          },
          category: {
            type: "string",
            description: "Optional: filter by category (e.g., learnings, troubleshooting, architecture, codemap, session, overview, skills)",
          },
          topic: {
            type: "string",
            description: "Optional: filter by topic substring",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "search_relations",
      description:
        "Search the project's knowledge graph for entity relationships. Use this to find how files, modules, dependencies, and concepts are connected. Returns graph traversal results showing what depends on what, what extends what, etc.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Entity or concept to search for relationships (e.g., 'scanner.ts', 'GraphMemory', 'esbuild')",
          },
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          depth: {
            type: "number",
            description:
              "How many hops to traverse from the entity (default: 2)",
          },
          mode: {
            type: "string",
            enum: ["entity", "query", "stats"],
            description:
              "Search mode: 'entity' (BFS from entity), 'query' (keyword search), 'stats' (graph statistics). Default: 'entity'",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "index_project",
      description:
        "Index or re-index a project's memory/documentation folder for semantic search.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          forceReindex: {
            type: "boolean",
            description: "Force complete re-indexing (default: false)",
          },
        },
        required: [],
      },
    },
    {
      name: "watch_project",
      description:
        "Start watching a project for documentation changes and auto-update the index.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
        },
        required: [],
      },
    },
    {
      name: "list_indexed_projects",
      description: "List all projects that have been indexed for search.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_project_stats",
      description: "Get statistics about an indexed project.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
        },
        required: [],
      },
    },    {
      name: "memory_history",
      description:
        "Query the memory change history. Shows what was added, updated, or deleted over time. Useful for auditing changes, finding hotspots (frequently changed files), and detecting stale documentation.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          mode: {
            type: "string",
            enum: ["recent", "target", "hotspots", "stale", "stats"],
            description:
              "Query mode: 'recent' (latest changes), 'target' (history for specific file), 'hotspots' (most changed), 'stale' (outdated docs), 'stats' (summary). Default: 'recent'",
          },
          query: {
            type: "string",
            description:
              "For 'target' mode: the file path or entity to look up history for",
          },
          limit: {
            type: "number",
            description: "Number of results to return (default: 20)",
          },
        },
        required: [],
      },
    },
    
    {
      name: "get_vectorization_status",
      description: "Get the vectorization and watcher status for a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
        },
        required: [],
      },
    },
    {
      name: "write_memory",
      description:
        "Write or append content to a memory file in the project's memory folder (.project-brain/memory/ or docs/memory/). Use this to update documentation, add learnings, update troubleshooting, etc. Creates the file if it doesn't exist.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          file: {
            type: "string",
            description:
              "Memory file name or relative path (e.g., '04_LEARNINGS.md', 'skills/my-skill/SKILL.md', 'TASK_QUEUE.md')",
          },
          content: {
            type: "string",
            description: "The content to write or append",
          },
          mode: {
            type: "string",
            enum: ["append", "overwrite"],
            description:
              "Write mode: 'append' adds to end of file, 'overwrite' replaces entire file. Default: 'append'",
          },
        },
        required: ["file", "content"],
      },
    },
    {
      name: "get_context",
      description:
        "Read a specific memory file by name or aspect. Returns the full content of a memory file (.project-brain/memory/ or docs/memory/). Use for reading architecture, dependencies, learnings, troubleshooting, identity, soul, user profile, etc.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          file: {
            type: "string",
            description:
              "Memory file name, aspect keyword, or relative path. Accepts: exact filename ('04_LEARNINGS.md'), aspect ('architecture', 'dependencies', 'learnings', 'troubleshooting', 'identity', 'soul', 'session', 'user', 'tools', 'overview', 'code-map', 'git'), or skill path ('skills/self-upgrade/SKILL.md')",
          },
        },
        required: ["file"],
      },
    },
    {
      name: "list_memory_files",
      description:
        "List all memory files and skills available in the project's memory folder (.project-brain/memory/ or docs/memory/). Shows the full directory structure.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
        },
        required: [],
      },
    },
    {
      name: "validate_capture",
      description:
        "Quality gate for self-learning: classify a captured text as 'genuine' (insightful — a lesson, decision, or debugging insight) vs 'mechanical' (autopilot status text). Returns a 0-1 score and a boolean. Uses a remote BERT endpoint when configured/reachable, otherwise a zero-cost local heuristic (fail-open). Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The captured text to classify",
          },
          threshold: {
            type: "number",
            description: "Genuine-score cutoff (0-1). Default 0.85",
          },
          apiUrl: {
            type: "string",
            description: "Optional remote BERT endpoint base URL (e.g. http://vps:8790)",
          },
          apiKey: {
            type: "string",
            description: "Optional API key for the BERT endpoint (X-API-Key)",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "run_quality_gate",
      description:
        "Portable quality gate: evaluate a candidate terminal command and/or file content against the shared gate engine (same logic the VS Code hook enforces). Runs the destructive-command gate (blocks rm -rf, git push --force, DROP TABLE, mkfs, FORMAT, etc.) and the secret-exposure gate (detects API keys, tokens, private keys in written content). Returns an overall allow/deny plus per-gate verdicts. Pure, no side effects — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The terminal command / prompt text to evaluate (command gates)",
          },
          content: {
            type: "string",
            description: "File content to evaluate (content gates, e.g. secret-exposure)",
          },
          filePath: {
            type: "string",
            description: "Optional: destination path for content gates (skips test/fixture paths)",
          },
          tool: {
            type: "string",
            description: "Optional: the tool being evaluated (e.g. 'run_in_terminal')",
          },
          gates: {
            type: "array",
            items: { type: "string" },
            description: "Optional: explicit gate ids to run. Defaults to all applicable gates.",
          },
        },
      },
    },
    {
      name: "read_diary",
      description:
        "Read an agent's per-mode learning diary (.project-brain/memory/agents/<mode>-diary.md). Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          mode: {
            type: "string",
            enum: ["documenter", "reviewer", "planner", "researcher", "onboard", "general"],
            description: "Context for the diary: 'documenter' (documentation), 'reviewer' (code review), 'planner' (planning), 'researcher' (investigation), 'onboard' (onboarding), 'general' (default). Use 'general' if unsure.",
          },
        },
        required: [],
      },
    },
    {
      name: "write_diary",
      description:
        "Append a learning entry to an agent's per-mode diary. Creates the file if missing and rotates after 100 entries. Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          mode: {
            type: "string",
            enum: ["documenter", "reviewer", "planner", "researcher", "onboard", "general"],
            description: "Context for the diary entry: 'documenter' (documentation sessions), 'reviewer' (code review), 'planner' (planning/architecture), 'researcher' (investigation/research), 'onboard' (onboarding notes), 'general' (default — anything else). Use 'general' if unsure.",
          },
          title: { type: "string", description: "Short title for the entry" },
          context: { type: "string", description: "What was being worked on" },
          learning: { type: "string", description: "The insight/lesson learned" },
          confidence: {
            type: "string",
            description: "high | medium | low (default: medium)",
          },
        },
        required: ["title", "learning"],
      },
    },
    {
      name: "capture_learning",
      description:
        "Scan text for capturable learnings (12 regex patterns: fixes, root causes, decisions, lessons, warnings) and persist NEW opinions to 14_OPINIONS.md. Dedups against existing (>60% word overlap). Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          text: {
            type: "string",
            description: "Text to scan for learnings (e.g. a session summary or chat turn)",
          },
          source: {
            type: "string",
            description: "Optional evidence source label",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "list_opinions",
      description:
        "List tracked opinions from 14_OPINIONS.md, optionally filtered by domain (architecture, patterns, tools, debugging, workflow, preferences, general). Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          domain: {
            type: "string",
            description: "Optional domain filter",
          },
        },
        required: [],
      },
    },
    {
      name: "reflect_opinions",
      description:
        "Run MAINTENANCE on existing opinions in 14_OPINIONS.md: time decay, dedup-merge, contradiction detection, test-artifact purge, low-confidence prune. Does NOT add opinions — use add_opinion or capture_learning for that. Pass dryRun=true to preview. Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          dryRun: {
            type: "boolean",
            description: "Preview changes without persisting. Default: false — will modify opinions file. Set to true to inspect first.",
          },
        },
        required: [],
      },
    },
    {
      name: "bootstrap_project",
      description:
        "Bootstrap a new project for memory/documentation. Creates .project-brain/memory/ with starter template files (overview, learnings, troubleshooting, session handoff, opinions). Safe to re-run — skips files that already exist. Call this FIRST on any new project before indexing.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          projectName: {
            type: "string",
            description: "Human-readable project name (auto-detected from directory name if omitted)",
          },
        },
        required: [],
      },
    },
    {
      name: "add_opinion",
      description:
        "Directly register a technical preference or learned pattern as an opinion. Use this to explicitly record things like 'Always use TypeScript strict mode' or 'Prefer composition over inheritance'. Deduplicates automatically — if a similar opinion exists, it boosts its confidence instead. Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          statement: {
            type: "string",
            description: "The opinion or preference to record (e.g., 'Always validate inputs at system boundaries')",
          },
          confidence: {
            type: "number",
            description: "Confidence level from 0.05 to 0.99. Higher = stronger conviction. Default: 0.7",
          },
          domain: {
            type: "string",
            enum: ["architecture", "debugging", "patterns", "testing", "security", "performance", "general"],
            description: "Category for the opinion. Default: 'general'",
          },
        },
        required: ["statement"],
      },
    },
    {
      name: "reset_project",
      description:
        "Remove all locally stored data for a project: vector index, MCP-written memory (opinions, diaries, learnings), and backups. Does NOT touch the project's .project-brain/ directory. Use this to start fresh or clean up after experiments. Portable — works from any MCP client.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Absolute path to the project root (falls back to PROJECT_PATH env var)",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to proceed. Safety gate to prevent accidental deletion.",
          },
        },
        required: ["confirm"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_memory": {
        const { query, topK, hybridWeight, fileFilter, category, topic } = args as {
          query: string;
          topK?: number;
          hybridWeight?: number;
          fileFilter?: string;
          category?: string;
          topic?: string;
        };

        const effectivePath = resolveProjectPath(args as Record<string, unknown>);
        const projectIds = effectivePath
          ? [getProjectId(resolve(effectivePath))]
          : listProjects();

        let allResults: Awaited<ReturnType<typeof searchDocuments>> = [];

        for (const projectId of projectIds) {
          const index = loadIndex(projectId);
          if (index) {
            const results = await searchDocuments(index, query, {
              topK: topK || 5,
              hybridWeight,
              fileFilter,
              category,
              topic,
            });
            allResults.push(...results);
          }
        }

        allResults.sort((a, b) => b.score - a.score);
        allResults = allResults.slice(0, topK || 5);

        return {
          content: [{ type: "text", text: formatSearchResults(allResults) }],
        };
      }

      case "search_relations": {
        const { query, depth, mode } = args as {
          query: string;
          depth?: number;
          mode?: "entity" | "query" | "stats";
        };

        const effectivePath = resolveProjectPath(args as Record<string, unknown>);

        const projectId = getProjectId(resolve(effectivePath));
        const gm = loadOrBuildGraph(projectId);

        const searchMode = mode || "entity";

        if (searchMode === "stats") {
          const stats = gm.getStats();
          return {
            content: [{ type: "text", text: formatGraphStats(stats) }],
          };
        }

        if (searchMode === "query") {
          const relations = gm.searchByQuery(query, 15);
          return {
            content: [{ type: "text", text: formatRelations(relations) }],
          };
        }

        // Default: entity mode  BFS traversal
        const relations = gm.searchRelated(query, depth || 2);
        if (relations.length === 0) {
          // Fallback to keyword search
          const fallback = gm.searchByQuery(query, 10);
          return {
            content: [{
              type: "text",
              text: fallback.length > 0
                ? "No exact entity match. Keyword results:\n" + formatRelations(fallback)
                : "No relationships found for: " + query,
            }],
          };
        }

        return {
          content: [{ type: "text", text: formatRelations(relations) }],
        };
      }

      case "index_project": {
        const projectPath = resolveProjectPath(args as Record<string, unknown>);
        const { forceReindex } = args as {
          forceReindex?: boolean;
        };
        const resolvedPath = resolve(projectPath);
        const pid = getProjectId(resolvedPath);

        // Include local storage memory in indexing so MCP-written learnings are searchable
        const localMemDir = getLocalMemoryDir(resolvedPath);
        const additionalPaths = existsSync(localMemDir) ? [localMemDir] : [];

        const release = await projectMutex.acquire(pid);
        let index;
        try {
          index = await vectorizeProject({
            projectPath: resolvedPath,
            forceReindex,
            additionalPaths,
          });
        } finally {
          release();
        }

        // Load graph stats for the response
        const gm = loadOrBuildGraph(pid);
        const graphStats = gm.getStats();

        return {
          content: [
            {
              type: "text",
              text:
                "Indexed project: " + index.projectPath +
                "\nTotal chunks: " + index.chunks.length +
                "\nFiles indexed: " + Object.keys(index.fileHashes).length +
                "\nEmbedding type: " + (index.embeddingType || "unknown") +
                "\nGraph nodes: " + graphStats.nodes +
                "\nGraph edges: " + graphStats.edges,
            },
          ],
        };
      }

      case "watch_project": {
        const projectPath = resolveProjectPath(args as Record<string, unknown>);
        const resolved = resolve(projectPath);

        if (isWatching(resolved)) {
          return {
            content: [
              { type: "text", text: "Already watching: " + projectPath },
            ],
          };
        }

        await startWatching(resolved);
        return {
          content: [
            {
              type: "text",
              text: "Now watching for changes in: " + projectPath,
            },
          ],
        };
      }

      case "list_indexed_projects": {
        const projectIds = listProjects();
        const projects: string[] = [];

        for (const id of projectIds) {
          const index = loadIndex(id);
          if (index) {
            const watching = getWatchedProjects().includes(index.projectPath);
            const gm = new GraphMemory(id);
            const hasGraph = gm.load();
            const graphInfo = hasGraph
              ? " [graph: " + gm.getStats().nodes + " nodes]"
              : "";
            projects.push(
              "- " + index.projectPath +
              " (" + index.chunks.length + " chunks)" +
              (watching ? " [watching]" : "") +
              graphInfo,
            );
          }
        }

        return {
          content: [
            {
              type: "text",
              text:
                projects.length > 0
                  ? "**Indexed Projects:**\n" + projects.join("\n")
                  : "No projects indexed yet. Use `index_project` to index a project.",
            },
          ],
        };
      }

      case "get_project_stats": {
        const projectPath = resolveProjectPath(args as Record<string, unknown>);
        const projectId = getProjectId(resolve(projectPath));
        const index = loadIndex(projectId);

        if (!index) {
          return {
            content: [
              { type: "text", text: "Project not indexed: " + projectPath },
            ],
          };
        }

        const files = Object.keys(index.fileHashes);
        const watching = getWatchedProjects().includes(index.projectPath);

        // Graph stats
        const gm = loadOrBuildGraph(projectId);
        const gs = gm.getStats();

        return {
          content: [
            {
              type: "text",
              text:
                "**Project:** " + index.projectPath +
                "\n**Memory Path:** " + index.memoryPath +
                "\n**Total Chunks:** " + index.chunks.length +
                "\n**Files:** " + files.length +
                "\n**Last Updated:** " + new Date(index.lastUpdated).toISOString() +
                "\n**Watching:** " + (watching ? "Yes" : "No") +
                "\n**Graph Nodes:** " + gs.nodes +
                "\n**Graph Edges:** " + gs.edges +
                "\n**Relationship Types:** " + Object.keys(gs.relationshipTypes).join(", ") +
                "\n\n**Files:**\n" + files.map((f) => "- " + f).join("\n"),
            },
          ],
        };
      }

      case "get_vectorization_status": {
        const statusPath = resolveProjectPath(args as Record<string, unknown>);
        const resolvedStatusPath = resolve(statusPath);
        const statusProjectId = getProjectId(resolvedStatusPath);
        const statusIndex = loadIndex(statusProjectId);
        const watching = isWatching(resolvedStatusPath);
        const stats = watching ? getWatcherStats(resolvedStatusPath) : null;

        // Graph status
        const gm = new GraphMemory(statusProjectId);
        const hasGraph = gm.load();
        const gs = hasGraph ? gm.getStats() : null;

        const lines = [
          "**Project:** " + resolvedStatusPath,
          "**Indexed:** " + (statusIndex ? "Yes" : "No"),
        ];

        if (statusIndex) {
          lines.push(
            "**Chunks:** " + statusIndex.chunks.length,
            "**Files:** " + Object.keys(statusIndex.fileHashes).length,
            "**Embedding type:** " + (statusIndex.embeddingType || "unknown"),
            "**Last updated:** " + new Date(statusIndex.lastUpdated).toISOString(),
          );
        }

        lines.push(
          "**Graph:** " + (hasGraph ? "Yes (" + (gs?.nodes || 0) + " nodes, " + (gs?.edges || 0) + " edges)" : "No"),
        );

        lines.push("**Watcher:** " + (watching ? "Active" : "Inactive"));

        if (stats) {
          lines.push(
            "**Updates:** " + stats.totalUpdates,
            "**Pending changes:** " + stats.pendingChanges,
            "**Processing:** " + (stats.isProcessing ? "Yes" : "No"),
            "**Last sync:** " + new Date(stats.lastSyncTime).toISOString(),
            "**Last error:** " + (stats.lastError || "None"),
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }      case "memory_history": {
        const histPath = resolveProjectPath(args as Record<string, unknown>);
        const { mode: histMode, query: histQuery, limit: histLimit } = args as {
          mode?: "recent" | "target" | "hotspots" | "stale" | "stats";
          query?: string;
          limit?: number;
        };

        const histProjectId = getProjectId(resolve(histPath));
        const hist = new MemoryHistory(histProjectId);
        hist.load();
        const hMode = histMode || "recent";
        const hLimit = histLimit || 20;

        let histText: string;

        switch (hMode) {
          case "recent":
            histText = formatHistory(hist.getRecent(hLimit));
            break;
          case "target":
            if (!histQuery) {
              histText = "Error: 'query' parameter required for target mode";
            } else {
              histText = formatHistory(hist.getForTarget(histQuery));
            }
            break;
          case "hotspots":
            histText = formatHotspots(hist.getHotspots(hLimit));
            break;
          case "stale":
            const stale = hist.getStaleTargets();
            if (stale.length === 0) {
              histText = "No stale documentation detected.";
            } else {
              histText = "**Stale Documentation:**\n" + stale.map(
                (s) => "- **" + s.target + "**: " + s.daysSinceUpdate + " days since last update"
              ).join("\n");
            }
            break;
          case "stats":
            histText = formatHistoryStats(hist.getStats());
            break;
          default:
            histText = "Unknown mode: " + hMode;
        }

        return { content: [{ type: "text", text: histText }] };
      }

      case "write_memory": {
        const wmPath = resolveProjectPath(args as Record<string, unknown>);
        const { file: wmFile, content: wmContent, mode: wmMode } = args as {
          file: string;
          content: string;
          mode?: "append" | "overwrite";
        };

        // Writes always go to local storage — never create .project-brain/ in the project
        const memoryDir = resolveWriteMemoryDir(resolve(wmPath));
        const targetFile = join(memoryDir, wmFile);

        // Security: ensure target is within memory dir
        if (!targetFile.startsWith(memoryDir)) {
          return {
            content: [{ type: "text", text: "Error: file path must be within the memory directory" }],
            isError: true,
          };
        }

        // Ensure parent directory exists
        const parentDir = join(targetFile, "..");
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        const writeMode = wmMode || "append";

        if (writeMode === "overwrite") {
          writeFileSync(targetFile, wmContent, "utf-8");
        } else {
          // Append mode
          const existing = existsSync(targetFile)
            ? readFileSync(targetFile, "utf-8")
            : "";
          const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          writeFileSync(targetFile, existing + separator + wmContent, "utf-8");
        }

        return {
          content: [{
            type: "text",
            text: "Written to " + wmFile + " (mode: " + writeMode + ", " + wmContent.length + " chars)",
          }],
        };
      }

      case "get_context": {
        const gcPath = resolveProjectPath(args as Record<string, unknown>);
        const { file: gcFile } = args as {
          file: string;
        };

        const gcMemoryDir = resolveMemoryDir(resolve(gcPath));

        if (!gcMemoryDir) {
          return {
            content: [{ type: "text", text: "No memory directory found at " + gcPath }],
            isError: true,
          };
        }

        // Aspect keyword → filename mapping
        const aspectMap: Record<string, string> = {
          overview: "00_PROJECT_OVERVIEW.md",
          project: "00_PROJECT_OVERVIEW.md",
          architecture: "01_ARCHITECTURE.md",
          "code-map": "02_CODE_MAP.md",
          codemap: "02_CODE_MAP.md",
          dependencies: "03_DEPENDENCIES.md",
          deps: "03_DEPENDENCIES.md",
          learnings: "04_LEARNINGS.md",
          lessons: "04_LEARNINGS.md",
          troubleshooting: "05_TROUBLESHOOTING.md",
          issues: "05_TROUBLESHOOTING.md",
          git: "06_GIT_INSIGHTS.md",
          session: "07_SESSION_HANDOFF.md",
          handoff: "07_SESSION_HANDOFF.md",
          identity: "08_AGENT_IDENTITY.md",
          soul: "09_AGENT_SOUL.md",
          user: "10_USER_PROFILE.md",
          tools: "11_TOOLS.md",
          boot: "BOOT.md",
          tasks: "TASK_QUEUE.md",
          queue: "TASK_QUEUE.md",
        };

        const resolvedFile = aspectMap[gcFile.toLowerCase()] || gcFile;
        const targetPath = join(gcMemoryDir, resolvedFile);

        // Security: ensure target is within memory dir
        if (!targetPath.startsWith(gcMemoryDir)) {
          return {
            content: [{ type: "text", text: "Error: file path must be within the memory directory" }],
            isError: true,
          };
        }

        if (!existsSync(targetPath)) {
          // Fuzzy fallback: try case-insensitive glob match
          const available = readdirSync(gcMemoryDir);
          const fuzzy = available.find(
            (f) => f.toLowerCase().includes(gcFile.toLowerCase()) ||
                   gcFile.toLowerCase().includes(f.toLowerCase().replace(/^\d+_/, "").replace(/\.md$/, ""))
          );
          if (fuzzy) {
            const fuzzyPath = join(gcMemoryDir, fuzzy);
            const fuzzyContent = readFileSync(fuzzyPath, "utf-8");
            return {
              content: [{ type: "text", text: "**" + fuzzy + "** _(matched from \"" + gcFile + "\")_\n\n" + fuzzyContent }],
            };
          }
          return {
            content: [{ type: "text", text: "File not found: " + resolvedFile + "\nAvailable files: " + available.join(", ") }],
            isError: true,
          };
        }

        const fileContent = readFileSync(targetPath, "utf-8");
        return {
          content: [{ type: "text", text: "**" + resolvedFile + "**\n\n" + fileContent }],
        };
      }

      case "list_memory_files": {
        const lmPath = resolveProjectPath(args as Record<string, unknown>);
        const lmDirs = resolveAllMemoryDirs(resolve(lmPath));

        if (lmDirs.length === 0) {
          return {
            content: [{ type: "text", text: "No memory directory found at " + lmPath }],
            isError: true,
          };
        }

        function listRecursive(dir: string, prefix: string = ""): string[] {
          const entries = readdirSync(dir, { withFileTypes: true });
          const lines: string[] = [];
          for (const entry of entries) {
            if (entry.name === "archive") continue;
            if (entry.isDirectory()) {
              lines.push(prefix + "📁 " + entry.name + "/");
              lines.push(...listRecursive(join(dir, entry.name), prefix + "  "));
            } else {
              lines.push(prefix + "📄 " + entry.name);
            }
          }
          return lines;
        }

        const sections: string[] = [];
        for (const dir of lmDirs) {
          const label = dir.includes(".mcp-rag-docs") ? "Local Storage" : "Project";
          sections.push(`**Memory Files (${label}):**\n` + listRecursive(dir).join("\n"));
        }
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
        };
      }

      case "validate_capture": {
        const { text: vcText, threshold: vcThreshold, apiUrl: vcApiUrl, apiKey: vcApiKey } = args as {
          text: string;
          threshold?: number;
          apiUrl?: string;
          apiKey?: string;
        };

        if (!vcText || typeof vcText !== "string") {
          return {
            content: [{ type: "text", text: "Error: 'text' is required" }],
            isError: true,
          };
        }

        const vcResult = await validateCapture(vcText, {
          threshold: vcThreshold,
          apiUrl: vcApiUrl || process.env.REFLECTION_API_URL,
          apiKey: vcApiKey || process.env.REFLECTION_API_KEY,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              is_genuine: vcResult.isGenuine,
              score: Number(vcResult.score.toFixed(3)),
              mode: vcResult.mode,
              signals: vcResult.signals || [],
            }),
          }],
        };
      }

      case "run_quality_gate": {
        // Resolve a workspace root for per-gate severity config; never fail the
        // gate if the path can't be resolved (advisory clients may omit it).
        let qgRoot: string | undefined;
        try {
          qgRoot = resolveProjectPath(args as Record<string, unknown>);
        } catch {
          qgRoot = undefined;
        }
        const qgArgs = (args || {}) as {
          command?: string;
          content?: string;
          filePath?: string;
          tool?: string;
          gates?: string[];
          rootPath?: string;
        };
        const qgResult = runQualityGate({ ...qgArgs, rootPath: qgArgs.rootPath || qgRoot });
        return {
          content: [{ type: "text", text: JSON.stringify(qgResult) }],
          ...(qgResult.decision === "deny" ? { isError: true } : {}),
        };
      }

      case "read_diary": {
        const rdPath = resolveProjectPath(args as Record<string, unknown>);
        const { mode: rdMode } = args as {
          mode?: string;
        };
        const effectiveRdMode = rdMode || "general";
        // Check all memory dirs (project + local) so reads find locally-written diaries
        const rdDirs = resolveAllMemoryDirs(resolve(rdPath));
        if (rdDirs.length === 0) {
          return {
            content: [{ type: "text", text: "No memory directory found at " + rdPath + ". Write a diary entry first to initialize local storage." }],
            isError: true,
          };
        }
        // Try each dir, return first that has content
        let rdContent = "";
        for (const dir of rdDirs) {
          const candidate = readFullDiary(dir, effectiveRdMode);
          if (candidate && !candidate.startsWith("No diary found")) {
            rdContent = candidate;
            break;
          }
        }
        if (!rdContent) {
          rdContent = readFullDiary(rdDirs[0], effectiveRdMode);
        }
        return { content: [{ type: "text", text: rdContent }] };
      }

      case "write_diary": {
        const wdPath = resolveProjectPath(args as Record<string, unknown>);
        const {
          mode: wdMode,
          title: wdTitle,
          context: wdContext,
          learning: wdLearning,
          confidence: wdConfidence,
        } = args as {
          mode?: string;
          title: string;
          context?: string;
          learning: string;
          confidence?: string;
        };
        const effectiveMode = wdMode || "general";
        // Writes go to local storage — never pollute the project
        const wdMemoryDir = resolveWriteMemoryDir(resolve(wdPath));
        const wdConf = wdConfidence === "high" || wdConfidence === "low" ? wdConfidence : "medium";
        const wdOk = appendToDiary(wdMemoryDir, effectiveMode, {
          date: new Date().toISOString().slice(0, 10),
          title: wdTitle,
          context: wdContext || "",
          learning: wdLearning,
          confidence: wdConf,
        });
        return {
          content: [{
            type: "text",
            text: wdOk
              ? `Appended to ${wdMode} diary: "${wdTitle}"`
              : `Failed to write diary (invalid mode "${wdMode}"? valid: documenter, reviewer, planner, researcher, onboard)`,
          }],
          isError: !wdOk,
        };
      }

      case "capture_learning": {
        const clPath = resolveProjectPath(args as Record<string, unknown>);
        const { text: clText, source: clSource } = args as {
          text: string;
          source?: string;
        };
        // Writes go to local storage — never pollute the project
        const clMemoryDir = resolveWriteMemoryDir(resolve(clPath));
        const clResult = await captureLearningHybrid(clMemoryDir, clText || "", clSource);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              captured: clResult.captured,
              total: clResult.total,
              statements: clResult.statements,
              mode: clResult.mode,
            }),
          }],
        };
      }

      case "list_opinions": {
        const loPath = resolveProjectPath(args as Record<string, unknown>);
        const { domain: loDomain } = args as {
          domain?: string;
        };
        // Merge opinions from all sources (project + local storage)
        const loDirs = resolveAllMemoryDirs(resolve(loPath));
        if (loDirs.length === 0) {
          return {
            content: [{ type: "text", text: "No memory directory found at " + loPath }],
            isError: true,
          };
        }
        const seenIds = new Set<string>();
        const loOpinions: ReturnType<typeof listOpinions> = [];
        for (const dir of loDirs) {
          for (const op of listOpinions(dir, loDomain)) {
            if (!seenIds.has(op.id)) {
              seenIds.add(op.id);
              loOpinions.push(op);
            }
          }
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              loOpinions.map((o) => ({
                id: o.id,
                domain: o.domain,
                statement: o.statement,
                confidence: o.confidence,
              })),
            ),
          }],
        };
      }

      case "reflect_opinions": {
        const roPath = resolveProjectPath(args as Record<string, unknown>);
        const { dryRun: roDryRun } = args as {
          dryRun?: boolean;
        };
        // Reflect writes to local storage — never pollute the project
        const roMemoryDir = resolveWriteMemoryDir(resolve(roPath));
        const roReport = reflectOpinions(roMemoryDir, roDryRun === true);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: roReport.total,
              pruned: roReport.pruned.length,
              merged: roReport.merged.length,
              contradictions: roReport.contradictions.length,
              test_artifacts: roReport.testArtifacts.length,
              stale: roReport.stale.length,
              low_confidence: roReport.lowConfidence.length,
              dry_run: roReport.dryRun,
            }),
          }],
        };
      }

      case "bootstrap_project": {
        const projectPath = resolveProjectPath(args as Record<string, unknown>);
        const projectName = (args as Record<string, unknown>).projectName as string || basename(projectPath);
        const memDir = join(projectPath, ".project-brain", "memory");
        const created: string[] = [];
        const skipped: string[] = [];

        mkdirSync(memDir, { recursive: true });

        const templates: Record<string, string> = {
          "00_PROJECT_OVERVIEW.md": `# ${projectName}\n\n## Description\n\n_TODO: Describe what this project does._\n\n## Tech Stack\n\n- _Language_: \n- _Framework_: \n- _Database_: \n\n## Quick Start\n\n\`\`\`bash\n# TODO: Add setup commands\n\`\`\`\n`,
          "01_ARCHITECTURE.md": `# Architecture — ${projectName}\n\n## High-Level Overview\n\n_TODO: Describe the system architecture._\n\n## Key Modules\n\n| Module | Purpose |\n|--------|---------|\n| | |\n\n## Data Flow\n\n_TODO: Describe how data flows through the system._\n`,
          "02_CODE_MAP.md": `# Code Map — ${projectName}\n\n## Directory Structure\n\n_TODO: Document the project structure._\n\n## Key Files\n\n| File | Purpose |\n|------|---------|\n| | |\n`,
          "04_LEARNINGS.md": `# Learnings — ${projectName}\n\n_Discoveries, root causes, and non-obvious findings._\n\n---\n\n_No learnings recorded yet._\n`,
          "05_TROUBLESHOOTING.md": `# Troubleshooting — ${projectName}\n\n_Errors encountered and their fixes._\n\n---\n\n_No issues recorded yet._\n`,
          "07_SESSION_HANDOFF.md": `# Session Handoff — ${projectName}\n\n_Auto-updated between sessions._\n\n## Last Session\n\n- **Date**: _not yet_\n- **Branch**: \n- **Status**: Fresh project — no sessions yet\n`,
          "14_OPINIONS.md": `# Opinions — ${projectName}\n\n_Learned patterns and preferences, with confidence scores._\n\n---\n\n_No opinions formed yet._\n`,
        };

        for (const [file, content] of Object.entries(templates)) {
          const filePath = join(memDir, file);
          if (existsSync(filePath)) {
            skipped.push(file);
          } else {
            writeFileSync(filePath, content, "utf-8");
            created.push(file);
          }
        }

        const summary = [
          `**Bootstrapped:** ${projectName}`,
          `**Memory dir:** ${memDir}`,
          created.length > 0 ? `**Created:** ${created.join(", ")}` : "",
          skipped.length > 0 ? `**Skipped (existing):** ${skipped.join(", ")}` : "",
          "",
          "Next: call `index_project` to vectorize the memory for search.",
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text: summary }] };
      }

      case "add_opinion": {
        const aoPath = resolveProjectPath(args as Record<string, unknown>);
        const {
          statement: aoStatement,
          confidence: aoConfidence,
          domain: aoDomain,
        } = args as {
          statement: string;
          confidence?: number;
          domain?: string;
        };
        const aoMemoryDir = resolveWriteMemoryDir(resolve(aoPath));
        const aoResult = addOpinion(
          aoMemoryDir,
          aoStatement,
          aoConfidence ?? 0.7,
          aoDomain || "general",
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify(aoResult),
          }],
        };
      }

      case "reset_project": {
        const rpPath = resolveProjectPath(args as Record<string, unknown>);
        const { confirm: rpConfirm } = args as { confirm?: boolean };

        if (!rpConfirm) {
          return {
            content: [{ type: "text", text: "Error: Set confirm=true to proceed with deletion. This removes vector index and MCP-written memory." }],
            isError: true,
          };
        }

        const rpResult = deleteProjectData(resolve(rpPath));
        if (rpResult.deleted.length === 0) {
          return { content: [{ type: "text", text: `No local data found for project ID ${rpResult.projectId}. Nothing to delete.` }] };
        }
        return {
          content: [{
            type: "text",
            text: `Reset complete for project ID ${rpResult.projectId}. Deleted: ${rpResult.deleted.join(", ")}. The project's .project-brain/ directory was not touched.`,
          }],
        };
      }

      default:
        throw new Error("Unknown tool: " + name);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: "Error: " + (error instanceof Error ? error.message : String(error)),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP RAG Docs server v3.3.0 running on stdio (20 tools)");
}

main().catch(console.error);
