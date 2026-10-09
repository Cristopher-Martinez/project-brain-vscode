/**
 * Strategy Tools  extracted from lm-tools.ts
 *
 * StrategyPickerTool: graph-ranked implementation strategies with refinement flow
 * StrategyFinalizeTool: marks strategy as ready to close
 * StrategyCompleteTool: mechanical closing protocol (satisfaction + auto-commit)
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  parseGraphologyExport,
  rankStrategies,
  type StrategyDefinition,
} from "./graph-utils";
import { getHomeDir, getProjectIdForTools } from "./lm-tools-shared";

const execFileAsync = promisify(execFile);

//
// STRATEGY TYPES
//

export interface StrategyPickerInput {
  task: string;
  selectedStrategy?: string;
  maxResults?: number;
}

export interface StrategyCatalogEntry {
  name: string;
  version: string;
  description: string;
  tags: string[];
  prompt: string;
  applicability: {
    recommended_when: string[];
  };
  execution_protocol: {
    mandatory_flow: string[];
    rollback_policy: string;
    exit_criteria: string[];
  };
  refinementQuestions?: string[];
  content?: string;
}

//  Strategy Picker

interface LoadedStrategy {
  def: StrategyDefinition;
  version: string;
  prompt: string;
  applicability: {
    recommended_when: string[];
  };
  executionProtocol: {
    mandatoryFlow: string[];
    rollbackPolicy: string;
    exitCriteria: string[];
  };
  content: string;
  refinementQuestions?: string[];
}

export class StrategyPickerTool implements vscode.LanguageModelTool<StrategyPickerInput> {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private memoryPath: string,
    private extensionPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StrategyPickerInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { task, selectedStrategy, maxResults = 5 } = options.input;

    if (!task || task.trim().length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          '❌ Parameter "task" is required. Describe the delegated task.',
        ),
      ]);
    }

    this.log(
      `[LM Tool] strategyPicker: task="${task.slice(0, 80)}" selected=${selectedStrategy ?? "none"}`,
    );

    // ── Load strategies ──
    const strategies = this.loadStrategies();

    if (strategies.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "No strategies found. Define them in .project-brain/memory/skills/strategies/STRATEGIES.json or static/skills/strategies/STRATEGIES.json.",
        ),
      ]);
    }

    // ── Phase 2: Refinement (strategy already selected / pre-selected via --flag) ──
    if (selectedStrategy) {
      const resolved = this.resolveStrategyName(selectedStrategy, strategies);
      if (resolved) {
        this.log(
          `[LM Tool] strategyPicker: resolved "${selectedStrategy}" → "${resolved}"`,
        );
        return await this.handleRefinement(resolved, strategies);
      }
      // No match — fall through to ranking
      this.log(
        `[LM Tool] strategyPicker: selectedStrategy "${selectedStrategy.slice(0, 60)}" did not match any strategy name. Falling through to ranking.`,
      );
    }

    // ── Phase 1: Native Quick Pick → Refinement → Complete instruction ──
    return await this.handleRanking(task, strategies, maxResults);
  }

  private async handleRanking(
    task: string,
    strategies: LoadedStrategy[],
    maxResults: number,
  ): Promise<vscode.LanguageModelToolResult> {
    // Load knowledge graph if it exists
    const graph = this.loadGraph();
    const graphAvailable = graph !== null && graph.nodes.length > 0;

    // Rank strategies
    const ranked = rankStrategies(
      task,
      strategies.map((s) => s.def),
      graph,
    );
    const rankedByName = new Map(
      ranked.map((item) => [item.strategy.name.toLowerCase(), item]),
    );

    const generalStrategies = strategies.filter((s) =>
      s.def.tags.some((tag) => tag.toLowerCase() === "general"),
    );
    const generalNames = new Set(
      generalStrategies.map((s) => s.def.name.toLowerCase()),
    );

    // Build combined list: top contextual + all general (no cap needed — native quick pick has no limit)
    const topContextual = ranked
      .filter((item) => !generalNames.has(item.strategy.name.toLowerCase()))
      .slice(0, maxResults);

    const top = [...topContextual];
    for (const strategy of generalStrategies) {
      const existing = top.find(
        (item) =>
          item.strategy.name.toLowerCase() === strategy.def.name.toLowerCase(),
      );
      if (!existing) {
        const rankedItem = rankedByName.get(strategy.def.name.toLowerCase());
        top.push(
          rankedItem ?? {
            strategy: strategy.def,
            score: 0,
            keywordScore: 0,
            graphScore: 0,
            matchedKeywords: [],
            graphPaths: 0,
          },
        );
      }
    }

    // ── Native Quick Pick — guaranteed to appear, no option limit ──
    const quickPickItems: vscode.QuickPickItem[] = top.map((r) => {
      const isGeneral = r.strategy.tags.some(
        (t) => t.toLowerCase() === "general",
      );
      return {
        label: `${isGeneral ? "$(globe) " : ""}${r.strategy.name}`,
        description: `score: ${r.score.toFixed(2)}${isGeneral ? " [general]" : ""}`,
        detail: r.strategy.description,
      };
    });

    this.log(
      `[LM Tool] strategyPicker: showing native quick pick with ${quickPickItems.length} options`,
    );

    const chosen = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: `🎯 ¿Qué estrategia para "${task.slice(0, 60)}"?`,
      title: "Strategy Picker — Project Brain",
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!chosen) {
      this.log(`[LM Tool] strategyPicker: user cancelled quick pick`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⚠️ El usuario canceló la selección de estrategia. Pregúntale cómo quiere proceder.",
        ),
      ]);
    }

    // Extract strategy name (strip codicon prefix if present)
    const chosenName = chosen.label.replace(/^\$\([^)]+\)\s*/, "").trim();
    this.log(
      `[LM Tool] strategyPicker: user selected "${chosenName}" via native quick pick`,
    );

    // Chain directly into refinement — no second tool call needed
    return await this.handleRefinement(chosenName, strategies);
  }

  private async handleRefinement(
    selectedStrategy: string,
    strategies: LoadedStrategy[],
  ): Promise<vscode.LanguageModelToolResult> {
    const strategy = strategies.find(
      (s) => s.def.name.toLowerCase() === selectedStrategy.toLowerCase(),
    );

    if (!strategy) {
      const available = strategies.map((s) => s.def.name).join(", ");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ Strategy "${selectedStrategy}" not found. Available: ${available}`,
        ),
      ]);
    }

    // ── Collect refinement answers via native showInputBox ──
    const refinementAnswers: { question: string; answer: string }[] = [];

    if (
      strategy.refinementQuestions &&
      strategy.refinementQuestions.length > 0
    ) {
      this.log(
        `[LM Tool] strategyPicker: showing ${strategy.refinementQuestions.length} refinement questions via native input boxes`,
      );

      for (let i = 0; i < strategy.refinementQuestions.length; i++) {
        const question = strategy.refinementQuestions[i];
        const answer = await vscode.window.showInputBox({
          prompt: question,
          title: `${strategy.def.name} — Pregunta ${i + 1}/${strategy.refinementQuestions.length}`,
          placeHolder: "Escribe tu respuesta (Enter para saltar)",
          ignoreFocusOut: true,
        });

        if (answer === undefined) {
          // User pressed Escape — stop collecting, proceed with what we have
          this.log(
            `[LM Tool] strategyPicker: user cancelled at refinement question ${i + 1}`,
          );
          break;
        }

        if (answer.trim().length > 0) {
          refinementAnswers.push({ question, answer: answer.trim() });
        }
      }
    }

    // ── Build complete instruction with strategy prompt + user context ──
    let output = `[INSTRUCTION] Strategy "${strategy.def.name}" activated. Follow the instructions below VERBATIM — do not summarize, simulate, or reinterpret them. Execute each step as a real action using your available tools.\n\n${strategy.prompt}`;

    if (refinementAnswers.length > 0) {
      const answersBlock = refinementAnswers
        .map((qa) => `**${qa.question}**\n→ ${qa.answer}`)
        .join("\n\n");
      output += `\n\n---\n## Contexto del usuario (respuestas de refinamiento)\n\n${answersBlock}\n\nUsa estas respuestas como contexto obligatorio para la ejecución de la estrategia.`;
    }

    // ── Append mechanical closing instruction ──
    output += `\n\n---\n## FINALIZATION (MANDATORY)\nWhen you complete ALL steps of this strategy, FIRST call \`projectBrain_toolbox\` with \`{ "tool": "strategyFinalize" }\`, THEN call \`projectBrain_toolbox\` with \`{ "tool": "strategyComplete" }\`. This ensures the satisfaction check happens only at the very end (right before stop) — do NOT simulate these steps yourself, just call the tools.`;

    // Persist FULL output (strategy + refinement + FINALIZATION) so PostToolUse hook re-injects it on every tool call
    try {
      const sessionsDir = path.join(this.memoryPath, "sessions");
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(sessionsDir, "active-strategy.txt"),
        output,
        "utf-8",
      );
      this.log(
        `[LM Tool] strategyPicker: persisted active strategy "${strategy.def.name}" WITH finalization for hook injection`,
      );
    } catch (err) {
      this.log(`[LM Tool] strategyPicker: failed to persist strategy: ${err}`);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(output),
    ]);
  }

  /**
   * Resolve a user-provided strategy name to an exact catalog name.
   * All fuzzy matches require ≥50% character overlap to qualify.
   * Returns null if no reasonable match (avoids matching task descriptions).
   */
  private resolveStrategyName(
    input: string,
    strategies: LoadedStrategy[],
  ): string | null {
    const lower = input.toLowerCase().trim();
    const names = strategies.map((s) => s.def.name);

    // 1. Exact match (case-insensitive) — 100% confidence
    const exact = names.find((n) => n.toLowerCase() === lower);
    if (exact) return exact;

    // Reject if input looks like a task description (too many words)
    if (lower.split(/\s+/).length > 4) return null;

    // Helper: character overlap ratio between two strings (0..1)
    const charOverlap = (a: string, b: string): number => {
      const short = a.length <= b.length ? a : b;
      const long = a.length > b.length ? a : b;
      if (long.length === 0) return 0;
      // Count matching characters (order-preserving substring match)
      let matches = 0;
      let lastIdx = -1;
      for (const ch of short) {
        const idx = long.indexOf(ch, lastIdx + 1);
        if (idx !== -1) {
          matches++;
          lastIdx = idx;
        }
      }
      return matches / long.length;
    };

    // 2. Starts with — must cover ≥50% of name length
    const startsWith = names.filter((n) => {
      const nl = n.toLowerCase();
      return nl.startsWith(lower) && lower.length / nl.length >= 0.5;
    });
    if (startsWith.length === 1) return startsWith[0];

    // 3. Contains — input must be ≥50% of name length
    const contains = names.filter((n) => {
      const nl = n.toLowerCase();
      return nl.includes(lower) && lower.length / nl.length >= 0.5;
    });
    if (contains.length === 1) return contains[0];

    // 4. Input contains strategy name — name must be ≥50% of input length
    const reverseContains = names.filter((n) => {
      const nl = n.toLowerCase();
      return lower.includes(nl) && nl.length / lower.length >= 0.5;
    });
    if (reverseContains.length === 1) return reverseContains[0];

    // 5. Word overlap + character overlap — best match ≥50%
    const inputWords = new Set(lower.split(/[\s\-_]+/).filter(Boolean));
    let bestMatch: string | null = null;
    let bestScore = 0;
    for (const name of names) {
      const nl = name.toLowerCase();
      const nameWords = nl.split(/[\s\-_]+/).filter(Boolean);
      const wordOverlap = nameWords.filter((w) => inputWords.has(w)).length;
      const wordScore = wordOverlap / Math.max(nameWords.length, 1);
      const charScore = charOverlap(lower, nl);
      const combined = Math.max(wordScore, charScore);
      if (combined > bestScore && combined >= 0.5) {
        bestScore = combined;
        bestMatch = name;
      }
    }
    return bestMatch;
  }

  /**
   * Higher-order loader for strategy catalog.
   * Single source of truth: STRATEGIES.json (local override -> bundled fallback).
   */
  private withStrategyCatalog<T>(
    callback: (entries: StrategyCatalogEntry[]) => T,
  ): T {
    const candidatePaths = [
      path.join(this.memoryPath, "skills", "strategies", "STRATEGIES.json"),
      path.join(
        this.extensionPath,
        "static",
        "skills",
        "strategies",
        "STRATEGIES.json",
      ),
    ];

    for (const catalogPath of candidatePaths) {
      if (!fs.existsSync(catalogPath)) continue;

      try {
        const raw = fs.readFileSync(catalogPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;

        const entries = parsed
          .filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === "object",
          )
          .map((item) => ({
            name: String(item.name ?? "").trim(),
            version: String(item.version ?? "1.0.0").trim(),
            description: String(item.description ?? "").trim(),
            tags: Array.isArray(item.tags)
              ? item.tags.map((tag) => String(tag).trim()).filter(Boolean)
              : [],
            prompt: String(item.prompt ?? "").trim(),
            applicability: {
              recommended_when: Array.isArray(
                (
                  item.applicability as
                    | { recommended_when?: unknown[] }
                    | undefined
                )?.recommended_when,
              )
                ? (
                    (item.applicability as { recommended_when?: unknown[] })
                      .recommended_when ?? []
                  )
                    .map((value) => String(value).trim())
                    .filter(Boolean)
                : [],
            },
            execution_protocol: {
              mandatory_flow: Array.isArray(
                (
                  item.execution_protocol as
                    | { mandatory_flow?: unknown[] }
                    | undefined
                )?.mandatory_flow,
              )
                ? (
                    (item.execution_protocol as { mandatory_flow?: unknown[] })
                      .mandatory_flow ?? []
                  )
                    .map((value) => String(value).trim())
                    .filter(Boolean)
                : [],
              rollback_policy: String(
                (
                  item.execution_protocol as
                    | { rollback_policy?: unknown }
                    | undefined
                )?.rollback_policy ?? "",
              ).trim(),
              exit_criteria: Array.isArray(
                (
                  item.execution_protocol as
                    | { exit_criteria?: unknown[] }
                    | undefined
                )?.exit_criteria,
              )
                ? (
                    (item.execution_protocol as { exit_criteria?: unknown[] })
                      .exit_criteria ?? []
                  )
                    .map((value) => String(value).trim())
                    .filter(Boolean)
                : [],
            },
            refinementQuestions: Array.isArray(item.refinementQuestions)
              ? item.refinementQuestions
                  .map((q) => String(q).trim())
                  .filter(Boolean)
              : undefined,
            content: String(item.content ?? "").trim() || undefined,
          }))
          .filter(
            (item) =>
              item.name.length > 0 &&
              item.version.length > 0 &&
              item.description.length > 0 &&
              item.prompt.length > 0 &&
              item.applicability.recommended_when.length > 0 &&
              item.execution_protocol.mandatory_flow.length > 0 &&
              item.execution_protocol.rollback_policy.length > 0 &&
              item.execution_protocol.exit_criteria.length > 0,
          );

        if (entries.length > 0) {
          this.log(
            `[LM Tool] strategyPicker: loaded ${entries.length} strategies from ${catalogPath}`,
          );
          return callback(entries);
        }
      } catch (err) {
        this.log(
          `[LM Tool] strategyPicker: invalid strategy catalog ${catalogPath}: ${err}`,
        );
      }
    }

    return callback([]);
  }

  /** Load strategy definitions from single-file catalog. */
  private loadStrategies(): LoadedStrategy[] {
    return this.withStrategyCatalog((entries) =>
      entries.map((entry) => ({
        def: {
          name: entry.name,
          description: entry.description,
          tags: entry.tags,
        },
        version: entry.version,
        prompt: entry.prompt,
        applicability: {
          recommended_when: entry.applicability.recommended_when,
        },
        executionProtocol: {
          mandatoryFlow: entry.execution_protocol.mandatory_flow,
          rollbackPolicy: entry.execution_protocol.rollback_policy,
          exitCriteria: entry.execution_protocol.exit_criteria,
        },
        content: entry.content ?? this.buildStrategyContentFromSchema(entry),
        refinementQuestions: entry.refinementQuestions,
      })),
    );
  }

  private buildStrategyContentFromSchema(entry: StrategyCatalogEntry): string {
    const lines: string[] = [
      `## ${entry.name}`,
      "",
      "### Applicability",
      ...entry.applicability.recommended_when.map((item) => `- ${item}`),
      "",
      "### Mandatory Flow",
      ...entry.execution_protocol.mandatory_flow.map(
        (item, index) => `${index + 1}. ${item}`,
      ),
      "",
      "### Rollback Policy",
      entry.execution_protocol.rollback_policy,
      "",
      "### Exit Criteria",
      ...entry.execution_protocol.exit_criteria.map((item) => `- ${item}`),
    ];

    return lines.join("\n");
  }

  private renderStrategyReference(strategy: LoadedStrategy): string {
    return strategy.content && strategy.content.trim().length > 0
      ? strategy.content
      : this.buildStrategyContentFromSchema({
          name: strategy.def.name,
          version: strategy.version,
          description: strategy.def.description,
          tags: strategy.def.tags,
          prompt: strategy.prompt,
          applicability: strategy.applicability,
          execution_protocol: {
            mandatory_flow: strategy.executionProtocol.mandatoryFlow,
            rollback_policy: strategy.executionProtocol.rollbackPolicy,
            exit_criteria: strategy.executionProtocol.exitCriteria,
          },
          refinementQuestions: strategy.refinementQuestions,
        });
  }

  /** Load knowledge graph for current project (if it exists). */
  private loadGraph(): import("./graph-utils").GraphData | null {
    try {
      const homeDir = getHomeDir();
      const projectPath = this.workspaceFolder.uri.fsPath;
      const projectId = getProjectIdForTools(projectPath);
      const graphPath = path.join(
        homeDir,
        ".mcp-rag-docs",
        `${projectId}.graph.json`,
      );

      if (!fs.existsSync(graphPath)) return null;

      const raw = fs.readFileSync(graphPath, "utf-8");
      const parsed = JSON.parse(raw);
      return parseGraphologyExport(parsed);
    } catch {
      return null;
    }
  }
}

//  Strategy Finalize Tool

export class StrategyFinalizeTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const filePath = path.join(
      this.memoryPath,
      "sessions",
      "strategy-finalize.json",
    );

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            ready: true,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      this.log(`[LM Tool] strategyFinalize: marked ready`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[LM Tool] strategyFinalize: failed: ${msg}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ No pude marcar la estrategia como lista para cerrar: ${msg}`,
        ),
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        "🏁 Estrategia marcada como lista para cerrar. Ahora llama `strategyComplete`.",
      ),
    ]);
  }
}

//  Strategy Complete Tool (mechanical closing protocol)

export class StrategyCompleteTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private workspaceFolderPath: string,
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    if (!this.isFinalizeReady()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⏳ Aún no es momento de hacer satisfaction check. Cuando termines la tarea, llama `strategyFinalize` y luego `strategyComplete`.",
        ),
      ]);
    }

    const config = vscode.workspace.getConfiguration("projectBrain");
    const satisfactionEnabled = config.get<boolean>(
      "strategy.satisfactionCheck",
      true,
    );
    const autoCommitEnabled = config.get<boolean>("strategy.autoCommit", true);
    const parts: string[] = [];

    // ── Phase 1: Satisfaction Check (mechanical showQuickPick) ──
    if (satisfactionEnabled) {
      this.log(`[LM Tool] strategyComplete: showing satisfaction quick pick`);
      const satisfaction = await vscode.window.showQuickPick(
        [
          {
            label: "$(check) Sí, estoy satisfecho",
            description: "Resultado aceptado",
          },
          {
            label: "$(edit) No del todo, tengo feedback",
            description: "Necesito ajustes",
          },
          {
            label: "$(close) Cancelar estrategia",
            description: "Descartar resultado",
          },
        ],
        {
          placeHolder: "¿Estás satisfecho con el resultado de la estrategia?",
          title: "Strategy Complete — Satisfaction Check",
          ignoreFocusOut: true,
        },
      );

      if (!satisfaction || satisfaction.label.includes("Cancelar")) {
        this.log(`[LM Tool] strategyComplete: user cancelled`);
        this.clearActiveStrategy();
        this.clearFinalizeFlag();
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "⚠️ Usuario canceló la estrategia. Pregúntale cómo quiere proceder.",
          ),
        ]);
      }

      if (satisfaction.label.includes("No del todo")) {
        const feedback = await vscode.window.showInputBox({
          prompt: "¿Qué ajustes necesitas?",
          title: "Strategy Feedback",
          placeHolder: "Describe qué cambiar o mejorar...",
          ignoreFocusOut: true,
        });

        if (feedback && feedback.trim().length > 0) {
          this.log(
            `[LM Tool] strategyComplete: user gave feedback, returning to agent`,
          );
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `🔄 El usuario NO está satisfecho. Feedback: "${feedback.trim()}"\n\nAplica estos ajustes y cuando termines, vuelve a llamar \`strategyComplete\`.`,
            ),
          ]);
        }
        // Empty feedback = treat as satisfied
      }

      parts.push("✅ Usuario satisfecho con el resultado.");
      this.log(`[LM Tool] strategyComplete: user satisfied`);
    } else {
      parts.push("ℹ️ Satisfaction check deshabilitado (bypass).");
      this.log(
        `[LM Tool] strategyComplete: satisfaction check disabled, bypassing`,
      );
    }

    // ── Phase 2: Auto-Commit (mechanical showQuickPick) ──
    if (autoCommitEnabled) {
      this.log(`[LM Tool] strategyComplete: showing auto-commit quick pick`);
      const commitChoice = await vscode.window.showQuickPick(
        [
          {
            label: "$(git-commit) Sí, hacer commit",
            description: "Commit automático de todos los cambios",
          },
          {
            label: "$(close) No, sin commit",
            description: "Dejar los cambios sin commitear",
          },
        ],
        {
          placeHolder:
            "¿Quieres hacer auto-commit de los cambios de esta estrategia?",
          title: "Strategy Complete — Auto-Commit",
          ignoreFocusOut: true,
        },
      );

      if (commitChoice && commitChoice.label.includes("Sí")) {
        const commitMsg = await vscode.window.showInputBox({
          prompt: "Mensaje de commit",
          title: "Auto-Commit Message",
          value: "feat: strategy execution complete",
          ignoreFocusOut: true,
        });

        if (commitMsg && commitMsg.trim().length > 0) {
          const trimmed = commitMsg.trim();
          parts.push(
            `\n📝 **Auto-commit solicitado** con mensaje: "${trimmed}"`,
          );
          this.log(
            `[LM Tool] strategyComplete: user wants auto-commit: "${trimmed}"`,
          );

          const commitResult = await this.tryAutoCommit(trimmed);
          parts.push(commitResult);
        } else {
          parts.push("\n⏭️ Commit cancelado por el usuario.");
        }
      } else {
        parts.push("\n⏭️ Auto-commit declinado.");
      }
    } else {
      parts.push("\nℹ️ Auto-commit deshabilitado (bypass).");
      this.log(`[LM Tool] strategyComplete: auto-commit disabled, bypassing`);
    }

    // ── Phase 3: Cleanup ──
    this.clearActiveStrategy();
    this.clearFinalizeFlag();
    parts.push("\n🏁 Estrategia finalizada.");

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(parts.join("\n")),
    ]);
  }

  private clearActiveStrategy(): void {
    try {
      const filePath = path.join(
        this.memoryPath,
        "sessions",
        "active-strategy.txt",
      );
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.log(`[LM Tool] strategyComplete: cleared active-strategy.txt`);
      }
    } catch (err) {
      this.log(
        `[LM Tool] strategyComplete: failed to clear active strategy: ${err}`,
      );
    }
  }

  private isFinalizeReady(): boolean {
    try {
      const filePath = path.join(
        this.memoryPath,
        "sessions",
        "strategy-finalize.json",
      );
      if (!fs.existsSync(filePath)) return false;
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { ready?: boolean };
      return parsed?.ready === true;
    } catch {
      return false;
    }
  }

  private clearFinalizeFlag(): void {
    try {
      const filePath = path.join(
        this.memoryPath,
        "sessions",
        "strategy-finalize.json",
      );
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.log(`[LM Tool] strategyComplete: cleared strategy-finalize.json`);
      }
    } catch (err) {
      this.log(
        `[LM Tool] strategyComplete: failed to clear finalize flag: ${err}`,
      );
    }
  }

  private async tryAutoCommit(message: string): Promise<string> {
    try {
      const status = await this.runGit(["status", "--porcelain"]);
      if (!status.stdout.trim()) {
        return "\nℹ️ No hay cambios para commitear.";
      }

      await this.runGit(["add", "-A"]);
      const commit = await this.runGit(["commit", "-m", message]);

      const firstLine = commit.stdout.trim().split(/\r?\n/)[0] ?? "";
      const summary = firstLine
        ? `\n✅ Commit creado: ${firstLine}`
        : "\n✅ Commit creado.";
      return summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `\n⛔ Auto-commit falló: ${msg}`;
    }
  }

  private async runGit(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = (await execFileAsync("git", args, {
      cwd: this.workspaceFolderPath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })) as unknown as { stdout: string; stderr: string };

    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  }
}
