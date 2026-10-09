/**
 * Search LM Tools — extracted from lm-tools.ts
 *
 * Contains: SearchMemoryTool, UnifiedSearchTool
 * These are the two largest individual tool classes (~712 lines combined).
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AdminDB } from "./admin-db";
import { AgentIdentityManager } from "./agent-identity";
import { AutoCapture } from "./auto-capture";
import { AutoRecall } from "./auto-recall";
import type { GlobalKnowledgeManager } from "./global-knowledge";
import {
  extractBestScore,
  formatEntityBFS,
  formatQueryResults,
  parseGraphologyExport,
} from "./graph-utils";
import {
  createActionMarker,
  detectPreferenceSignal,
  getHomeDir,
  getPreferenceHint,
  getProjectIdForTools,
  graphBoostSkills,
  PLAN_RANK,
  skillMatchScore,
} from "./lm-tools-shared";
import type { SaaSClient } from "./saas-client";
import type { SkillManager } from "./skill-manager";

// ═══════════════════════════════════════════════════════════════════
// SEARCH MEMORY TOOL
// ═══════════════════════════════════════════════════════════════════

interface SearchMemoryInput {
  query: string;
  category?: string;
  topic?: string;
}

export class SearchMemoryTool implements vscode.LanguageModelTool<SearchMemoryInput> {
  private saasClient: SaaSClient | null = null;
  private skillManagerRef?: { get: () => SkillManager | null };
  private adminDbRef?: { get: () => AdminDB | null };
  constructor(
    private searchFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>,
    private identityManager: AgentIdentityManager,
    private autoCapture: AutoCapture | null,
    private autoRecall: AutoRecall | null,
    private log: (msg: string) => void,
  ) {}

  setSaaSClient(client: SaaSClient | null): void {
    this.saasClient = client;
  }

  setSkillManagerRef(ref: { get: () => SkillManager | null }): void {
    this.skillManagerRef = ref;
  }

  setAdminDbRef(ref: { get: () => AdminDB | null }): void {
    this.adminDbRef = ref;
  }

  private globalKnowledge: GlobalKnowledgeManager | null = null;
  setGlobalKnowledge(gk: GlobalKnowledgeManager | null): void {
    this.globalKnowledge = gk;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchMemoryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const query = options.input?.query;
    if (!query || query === "undefined" || !query.trim()) {
      this.log("[LM Tool] searchMemory: no query — returning BOOT.md fallback");
      // Fallback: return BOOT.md content instead of erroring
      const folders = vscode.workspace.workspaceFolders;
      if (folders) {
        for (const folder of folders) {
          const bootPath = path.join(folder.uri.fsPath, "docs", "memory", "BOOT.md");
          if (fs.existsSync(bootPath)) {
            const bootContent = fs.readFileSync(bootPath, "utf-8").slice(0, 4000);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                `[Auto-fallback: no query provided — returning project overview]\n\n${bootContent}\n\n` +
                  `TIP: Next time use { "tool": "searchMemory", "query": "your search text" } for targeted results.`,
              ),
            ]);
          }
        }
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No query provided and no BOOT.md found. Use { "tool": "searchMemory", "query": "your search" }.',
        ),
      ]);
    }
    this.log(`[LM Tool] searchMemory: "${query}"`);

    // —— /strategy prefix: redirect to strategyPicker tool ——
    const strategyMatch = query.match(/^\/strategy\s+(.+)/i);
    if (strategyMatch) {
      const rawArgs = strategyMatch[1].trim();

      // Parse optional --strategyName flag
      const flagMatch = rawArgs.match(/^(.+?)\s+--\s*(.+)$/s);
      const task = flagMatch ? flagMatch[1].trim() : rawArgs;
      const preselected = flagMatch ? flagMatch[2].trim() : null;

      this.log(
        `[LM Tool] searchMemory: /strategy prefix detected → task="${task}"${preselected ? ` preselected="${preselected}"` : ""}`,
      );
      const escapedTask = task.replace(/"/g, '\\"');

      let msg: string;
      if (preselected) {
        const escapedStrategy = preselected.replace(/"/g, '\\"');
        msg = [
          `## 🎯 Strategy mode activated (pre-selected)`,
          ``,
          `**Task:** ${task}`,
          `**Strategy hint:** ${preselected}`,
          ``,
          `**[MANDATORY INSTRUCTION]** Call \`projectBrain_toolbox\` with \`{ tool: "strategyPicker", task: "${escapedTask}", selectedStrategy: "${escapedStrategy}" }\`. The tool handles fuzzy matching, refinement questions (native input boxes), and returns the complete procedure. Just call it once and follow the result VERBATIM.`,
        ].join("\n");
      } else {
        msg = [
          `## 🎯 Strategy mode activated`,
          ``,
          `**Task:** ${task}`,
          ``,
          `**[MANDATORY INSTRUCTION]** Call \`projectBrain_toolbox\` with \`{ tool: "strategyPicker", task: "${escapedTask}" }\` (do NOT include selectedStrategy). The tool will show a native VS Code quick pick for strategy selection and refinement input boxes — all handled automatically. You only need ONE tool call. Follow the returned procedure VERBATIM.`,
        ].join("\n");
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(msg),
      ]);
    }

    try {
      const searchOpts = {
        ...(options.input?.category && { category: options.input.category }),
        ...(options.input?.topic && { topic: options.input.topic }),
      };
      const results = await this.searchFn(query, Object.keys(searchOpts).length ? searchOpts : undefined);

      // Build identity prefix (Pro+ only — free tier gets plain results)
      const currentPlan = this.saasClient?.currentPlan ?? "free";
      const hasPersonality = PLAN_RANK[currentPlan] >= PLAN_RANK["pro"];
      const identity = hasPersonality
        ? this.identityManager.loadIdentity()
        : null;
      const soul = hasPersonality ? this.identityManager.loadSoul() : null;
      const essence = hasPersonality
        ? this.identityManager.extractProjectEssence()
        : null;
      let prefix = "";
      if (identity) {
        prefix = `[Agent: "${identity.name}" ${identity.emoji}, ${identity.creature}. Vibe: ${identity.vibe}. Lang: ${identity.language}.`;
        if (essence) {
          prefix += ` Project: ${essence.projectType} (${essence.languages.join(", ")}).`;
        }
        if (soul) {
          prefix += ` Tone: ${soul.tone}. Approach: ${soul.approach}.`;
        }
        prefix += "]\n\n";
      }

      // Auto-recall context on first search (Pro+ only — contains identity data)
      let recallContext = "";
      const recallPlan = this.saasClient?.currentPlan ?? "free";
      if (this.autoRecall && PLAN_RANK[recallPlan] >= PLAN_RANK["pro"]) {
        recallContext = await this.autoRecall.getAutoRecallContextAsync();
        if (recallContext) recallContext += "\n\n";
      }

      // Phase 5: Inject user preferences (detect BEFORE reading hint)
      detectPreferenceSignal(query, this.log);
      const prefHint = getPreferenceHint();

      // Global knowledge enrichment (cross-project, excluding own entries)
      let globalHints = "";
      if (this.globalKnowledge) {
        try {
          const currentProject =
            vscode.workspace.workspaceFolders?.[0]?.name ?? "";
          const globalMatches = this.globalKnowledge
            .search(query, 5)
            .filter((e) => e.source !== currentProject);
          if (globalMatches.length > 0) {
            const lines = globalMatches.map(
              (e) =>
                `- ${e.content} _(from: ${e.source}${e.confidence ? `, conf: ${e.confidence.toFixed(1)}` : ""})_`,
            );
            globalHints = `\n\n🌐 **Cross-Project Knowledge:**\n${lines.join("\n")}`;
          }
        } catch (err) {
          this.log(`[LM Tool] searchMemory: global knowledge error: ${err}`);
        }
      }

      const output =
        recallContext +
        prefHint +
        prefix +
        (results || "No results found.") +
        globalHints;

      // NOTE: We intentionally do NOT auto-capture from search results.
      // Search results already include auto-recalled opinions, so capturing
      // them would create a feedback loop where opinions reinforce themselves
      // via their own search results (self-inflation bug found in audit 2026-02-15).

      // Action suggestions for follow-up exploration
      const actionHints = [
        createActionMarker({
          tool: "searchRelations",
          params: { query, mode: "entity" },
          label: `Explore "${query}" in knowledge graph`,
        }),
        createActionMarker({
          tool: "memoryHistory",
          params: { mode: "target", query },
          label: `View change history for "${query}"`,
        }),
      ].join("\n");

      // Skill recommendations: match query words against available skills
      let skillHints = "";
      const sm = this.skillManagerRef?.get();
      if (sm) {
        const queryWords = query
          .toLowerCase()
          .split(/[\s\-_,]+/)
          .filter((w) => w.length > 1);
        if (queryWords.length > 0) {
          const allSkills = sm.getAll();
          const scored = allSkills
            .map((s) => {
              let score = 0;
              let coverage = 0;
              const name = s.manifest.name.toLowerCase();
              const desc = s.manifest.description.toLowerCase();
              for (const word of queryWords) {
                const ns = skillMatchScore(word, name, true);
                const ds = skillMatchScore(word, desc, false);
                score += ns + ds;
                if (ns > 0 || ds > 0) coverage++;
              }
              return { skill: s, score, coverage, graphBoost: 0 };
            })
            .filter((s) => s.score > 0);

          // Apply graph-based semantic boost before sorting
          const homeDir = getHomeDir();
          const projectPath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
          if (homeDir && projectPath) {
            const projectId = getProjectIdForTools(projectPath);
            graphBoostSkills(scored, query, homeDir, projectId, this.log);
          }

          scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
          const topScored = scored.slice(0, 3);

          if (topScored.length > 0) {
            const lines = topScored.map(
              (s) =>
                `  • **${s.skill.manifest.name}** — ${s.skill.manifest.description.substring(0, 120)}${s.graphBoost > 0 ? " 🔗" : ""}`,
            );
            skillHints = `\n\n📋 **Relevant skills** (use \`findSkill("name")\` to load):\n${lines.join("\n")}`;
            this.log(
              `[LM Tool] searchMemory: matched ${topScored.length} skill(s) for "${query}"`,
            );

            // Admin logging: log each matched skill
            const db = this.adminDbRef?.get();
            if (db) {
              for (const s of topScored) {
                db.logExecution({
                  skillName: s.skill.manifest.name,
                  trigger: "searchMemory",
                  result: "injected",
                  matchScore: s.score,
                  query,
                }).catch(() => {});
              }
            }
          }
        }
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          output + skillHints + actionHints,
        ),
      ]);
    } catch (err) {
      this.log(`[LM Tool] searchMemory error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Search failed: ${err}`),
      ]);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// UNIFIED SEARCH TOOL
// ═══════════════════════════════════════════════════════════════════

/** Temporal keywords that trigger history enrichment. */
const TEMPORAL_KEYWORDS =
  /\b(cuándo|cuando|último|ultima|reciente|histor|cambio|ayer|hoy|semana|month|week|today|yesterday|recent|last|changed|history|modified|updated)\b/i;

/** Threshold below which graph enrichment is triggered in quick mode. */
const QUICK_GRAPH_THRESHOLD = 0.6;

/** Threshold below which auto mode escalates to deep. */
const AUTO_ESCALATION_THRESHOLD = 0.4;

/** Max results per source in deep mode. */
const DEEP_MAX_PER_SOURCE = 2;

/** Character cap for deep mode output. */
const DEEP_CHAR_CAP = 2000;

type SearchMode = "auto" | "quick" | "deep";
const VALID_MODES: readonly SearchMode[] = ["auto", "quick", "deep"];

interface UnifiedSearchInput {
  query: string;
  mode?: string;
}

/**
 * Unified search tool — merges smartSearch (fallback chain) and deepSearch (fused multi-source).
 *
 * Modes:
 * - quick: Memory first, graph fallback if <60%, history if temporal keywords.
 * - deep: All 3 sources in parallel, dedup, cap output.
 * - auto (default): Runs quick; if best score <40%, auto-escalates to deep
 *   reusing the memory result already obtained (no duplicate RAG call).
 */
export class UnifiedSearchTool implements vscode.LanguageModelTool<UnifiedSearchInput> {
  constructor(
    private searchFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>,
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<UnifiedSearchInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query } = options.input;
    const rawMode = options.input.mode || "auto";
    const mode: SearchMode = VALID_MODES.includes(rawMode as SearchMode)
      ? (rawMode as SearchMode)
      : "auto";
    this.log(`[LM Tool] search(${mode}): "${query}"`);

    // Phase 5: Inject user preferences (detect BEFORE reading hint)
    detectPreferenceSignal(query, this.log);
    const prefHint = getPreferenceHint();

    // Precompute shared path info once
    const homeDir = getHomeDir();
    const projectPath = this.workspaceFolder.uri.fsPath;
    const projectId = getProjectIdForTools(projectPath);

    if (mode === "deep") {
      return this.runDeep(query, prefHint, null, homeDir, projectId, token);
    }

    // —— Quick mode (or auto phase 1) ——
    const quickResult = await this.runQuick(query, homeDir, projectId, token);

    if (mode === "quick") {
      const output = prefHint + quickResult.output;
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    }

    // —— Auto mode: escalate if needed ——
    if (quickResult.bestScore < AUTO_ESCALATION_THRESHOLD) {
      if (token.isCancellationRequested) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("Search cancelled."),
        ]);
      }
      this.log(
        `[LM Tool] search(auto): score ${(quickResult.bestScore * 100).toFixed(1)}% < ${AUTO_ESCALATION_THRESHOLD * 100}% — escalating to deep (reusing memory)`,
      );
      return this.runDeep(
        query,
        prefHint,
        quickResult.memoryOutput,
        homeDir,
        projectId,
        token,
      );
    }

    const output = prefHint + quickResult.output;
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(output),
    ]);
  }

  // —— Quick mode implementation ————————————————————————————————————

  private async runQuick(
    query: string,
    homeDir: string,
    projectId: string,
    token: vscode.CancellationToken,
  ): Promise<{ output: string; bestScore: number; memoryOutput: string }> {
    const sections: string[] = [];
    let memoryOutput = "";

    // Phase 1: Always search memory first
    try {
      memoryOutput = await this.searchFn(query);
      sections.push(memoryOutput || "No memory results found.");
    } catch (err) {
      this.log(`[LM Tool] search(quick) memory error: ${err}`);
      sections.push(`Memory search failed: ${err}`);
    }

    if (token.isCancellationRequested) {
      return { output: sections.join("\n"), bestScore: 1, memoryOutput };
    }

    const bestScore = extractBestScore(memoryOutput);

    // Phase 2: Enrich with graph if score < threshold (simple BFS only)
    if (bestScore < QUICK_GRAPH_THRESHOLD) {
      this.log(
        `[LM Tool] search(quick): score ${(bestScore * 100).toFixed(1)}% < ${QUICK_GRAPH_THRESHOLD * 100}% — enriching with graph`,
      );
      const graphResult = this.searchGraphQuick(query, homeDir, projectId);
      if (graphResult) {
        sections.push(
          `\n---\n## 🔗 Graph Enrichment (score ${(bestScore * 100).toFixed(1)}% < ${QUICK_GRAPH_THRESHOLD * 100}%)\n\n${graphResult}`,
        );
      }
    }

    // Phase 3: Add history if temporal query (last 5, no filtering)
    if (!token.isCancellationRequested && TEMPORAL_KEYWORDS.test(query)) {
      this.log(`[LM Tool] search(quick): temporal keywords — adding history`);
      const historyResult = this.searchHistoryQuick(homeDir, projectId);
      if (historyResult) {
        sections.push(`\n---\n## 📜 History Context\n\n${historyResult}`);
      }
    }

    return { output: sections.join("\n"), bestScore, memoryOutput };
  }

  // —— Deep mode implementation —————————————————————————————————————

  /**
   * @param existingMemory If provided, reuses this result instead of calling searchFn again
   *                       (used by auto-escalation to avoid duplicate RAG calls).
   */
  private async runDeep(
    query: string,
    prefHint: string,
    existingMemory: string | null,
    homeDir: string,
    projectId: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // Gather sources — reuse memory if already available
    const memoryPromise =
      existingMemory !== null
        ? Promise.resolve(existingMemory || null)
        : this.searchFn(query)
            .then((r) => r || null)
            .catch(() => null);

    const [memoryResult, graphResult, historyResult] = await Promise.allSettled(
      [
        memoryPromise,
        this.searchGraphDeep(query, homeDir, projectId),
        this.searchHistoryDeep(query, homeDir, projectId),
      ],
    );

    const sections: string[] = [];
    const seenPaths = new Set<string>();
    let totalChars = 0;

    if (token.isCancellationRequested) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("Search cancelled."),
      ]);
    }

    // Process memory (header length included in totalChars)
    if (memoryResult.status === "fulfilled" && memoryResult.value) {
      const memorySection = this.dedup(
        memoryResult.value,
        seenPaths,
        DEEP_MAX_PER_SOURCE,
      );
      if (memorySection) {
        const block = `## 📚 Memory Search\n\n${memorySection}`;
        sections.push(block);
        totalChars += block.length;
      }
    } else if (memoryResult.status === "rejected") {
      this.log(
        `[LM Tool] search(deep): memory failed — ${memoryResult.reason}`,
      );
      sections.push(
        `## 📚 Memory Search\n\n⚠️ Unavailable: ${memoryResult.reason}`,
      );
    }

    // Process graph
    if (totalChars < DEEP_CHAR_CAP) {
      if (graphResult.status === "fulfilled" && graphResult.value) {
        const header = `## 🔗 Knowledge Graph\n\n`;
        const remaining = DEEP_CHAR_CAP - totalChars - header.length;
        if (remaining > 0) {
          const graphSection = this.truncate(graphResult.value, remaining);
          const block = header + graphSection;
          sections.push(block);
          totalChars += block.length;
        }
      } else if (graphResult.status === "rejected") {
        this.log(
          `[LM Tool] search(deep): graph failed — ${graphResult.reason}`,
        );
      }
    }

    // Process history
    if (totalChars < DEEP_CHAR_CAP) {
      if (historyResult.status === "fulfilled" && historyResult.value) {
        const header = `## 📜 Change History\n\n`;
        const remaining = DEEP_CHAR_CAP - totalChars - header.length;
        if (remaining > 0) {
          const historySection = this.truncate(historyResult.value, remaining);
          const block = header + historySection;
          sections.push(block);
          totalChars += block.length;
        }
      } else if (historyResult.status === "rejected") {
        this.log(
          `[LM Tool] search(deep): history failed — ${historyResult.reason}`,
        );
      }
    }

    if (sections.length === 0) {
      sections.push("No results found from any source.");
    }

    // Summary header
    const sourcesUsed = [
      memoryResult.status === "fulfilled" && memoryResult.value
        ? "memory"
        : null,
      graphResult.status === "fulfilled" && graphResult.value ? "graph" : null,
      historyResult.status === "fulfilled" && historyResult.value
        ? "history"
        : null,
    ].filter(Boolean);

    const sourcesFailed = [
      memoryResult.status === "rejected" ? "memory" : null,
      graphResult.status === "rejected" ? "graph" : null,
      historyResult.status === "rejected" ? "history" : null,
    ].filter(Boolean);

    const header = [
      `# Search (deep): "${query}"`,
      `**Sources:** ${sourcesUsed.join(", ") || "none"}${sourcesFailed.length ? ` | ⚠️ Failed: ${sourcesFailed.join(", ")}` : ""}`,
      `**Total chars:** ${totalChars}/${DEEP_CHAR_CAP}`,
      "",
    ].join("\n");

    const output = prefHint + header + sections.join("\n\n---\n\n");
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(output),
    ]);
  }

  // —— Graph helpers (quick vs deep variants) ———————————————————————

  /** Quick mode: simple BFS only. */
  private searchGraphQuick(
    query: string,
    homeDir: string,
    projectId: string,
  ): string | null {
    try {
      const graphPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.graph.json`,
      );

      if (!fs.existsSync(graphPath)) return null;

      const raw = fs.readFileSync(graphPath, "utf-8");
      const graph = parseGraphologyExport(JSON.parse(raw));
      return formatEntityBFS(graph, query, 2);
    } catch (err) {
      this.log(`[LM Tool] search(quick) graph error: ${err}`);
      return null;
    }
  }

  /** Deep mode: BFS + query fallback, picks the more informative result. */
  private searchGraphDeep(
    query: string,
    homeDir: string,
    projectId: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const graphPath = path.join(
          homeDir,
          ".mcp-rag-docs",
          `${projectId}.graph.json`,
        );
        if (!fs.existsSync(graphPath)) {
          resolve(null);
          return;
        }

        const raw = fs.readFileSync(graphPath, "utf-8");
        const graph = parseGraphologyExport(JSON.parse(raw));

        const bfs = formatEntityBFS(graph, query, 2);
        const queryRes = formatQueryResults(graph, query);

        if (bfs.includes("No entity found")) {
          resolve(
            queryRes.includes("Matching Nodes: 0") &&
              queryRes.includes("Matching Edges: 0")
              ? null
              : queryRes,
          );
        } else {
          resolve(bfs);
        }
      } catch (err) {
        this.log(`[LM Tool] search(deep) graph error: ${err}`);
        resolve(null);
      }
    });
  }

  // —— History helpers (quick vs deep variants) —————————————————————

  /** Quick mode: last 5 entries, no query filtering. */
  private searchHistoryQuick(
    homeDir: string,
    projectId: string,
  ): string | null {
    try {
      const historyPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.history.json`,
      );

      if (!fs.existsSync(historyPath)) return null;

      const raw = fs.readFileSync(historyPath, "utf-8");
      const history: {
        entries: Array<{
          file: string;
          timestamp: number;
          action: string;
          chunks?: number;
        }>;
      } = JSON.parse(raw);
      const sorted = [...history.entries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);

      if (sorted.length === 0) return null;

      const lines = [`**Recent changes (last 5):**`];
      for (const entry of sorted) {
        const date = new Date(entry.timestamp).toISOString();
        const emoji =
          entry.action === "added"
            ? "➕"
            : entry.action === "deleted"
              ? "🗑️"
              : "✏️";
        lines.push(`${emoji} \`${entry.file}\` — ${entry.action} — ${date}`);
      }
      return lines.join("\n");
    } catch (err) {
      this.log(`[LM Tool] search(quick) history error: ${err}`);
      return null;
    }
  }

  /** Deep mode: filter by query relevance first, fall back to most recent. */
  private searchHistoryDeep(
    query: string,
    homeDir: string,
    projectId: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const historyPath = path.join(
          homeDir,
          ".mcp-rag-docs",
          `${projectId}.history.json`,
        );
        if (!fs.existsSync(historyPath)) {
          resolve(null);
          return;
        }

        const raw = fs.readFileSync(historyPath, "utf-8");
        const history: {
          entries: Array<{
            file: string;
            timestamp: number;
            action: string;
            chunks?: number;
          }>;
        } = JSON.parse(raw);

        const q = query.toLowerCase();
        const relevant = history.entries
          .filter((e) => e.file.toLowerCase().includes(q))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 5);

        const entries =
          relevant.length > 0
            ? relevant
            : [...history.entries]
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 5);

        if (entries.length === 0) {
          resolve(null);
          return;
        }

        const lines = entries.map((e) => {
          const date = new Date(e.timestamp).toISOString();
          const emoji =
            e.action === "added" ? "➕" : e.action === "deleted" ? "🗑️" : "✏️";
          return `${emoji} \`${e.file}\` — ${e.action} — ${date}`;
        });

        resolve(lines.join("\n"));
      } catch (err) {
        this.log(`[LM Tool] search(deep) history error: ${err}`);
        resolve(null);
      }
    });
  }

  // —— Shared helpers ———————————————————————————————————————————————

  /** Deduplicate results by file path, capping at maxResults. */
  private dedup(
    text: string,
    seenPaths: Set<string>,
    maxResults: number,
  ): string | null {
    const blocks = text.split(/^---$/m).filter((b) => b.trim());
    const unique: string[] = [];

    for (const block of blocks) {
      const pathMatch = block.match(/##\s*Result\s*\d+:\s*(.+)/);
      if (pathMatch) {
        const filePath = pathMatch[1].trim();
        if (seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);
      }
      unique.push(block.trim());
      if (unique.length >= maxResults) break;
    }

    return unique.length > 0 ? unique.join("\n\n---\n\n") : null;
  }

  /** Truncate text to maxChars, cutting at last complete line. */
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf("\n");
    return (
      (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
      "\n... (truncated)"
    );
  }
}
