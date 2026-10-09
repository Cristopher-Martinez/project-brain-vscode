/**
 * Orchestration Session — Persistent multi-agent session lifecycle.
 *
 * Unlike one-shot Swarm execution, an OrchestrationSession:
 *   - Keeps a team of agents alive across multiple rounds
 *   - Accumulates shared context between rounds
 *   - Lets the user add new tasks without losing context
 *   - Persists until explicitly ended by the user
 *
 * Uses SwarmOrchestrator under the hood for actual execution.
 */

import * as vscode from "vscode";
import type { AgentDefinition } from "./agent-registry";
import type { ModelRouter } from "./model-router";
import type { ModelTier } from "./model-router-types";
import {
  orchFlushWorkerLogs,
  orchReset,
  orchRoundComplete,
  orchRoundStart,
  orchSessionCreate,
  orchSessionEnd,
  orchSetWorkerLog,
  orchUpdateMailbox,
  orchUpdatePlanApprovals,
  orchWorkerComplete,
  orchWorkerProgress,
  setActivePlanManager,
  type OrchAgentSlot,
} from "./orchestration-state";
import { PlanApprovalManager } from "./plan-approval";
import { MailboxDB, SwarmMailbox, type MailboxMessage } from "./swarm-mailbox";
import {
  SwarmOrchestrator,
  type SwarmPlan,
  type SwarmReport,
} from "./swarm-orchestrator";
import { SwarmWorker, type SwarmResult, type SwarmTask } from "./swarm-worker";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentSlotConfig {
  agent: AgentDefinition;
  modelId: string;
  tier: ModelTier;
}

export interface TaskRound {
  roundNumber: number;
  launchedAt: number;
  completedAt?: number;
  tasks: SwarmTask[];
  report?: SwarmReport;
  durationMs?: number;
}

export interface OrchestrationSessionConfig {
  goal: string;
  team: AgentSlotConfig[];
  mode?: "parallel" | "sequential";
  /** Preferred VS Code chat model ID for the orchestrator/fallback (from Brain HQ). */
  orchestratorModelId?: string;
  modelRouter: ModelRouter;
  log: (msg: string) => void;
  /** Path to sessions directory (for mailbox SQLite persistence) */
  sessionsDir?: string;
  /** Enable inter-agent mailbox communication */
  useMailbox?: boolean;
  /** Require plan approval before execution (two-phase mode) */
  requiresPlanApproval?: boolean;
  /** Auto-approve low-risk plans */
  autoApproveLowRisk?: boolean;
  /** Enable branch isolation (fork-based cloning for parallel mode) */
  useBranchIsolation?: boolean;
  /** Token from chat participant — enables copilot tool invocation in workers */
  toolInvocationToken?: vscode.ChatParticipantToolToken;
}

// ─── OrchestrationSession ───────────────────────────────────────────────────

export class OrchestrationSession {
  readonly sessionId: string;
  readonly goal: string;
  readonly team: AgentSlotConfig[];
  readonly mode: "parallel" | "sequential";
  private readonly orchestratorModelId?: string;
  private readonly orchestrator: SwarmOrchestrator;
  private readonly modelRouter: ModelRouter;
  private readonly log: (msg: string) => void;
  private readonly rounds: TaskRound[] = [];
  private sharedContext: string[] = [];
  private state: "planning" | "active" | "paused" | "completed" = "planning";
  private readonly startedAt: number;
  private cancellationSource: vscode.CancellationTokenSource | null = null;
  /** Shared mailbox for inter-agent messaging */
  private readonly mailbox: SwarmMailbox | undefined;
  /** SQLite persistence for mailbox messages */
  private mailboxDb: MailboxDB | undefined;
  /** Plan approval config */
  private readonly requiresPlanApproval: boolean;
  private readonly autoApproveLowRisk: boolean;
  /** Whether to use branch isolation (fork-based cloning in parallel mode) */
  private readonly useBranchIsolation: boolean;
  /** Active plan approval manager (stored for proper disposal) */
  private activePlanManager: PlanApprovalManager | null = null;
  /** Token from chat participant — passed to workers for tool invocation */
  private readonly toolInvocationToken?: vscode.ChatParticipantToolToken;

  /** Max accumulated context size (chars) before summarization */
  private static readonly MAX_CONTEXT_CHARS = 20_000;

  constructor(config: OrchestrationSessionConfig) {
    this.sessionId = `orch-${Date.now().toString(36)}`;
    this.goal = config.goal;
    this.team = config.team;
    this.mode = config.mode || "parallel";
    this.orchestratorModelId = config.orchestratorModelId;
    this.modelRouter = config.modelRouter;
    this.log = config.log;
    this.startedAt = Date.now();
    this.orchestrator = new SwarmOrchestrator(config.modelRouter, config.log);

    // Plan approval config
    this.requiresPlanApproval = config.requiresPlanApproval ?? false;
    this.autoApproveLowRisk = config.autoApproveLowRisk ?? false;
    this.useBranchIsolation = config.useBranchIsolation ?? false;
    this.toolInvocationToken = config.toolInvocationToken;
    this.log(
      `[Orch] Config: mode=${this.mode}, planApproval=${this.requiresPlanApproval}, autoApproveLowRisk=${this.autoApproveLowRisk}, orchestratorModel=${this.orchestratorModelId || "(default)"}, toolToken=${this.toolInvocationToken ? "YES" : "NO"}`,
    );
    this.log(
      `[Orch] Team: ${config.team.map((s) => `${s.agent.name}(${s.agent.id}) → ${s.modelId}/${s.tier}`).join(", ")}`,
    );

    // Setup mailbox if explicitly requested (consistent with requiresPlanApproval default)
    if (config.useMailbox) {
      this.log(
        `[Orch] Mailbox requested — creating SwarmMailbox (real-time sync)`,
      );
      this.mailbox = new SwarmMailbox({
        maxPostsPerWorker: 10,
        log: config.log,
        onPost: (_message) => {
          // Push mailbox state to UI immediately on every post
          if (this.mailbox) {
            orchUpdateMailbox(
              this.sessionId,
              this.mailbox.getAll(),
              this.mailbox.getStats(),
            );
          }
        },
      });
      if (config.sessionsDir) {
        this.log(`[Orch] MailboxDB persistence: ${config.sessionsDir}`);
        this.mailboxDb = new MailboxDB(config.sessionsDir, config.log);
        this.mailboxDb
          .init()
          .catch((err) => config.log(`[Orch] MailboxDB init failed: ${err}`));
      } else {
        this.log(
          `[Orch] No sessionsDir — mailbox will be in-memory only (no persistence)`,
        );
      }
      config.log(`[Orch] Mailbox enabled for session ${this.sessionId}`);
    } else {
      this.log(`[Orch] Mailbox not requested`);
    }

    // Emit UI state
    orchSessionCreate(this.sessionId, {
      goal: this.goal,
      mode: this.mode,
      team: this.team.map((s) => this.toOrchSlot(s)),
    });

    this.log(
      `[Orch] Session ${this.sessionId} created: "${this.goal}" with ${this.team.length} agents (${this.mode})`,
    );
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  /**
   * Dispatch tasks to the team. Each agent gets its own task with
   * its configured model, system prompt, and accumulated context.
   *
   * @param prompt - The task instruction (same for all agents, or per-agent if array)
   */
  async dispatch(prompt: string | string[]): Promise<SwarmReport> {
    if (this.mode === "sequential") {
      return this.dispatchSequential(
        Array.isArray(prompt) ? prompt[0] : prompt,
      );
    }
    return this.dispatchParallel(prompt);
  }

  // ─── Parallel Dispatch (original) ─────────────────────────────────

  private async dispatchParallel(
    prompt: string | string[],
  ): Promise<SwarmReport> {
    if (this.state === "completed") {
      throw new Error("Session already ended");
    }

    const roundNumber = this.rounds.length + 1;
    this.state = "active";
    this.cancellationSource = new vscode.CancellationTokenSource();

    this.log(
      `[Orch] Round ${roundNumber}: dispatching to ${this.team.length} agents`,
    );

    // Build tasks — one per agent
    const tasks: SwarmTask[] = this.team.map((slot, i) => {
      const agentPrompt = Array.isArray(prompt)
        ? prompt[i] || prompt[0]
        : prompt;
      const contextBlock = this.buildContextBlock();

      return {
        id: `${slot.agent.id}-r${roundNumber}`,
        prompt: agentPrompt,
        systemPrompt: this.buildAgentSystemPrompt(slot, contextBlock),
        taskKind: "raw" as const,
        maxTier: slot.tier,
        modelId: slot.modelId,
        maxToolRounds: 8,
      };
    });

    // Emit round start
    orchRoundStart(this.sessionId, {
      roundNumber,
      workers: tasks.map((t, i) => ({
        agentId: this.team[i].agent.id,
        agentName: this.team[i].agent.name,
        agentIcon: this.team[i].agent.icon,
        taskId: t.id,
        message: "Starting...",
      })),
    });

    // Build SwarmPlan
    const plan: SwarmPlan = {
      goal: `${this.goal} (Round ${roundNumber})`,
      tasks,
      concurrency: this.team.length, // all agents in parallel
      useForks: this.useBranchIsolation, // controlled by Brain HQ toggle
      useMailbox: !!this.mailbox, // enable inter-agent messaging
      requiresPlanApproval: this.requiresPlanApproval,
      planApprovalConfig: this.requiresPlanApproval
        ? { autoApproveLowRisk: this.autoApproveLowRisk, log: this.log }
        : undefined,
    };

    // Create PlanApprovalManager EXTERNALLY so Brain HQ can approve/reject
    // while the orchestrator is blocked waiting for approvals.
    if (this.requiresPlanApproval) {
      // Dispose previous manager if it exists (from a prior round)
      if (this.activePlanManager) {
        this.log(
          `[Orch] Disposing previous PlanApprovalManager from prior round`,
        );
      }
      this.activePlanManager?.dispose();

      const planManager = new PlanApprovalManager({
        autoApproveLowRisk: this.autoApproveLowRisk,
        log: this.log,
      });
      // Store reference for proper disposal in end()
      this.activePlanManager = planManager;
      // Bridge plan events to UI state immediately
      planManager.onDidUpdatePlans((plans) => {
        this.log(`[Orch] Plan update event: ${plans.length} pending plans`);
        orchUpdatePlanApprovals(this.sessionId, plans);
      });
      // Register globally so HQ handlers can call approve/reject
      setActivePlanManager(this.sessionId, planManager);
      // Pass to orchestrator (it will use this instead of creating its own)
      plan.planApprovalManager = planManager;
      this.log(
        `[Orch] PlanApprovalManager registered for HQ access (autoApproveLowRisk=${this.autoApproveLowRisk})`,
      );
    } else {
      this.log(`[Orch] Plan approval not required for this round`);
    }

    // Get a fallback model for the orchestrator
    // Filter out virtual selectors (e.g., "auto") that don't have real endpoints
    const fallbackModels = (await vscode.lm.selectChatModels()).filter(
      (m) => m.id !== "auto" && !m.id.endsWith("-auto"),
    );
    let fallback = fallbackModels[0];

    if (this.orchestratorModelId) {
      const exact = fallbackModels.find(
        (m) => m.id === this.orchestratorModelId,
      );
      if (exact) {
        fallback = exact;
        this.log(`[Orch] Using orchestrator model from HQ: ${exact.id}`);
      } else {
        this.log(
          `[Orch] Orchestrator model "${this.orchestratorModelId}" not found, falling back to default model`,
        );
      }
    }

    if (!fallback) {
      throw new Error("No language models available");
    }

    // Execute via SwarmOrchestrator with progress bridge
    const report = await this.orchestrator.execute(
      plan,
      this.cancellationSource.token,
      fallback,
      {
        onProgress: (taskId, message) => {
          orchWorkerProgress(this.sessionId, taskId, message);
        },
        onStreamText: (taskId, text) => {
          orchSetWorkerLog(this.sessionId, taskId, text);
        },
        mailbox: this.mailbox,
        toolInvocationToken: this.toolInvocationToken,
      },
    );

    // Plan approval state is already bridged via the external manager (registered before execute).
    // If somehow internal manager was used, bridge post-hoc as fallback.
    if (!this.requiresPlanApproval && report.planApprovalManager) {
      this.log(
        `[Orch] Post-hoc plan manager bridge (internal manager was used)`,
      );
      report.planApprovalManager.onDidUpdatePlans((plans) => {
        orchUpdatePlanApprovals(this.sessionId, plans);
      });
    }
    if (report.planApprovals) {
      this.log(
        `[Orch] Bridging ${report.planApprovals.length} plan approval results to UI`,
      );
      orchUpdatePlanApprovals(this.sessionId, report.planApprovals);
    }

    // Update worker states from results
    for (const result of report.results) {
      const slot = this.team.find((s) => result.taskId.startsWith(s.agent.id));
      // Store full log for HQ console
      orchSetWorkerLog(
        this.sessionId,
        result.taskId,
        result.text || result.error || "(sin output)",
      );
      orchWorkerComplete(this.sessionId, {
        agentId: slot?.agent.id || "unknown",
        agentName: slot?.agent.name || "Unknown",
        agentIcon: slot?.agent.icon || "🤖",
        taskId: result.taskId,
        success: result.success,
        error: result.error,
        model: result.model,
        tier: result.tier,
        rounds: result.rounds,
        toolCalls: result.toolCalls.length,
        durationMs: result.durationMs,
        estimatedInputTokens: result.estimatedInputTokens,
        estimatedOutputTokens: result.estimatedOutputTokens,
        message: result.success ? "Done" : "Failed",
      });
    }

    // Save round
    const round: TaskRound = {
      roundNumber,
      launchedAt: Date.now() - (report.totalDurationMs || 0),
      completedAt: Date.now(),
      tasks,
      report,
      durationMs: report.totalDurationMs,
    };
    this.rounds.push(round);

    // Accumulate context from results
    this.accumulateContext(report);

    // Flush any pending throttled worker logs before round completion
    orchFlushWorkerLogs(this.sessionId);

    // Push final mailbox snapshot to UI (round summary — onPost already handles real-time)
    if (this.mailbox) {
      const stats = this.mailbox.getStats();
      this.log(
        `[Orch] Mailbox round summary: ${stats.totalMessages} total messages, unread=${stats.unreadCount}, byType=${JSON.stringify(stats.byType)}`,
      );
      orchUpdateMailbox(this.sessionId, this.mailbox.getAll(), stats);
    } else {
      this.log(`[Orch] No mailbox — skipping mailbox UI update`);
    }

    // Persist mailbox messages to SQLite (if available)
    this.persistMailbox();

    // Clear mailbox between rounds — messages already persisted + pushed to UI.
    // Using clear() instead of resetAllRateLimits() to prevent stale messages
    // from bleeding into the next round's workers.
    this.mailbox?.clear();

    // Emit round complete
    orchRoundComplete(this.sessionId);
    this.state = "paused";
    this.cancellationSource = null;

    this.log(
      `[Orch] Round ${roundNumber} complete: ${report.successCount}/${report.results.length} succeeded in ${(report.totalDurationMs / 1000).toFixed(1)}s`,
    );

    return report;
  }

  // ─── Sequential Dispatch (pipeline) ───────────────────────────────

  /**
   * Run agents one by one in order. Each agent receives the
   * previous agent's output as additional context — pipeline style.
   *
   * Agent 1 gets: prompt
   * Agent 2 gets: prompt + Agent 1's output
   * Agent 3 gets: prompt + Agent 1+2 outputs
   * ...etc
   */
  private async dispatchSequential(prompt: string): Promise<SwarmReport> {
    if (this.state === "completed") {
      throw new Error("Session already ended");
    }

    const roundNumber = this.rounds.length + 1;
    this.state = "active";
    this.cancellationSource = new vscode.CancellationTokenSource();
    const startTime = Date.now();

    // Warn about features not supported in sequential mode
    if (this.mailbox) {
      this.log(
        `[Orch] Note: Mailbox is enabled but not used in sequential mode (pipeline pattern)`,
      );
    }
    if (this.requiresPlanApproval) {
      this.log(
        `[Orch] Note: Plan Approval is enabled but not used in sequential mode (pipeline pattern)`,
      );
    }

    this.log(
      `[Orch] Sequential round ${roundNumber}: pipeline of ${this.team.length} agents`,
    );

    // Emit round start
    orchRoundStart(this.sessionId, {
      roundNumber,
      workers: this.team.map((slot) => ({
        agentId: slot.agent.id,
        agentName: slot.agent.name,
        agentIcon: slot.agent.icon,
        taskId: `${slot.agent.id}-r${roundNumber}`,
        message: "Waiting in pipeline...",
      })),
    });

    // Get fallback model
    // Filter out virtual selectors (e.g., "auto") that don't have real endpoints
    const fallbackModels = (await vscode.lm.selectChatModels()).filter(
      (m) => m.id !== "auto" && !m.id.endsWith("-auto"),
    );
    let fallback = fallbackModels[0];

    if (this.orchestratorModelId) {
      const exact = fallbackModels.find(
        (m) => m.id === this.orchestratorModelId,
      );
      if (exact) {
        fallback = exact;
        this.log(`[Orch] Using orchestrator model from HQ: ${exact.id}`);
      } else {
        this.log(
          `[Orch] Orchestrator model "${this.orchestratorModelId}" not found, falling back to default model`,
        );
      }
    }

    if (!fallback) {
      throw new Error("No language models available");
    }

    const worker = new SwarmWorker(this.modelRouter, this.log);
    const results: SwarmResult[] = [];
    const tasks: SwarmTask[] = [];
    let pipelineContext = ""; // accumulated output from previous agents

    for (let i = 0; i < this.team.length; i++) {
      const slot = this.team[i];
      const taskId = `${slot.agent.id}-r${roundNumber}`;
      const contextBlock = this.buildContextBlock();

      // Build prompt: original prompt + pipeline context from previous agents
      let agentPrompt = prompt;
      if (pipelineContext) {
        agentPrompt = [
          prompt,
          "",
          "## Output from Previous Agents in Pipeline",
          pipelineContext,
          "",
          "Use the above context to continue the work. Build upon what previous agents produced.",
        ].join("\n");
      }

      const task: SwarmTask = {
        id: taskId,
        prompt: agentPrompt,
        systemPrompt: this.buildAgentSystemPrompt(slot, contextBlock),
        taskKind: "raw" as const,
        maxTier: slot.tier,
        modelId: slot.modelId,
        maxToolRounds: 8,
      };
      tasks.push(task);

      // Update UI: this agent is now active
      orchWorkerProgress(
        this.sessionId,
        taskId,
        `Running (step ${i + 1}/${this.team.length})...`,
      );

      try {
        const result = await worker.execute(
          task,
          this.cancellationSource!.token,
          fallback,
          {
            onProgress: (tid, message) =>
              orchWorkerProgress(this.sessionId, tid, message),
            onStreamText: (tid, text) =>
              orchSetWorkerLog(this.sessionId, tid, text),
            mailbox: this.mailbox,
            toolInvocationToken: this.toolInvocationToken,
          },
        );
        results.push(result);

        // Store full log for HQ console
        orchSetWorkerLog(
          this.sessionId,
          taskId,
          result.text || result.error || "(sin output)",
        );

        // Update UI
        orchWorkerComplete(this.sessionId, {
          agentId: slot.agent.id,
          agentName: slot.agent.name,
          agentIcon: slot.agent.icon,
          taskId,
          success: result.success,
          error: result.error,
          model: result.model,
          tier: result.tier,
          rounds: result.rounds,
          toolCalls: result.toolCalls.length,
          durationMs: result.durationMs,
          estimatedInputTokens: result.estimatedInputTokens,
          estimatedOutputTokens: result.estimatedOutputTokens,
          message: result.success ? "Done" : "Failed",
        });

        // Add this agent's output to pipeline context for next agent
        if (result.success && result.text) {
          pipelineContext += `\n### ${slot.agent.name} (${slot.agent.icon}):\n${result.text}\n`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          taskId,
          text: "",
          toolCalls: [],
          model: "",
          tier: slot.tier,
          durationMs: 0,
          rounds: 0,
          success: false,
          error: msg,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
        });
        orchWorkerComplete(this.sessionId, {
          agentId: slot.agent.id,
          agentName: slot.agent.name,
          agentIcon: slot.agent.icon,
          taskId,
          success: false,
          error: msg,
          message: "Failed",
        });
        this.log(`[Orch] Sequential agent ${slot.agent.name} failed: ${msg}`);
        // Continue pipeline even if one fails — next agent gets partial context
      }
    }

    // Build SwarmReport from individual results
    const totalDurationMs = Date.now() - startTime;
    const report: SwarmReport = {
      goal: `${this.goal} (Round ${roundNumber}, sequential)`,
      results,
      totalDurationMs,
      successCount: results.filter((r) => r.success).length,
      failCount: results.filter((r) => !r.success).length,
      totalToolCalls: results.reduce((s, r) => s + r.toolCalls.length, 0),
      totalEstimatedInputTokens: results.reduce(
        (s, r) => s + r.estimatedInputTokens,
        0,
      ),
      totalEstimatedOutputTokens: results.reduce(
        (s, r) => s + r.estimatedOutputTokens,
        0,
      ),
      summary: results
        .map(
          (r) =>
            `${r.success ? "✅" : "❌"} ${r.taskId}: ${r.text?.substring(0, 200) || r.error || "(no output)"}`,
        )
        .join("\n"),
    };

    // Save round
    const round: TaskRound = {
      roundNumber,
      launchedAt: startTime,
      completedAt: Date.now(),
      tasks,
      report,
      durationMs: totalDurationMs,
    };
    this.rounds.push(round);

    this.accumulateContext(report);
    orchRoundComplete(this.sessionId);
    this.state = "paused";
    this.cancellationSource = null;

    this.log(
      `[Orch] Sequential round ${roundNumber} complete: ${report.successCount}/${results.length} in ${(totalDurationMs / 1000).toFixed(1)}s`,
    );

    return report;
  }

  // ─── Context Management ───────────────────────────────────────────

  /**
   * Build the context block injected into each agent's system prompt.
   * Includes accumulated context from previous rounds.
   */
  private buildContextBlock(): string {
    if (this.sharedContext.length === 0) return "";

    return [
      "\n\n## Context from Previous Rounds\n",
      ...this.sharedContext.map((c, i) => `### Round ${i + 1} Summary\n${c}`),
    ].join("\n");
  }

  /**
   * Extract key insights from a round's results and add to shared context.
   * Keeps context under MAX_CONTEXT_CHARS by summarizing older entries.
   */
  private accumulateContext(report: SwarmReport): void {
    // Extract key content from each worker's response
    const successResults = report.results.filter((r) => r.success && r.text);
    this.log(
      `[Orch] accumulateContext: ${successResults.length}/${report.results.length} workers produced usable output`,
    );

    const roundSummary = successResults
      .map((r) => {
        // Take first 500 chars of each result as context
        const preview =
          r.text.length > 500 ? r.text.substring(0, 500) + "..." : r.text;
        return `**${r.taskId}**: ${preview}`;
      })
      .join("\n\n");

    this.sharedContext.push(roundSummary);

    // Prune if too long — keep only last N entries that fit
    let totalChars = this.sharedContext.reduce((sum, c) => sum + c.length, 0);
    const entriesBefore = this.sharedContext.length;
    while (
      totalChars > OrchestrationSession.MAX_CONTEXT_CHARS &&
      this.sharedContext.length > 1
    ) {
      const removed = this.sharedContext.shift();
      totalChars -= removed?.length || 0;
    }
    if (this.sharedContext.length < entriesBefore) {
      this.log(
        `[Orch] Context pruned: ${entriesBefore} → ${this.sharedContext.length} entries (${totalChars} chars)`,
      );
    } else {
      this.log(
        `[Orch] Context total: ${this.sharedContext.length} entries, ${totalChars} chars`,
      );
    }
  }

  /**
   * Manually add context that will be available in the next round.
   */
  addContext(text: string): void {
    this.sharedContext.push(text);
    this.log(`[Orch] Manual context added (${text.length} chars)`);
  }

  // ─── Agent System Prompt ──────────────────────────────────────────

  private buildAgentSystemPrompt(
    slot: AgentSlotConfig,
    contextBlock: string,
  ): string {
    const mailboxHint = this.mailbox
      ? [
          "",
          "## MANDATORY: Inter-Agent Communication",
          "You are part of a multi-agent team. You MUST use the `swarm_mailbox_post` tool to collaborate.",
          "",
          "**CRITICAL:** `swarm_mailbox_post` is a TOP-LEVEL tool — call it directly, NOT through `projectBrain_toolbox`. It will NOT work inside toolbox.",
          "",
          "**Required actions:**",
          "1. After gathering your initial findings, post a `finding` message summarizing key discoveries",
          "2. If you have questions another agent might answer, post a `question` message",
          "3. If you notice gaps or contradictions, post a `challenge` message",
          "4. Before finishing, post a `consensus` or `update` with your final conclusions",
          "",
          "Message types: finding | question | challenge | update | blocker | consensus",
          "Target: set `to` to a specific worker ID for DM, or omit for broadcast.",
          "",
          "**IMPORTANT: You MUST post at least one message before producing your final output.**",
          "Failure to post means your findings are invisible to the team — this breaks coordination.",
        ].join("\n")
      : "";

    // Workspace context — workers need to know the project root and how to read files
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const wsPath = wsFolder?.uri.fsPath ?? "";
    const workspaceBlock = wsPath
      ? [
          "",
          "## WORKSPACE",
          `Project root: ${wsPath}`,
          "",
          "## HOW TO READ SOURCE CODE",
          "Use these virtual tools — they work directly, no shell, no ENOENT:",
          "- `swarm_read_file` — read file contents (filePath relative to project root, e.g. 'src/extension.ts')",
          "- `swarm_list_dir` — list directory contents (dirPath relative to project root, e.g. 'src/')",
          "- `swarm_grep` — search for text patterns across files (pattern + optional include glob)",
          "",
          "Do NOT use `mcp_agent-orchest_copilot_execute_command` for reading files — it fails with ENOENT.",
          "Do NOT try to call `read_file`, `grep_search`, `list_dir`, or `semantic_search` — they don't exist.",
          "",
          "For project memory/docs: use `projectBrain_toolbox` with searchMemory or getContext.",
        ].join("\n")
      : "";

    return [
      `# Role: ${slot.agent.name}`,
      "",
      slot.agent.systemPrompt,
      "",
      `## Session Goal`,
      this.goal,
      "",
      `## Your Model Assignment`,
      `You are running on: ${slot.modelId} (tier: ${slot.tier})`,
      `Session: ${this.sessionId}, Round: ${this.rounds.length + 1}`,
      "",
      contextBlock,
      workspaceBlock,
      mailboxHint,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * End the session. Generates a summary and emits final state.
   */
  end(): string {
    if (this.state === "completed") {
      this.log(`[Orch] end() called but session already completed`);
      return this.generateSummary();
    }

    // Cancel any running work
    if (this.cancellationSource) {
      this.log(`[Orch] Cancelling running work...`);
    }
    this.cancellationSource?.cancel();
    this.cancellationSource = null;

    this.state = "completed";

    const summary = this.generateSummary();
    orchSessionEnd(this.sessionId, summary);

    // Final mailbox persistence
    this.log(`[Orch] Final mailbox persistence before end...`);
    this.persistMailbox();
    this.mailboxDb?.dispose();

    // Dispose and clear plan approval manager
    if (this.activePlanManager) {
      this.log(
        `[Orch] Disposing PlanApprovalManager (${this.activePlanManager.hasPendingPlans() ? "has pending plans" : "clean"})`,
      );
    }
    this.activePlanManager?.dispose();
    this.activePlanManager = null;
    setActivePlanManager(this.sessionId, null);

    this.log(
      `[Orch] Session ${this.sessionId} ended after ${this.rounds.length} rounds`,
    );

    return summary;
  }

  /**
   * Reset — clears the session state entirely.
   */
  reset(): void {
    this.log(`[Orch] Resetting session ${this.sessionId}`);
    this.cancellationSource?.cancel();
    this.cancellationSource = null;
    this.state = "completed";
    this.mailboxDb?.dispose();
    orchReset(this.sessionId);
  }

  // ─── Mailbox Helpers ───────────────────────────────────────────

  /** Persist current mailbox messages to SQLite. */
  private persistMailbox(): void {
    if (!this.mailbox || !this.mailboxDb) {
      if (this.mailbox && !this.mailboxDb) {
        this.log(
          `[Orch] persistMailbox: mailbox exists but no MailboxDB — skipping persistence`,
        );
      }
      return;
    }
    const messages = this.mailbox.getAll();
    if (messages.length > 0) {
      this.log(
        `[Orch] Persisting ${messages.length} mailbox messages to SQLite`,
      );
      this.mailboxDb.saveMessages(this.sessionId, messages);
    } else {
      this.log(`[Orch] No mailbox messages to persist`);
    }
  }

  /** Get mailbox instance (for external access, e.g. Brain HQ). */
  getMailbox(): SwarmMailbox | undefined {
    return this.mailbox;
  }

  /** Get mailbox messages from SQLite (for session resume). */
  async loadMailboxHistory(): Promise<MailboxMessage[]> {
    return this.mailboxDb?.loadMessages(this.sessionId) ?? [];
  }

  private generateSummary(): string {
    const totalDuration = Date.now() - this.startedAt;
    const totalTokensIn = this.rounds.reduce(
      (sum, r) => sum + (r.report?.totalEstimatedInputTokens || 0),
      0,
    );
    const totalTokensOut = this.rounds.reduce(
      (sum, r) => sum + (r.report?.totalEstimatedOutputTokens || 0),
      0,
    );
    const totalSuccess = this.rounds.reduce(
      (sum, r) => sum + (r.report?.successCount || 0),
      0,
    );
    const totalFail = this.rounds.reduce(
      (sum, r) => sum + (r.report?.failCount || 0),
      0,
    );

    const teamList = this.team
      .map((s) => `- ${s.agent.name} → ${s.modelId} (${s.tier})`)
      .join("\n");

    return [
      `## Orchestration Session: ${this.goal}`,
      `**Session ID**: ${this.sessionId}`,
      `**Duration**: ${(totalDuration / 1000).toFixed(1)}s`,
      `**Rounds**: ${this.rounds.length}`,
      `**Results**: ${totalSuccess} succeeded, ${totalFail} failed`,
      `**Tokens**: ~${(totalTokensIn / 1000).toFixed(1)}K in, ~${(totalTokensOut / 1000).toFixed(1)}K out`,
      "",
      "### Team",
      teamList,
      "",
      "### Round Results",
      ...this.rounds.map((r) => {
        const s = r.report;
        return `- Round ${r.roundNumber}: ${s?.successCount || 0}/${s?.results.length || 0} succeeded (${((r.durationMs || 0) / 1000).toFixed(1)}s)`;
      }),
      // Mailbox section
      ...(this.mailbox
        ? [
            "",
            "### Inter-Agent Communication",
            `**Messages**: ${this.mailbox.getStats().totalMessages}`,
            ...Object.entries(this.mailbox.getStats().byType)
              .filter(([, count]) => count > 0)
              .map(([type, count]) => `- ${type}: ${count}`),
          ]
        : []),
    ].join("\n");
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private toOrchSlot(slot: AgentSlotConfig): OrchAgentSlot {
    return {
      agentId: slot.agent.id,
      agentName: slot.agent.name,
      agentIcon: slot.agent.icon,
      modelId: slot.modelId,
      tier: slot.tier,
    };
  }

  get isActive(): boolean {
    return this.state === "active";
  }

  get isPaused(): boolean {
    return this.state === "paused";
  }

  get isCompleted(): boolean {
    return this.state === "completed";
  }

  get roundCount(): number {
    return this.rounds.length;
  }

  get currentState(): string {
    return this.state;
  }
}
