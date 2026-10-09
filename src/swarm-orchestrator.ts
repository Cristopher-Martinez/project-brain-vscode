// swarm-orchestrator.ts — Coordinates multiple SwarmWorkers for parallel task execution

import * as vscode from "vscode";
import type { ModelRouter } from "./model-router";
import {
  PlanApprovalManager,
  parsePlanOutput,
  type PlanApprovalConfig,
  type PlanApprovalRequest,
} from "./plan-approval";
import {
  SwarmMailbox,
  type MailboxMessage,
  type MailboxStats,
} from "./swarm-mailbox";
import { dispatchSwarmTasks } from "./swarm-orchestrator-dispatch";
import {
  cleanupSwarmForks,
  formatSwarmSummary,
  setupSwarmForks,
  type ForkBranchResult,
  type SwarmForkInfo,
} from "./swarm-orchestrator-helpers";
import { globalSwarmTrust } from "./swarm-trust";
import {
  SwarmWorker,
  type SwarmResult,
  type SwarmTask,
  type SwarmWorkerOptions,
} from "./swarm-worker";

// ─── Interfaces ────────────────────────────────────────────────────────

/**
 * A plan describing what the swarm should do.
 * The orchestrator breaks this into individual tasks for workers.
 */
export interface SwarmPlan {
  /** Human-readable description of the swarm's goal */
  goal: string;
  /** Individual tasks to dispatch to workers */
  tasks: SwarmTask[];
  /** Max concurrent workers (default: 4) — be polite to the API */
  concurrency?: number;
  /** Enable git fork isolation per worker (requires git repo) */
  useForks?: boolean;
  /** Enable inter-worker communication via mailbox */
  useMailbox?: boolean;
  /** Require plan approval before execution (two-phase mode) */
  requiresPlanApproval?: boolean;
  /** Plan approval configuration */
  planApprovalConfig?: PlanApprovalConfig;
  /** External PlanApprovalManager — if provided, used instead of creating a new one.
   *  This allows the session to register the manager with state BEFORE execute() blocks. */
  planApprovalManager?: PlanApprovalManager;
}

/**
 * Aggregated results from a swarm execution.
 */
export interface SwarmReport {
  goal: string;
  results: SwarmResult[];
  totalDurationMs: number;
  successCount: number;
  failCount: number;
  totalToolCalls: number;
  totalEstimatedInputTokens: number;
  totalEstimatedOutputTokens: number;
  summary: string;
  /** Fork branches created (for review/merge) */
  forkBranches?: ForkBranchResult[];
  /** Mailbox messages exchanged during execution */
  mailboxMessages?: MailboxMessage[];
  /** Mailbox statistics */
  mailboxStats?: MailboxStats;
  /** Plan approval results (when requiresPlanApproval is true) */
  planApprovals?: PlanApprovalRequest[];
  /** PlanApprovalManager instance (for external subscription) */
  planApprovalManager?: PlanApprovalManager;
}

// ─── SwarmOrchestrator ─────────────────────────────────────────────────

/**
 * Coordinates multiple SwarmWorkers for parallel task execution.
 * Dispatches crew members to different tasks, aggregates the loot.
 */
export class SwarmOrchestrator {
  private worker: SwarmWorker;

  constructor(
    private modelRouter: ModelRouter,
    private log: (msg: string) => void,
  ) {
    this.worker = new SwarmWorker(modelRouter, log);
  }

  /**
   * Execute a swarm plan — dispatches tasks to workers in parallel
   * (with concurrency limit) and aggregates results.
   */
  async execute(
    plan: SwarmPlan,
    token: vscode.CancellationToken,
    fallbackModel: vscode.LanguageModelChat,
    options?: SwarmWorkerOptions,
  ): Promise<SwarmReport> {
    const startTime = Date.now();
    const concurrency = plan.concurrency ?? 4;
    const results: SwarmResult[] = [];
    let forkMap = new Map<string, SwarmForkInfo>();

    this.log(
      `[Swarm] Starting: "${plan.goal}" — ${plan.tasks.length} tasks, concurrency=${concurrency}${plan.useForks ? ", fork isolation ON" : ""}${plan.useMailbox ? ", mailbox ON" : ""}`,
    );
    options?.onProgress?.(
      "swarm",
      `Dispatching ${plan.tasks.length} workers...`,
    );

    // ─── Mailbox setup (if enabled) ─────────────────────────────
    // Prefer external mailbox from orchestration session (single source of truth)
    // Only create a new one if none was passed via options
    let mailbox: SwarmMailbox | undefined;
    if (options?.mailbox) {
      mailbox = options.mailbox;
      this.log("[Swarm] Using external mailbox from orchestration session");
    } else if (plan.useMailbox) {
      mailbox = new SwarmMailbox({ maxPostsPerWorker: 10, log: this.log });
      this.log("[Swarm] Created local mailbox for inter-worker communication");
    }

    // ─── Fork setup (if enabled) ─────────────────────────────────
    if (plan.useForks) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const repoRoot = workspaceFolders[0].uri.fsPath;
        forkMap = await setupSwarmForks(
          plan.tasks,
          repoRoot,
          this.log,
          options?.onProgress,
        );
      } else {
        this.log("[Swarm] No workspace folder — skipping fork isolation");
      }
    }

    // ─── Plan Approval Phase (if enabled) ───────────────────────
    let planApprovalManager: PlanApprovalManager | undefined;
    let planApprovals: PlanApprovalRequest[] | undefined;

    const tasksWithApproval = plan.tasks.filter(
      (t) => t.requiresPlanApproval || plan.requiresPlanApproval,
    );

    if (tasksWithApproval.length > 0) {
      planApprovalManager =
        plan.planApprovalManager ??
        new PlanApprovalManager({
          ...plan.planApprovalConfig,
          log: this.log,
        });

      this.log(
        `[Swarm] Plan approval phase: ${tasksWithApproval.length} tasks require approval`,
      );
      options?.onProgress?.(
        "swarm",
        `Planning phase: ${tasksWithApproval.length} tasks analyzing...`,
      );

      // Phase 1: Run all approval-required tasks in plan-only mode
      this.log(
        `[Swarm] Plan phase 1: running ${tasksWithApproval.length} tasks in plan-only mode...`,
      );
      const planResults = await Promise.allSettled(
        tasksWithApproval.map((task) =>
          this.worker.execute(task, token, fallbackModel, {
            ...options,
            mailbox,
            planOnly: true,
          }),
        ),
      );

      // Phase 2: Submit plans for approval and wait
      const approvalPromises: Promise<{
        taskId: string;
        approved: boolean;
      }>[] = [];

      for (let i = 0; i < planResults.length; i++) {
        const settled = planResults[i];
        const task = tasksWithApproval[i];

        if (settled.status === "fulfilled" && settled.value.success) {
          const taskPlan = parsePlanOutput(task.id, settled.value.text);
          this.log(
            `[Swarm] Plan result for ${task.id}: SUCCESS (risk=${taskPlan.riskLevel}, reads=${taskPlan.intendedReads?.length ?? 0}, writes=${taskPlan.intendedWrites?.length ?? 0}, tools=${taskPlan.intendedTools?.length ?? 0})`,
          );
          approvalPromises.push(
            planApprovalManager
              .submitPlan(task.id, task.prompt, taskPlan)
              .then((approved) => ({ taskId: task.id, approved })),
          );
        } else {
          // Planning failed — auto-reject
          const error =
            settled.status === "rejected"
              ? String(settled.reason)
              : (settled.value.error ?? "Planning phase failed");
          this.log(
            `[Swarm] Plan FAILED for ${task.id}: ${error} — auto-rejecting`,
          );
        }
      }

      if (approvalPromises.length > 0) {
        this.log(
          `[Swarm] Waiting for plan approvals (${approvalPromises.length} pending)...`,
        );
        options?.onProgress?.(
          "swarm",
          `Waiting for plan approvals (${approvalPromises.length} pending)...`,
        );

        const approvalResults = await Promise.all(approvalPromises);
        planApprovals = planApprovalManager.getPendingPlans();

        // Log individual approval results
        for (const ar of approvalResults) {
          this.log(
            `[Swarm] Approval result: ${ar.taskId} → ${ar.approved ? "APPROVED" : "REJECTED"}`,
          );
        }

        // Filter out rejected tasks from the execution
        const rejectedIds = new Set(
          approvalResults.filter((r) => !r.approved).map((r) => r.taskId),
        );

        if (rejectedIds.size > 0) {
          this.log(
            `[Swarm] ${rejectedIds.size} tasks rejected — removing from execution`,
          );
          // Add rejection results
          for (const rejectedId of rejectedIds) {
            results.push({
              taskId: rejectedId,
              text: "Plan rejected — task not executed",
              toolCalls: [],
              model: "none",
              tier: "none",
              durationMs: 0,
              rounds: 0,
              success: false,
              error: "Plan rejected by reviewer",
              estimatedInputTokens: 0,
              estimatedOutputTokens: 0,
            });
          }
          // Remove rejected tasks from the plan
          plan.tasks = plan.tasks.filter((t) => !rejectedIds.has(t.id));
        }

        this.log(
          `[Swarm] Plan approval complete: ${plan.tasks.length} tasks approved for execution`,
        );
      }
    }

    // ─── Dispatch (DAG-aware or batch) ────────────────────────
    const dispatchResults = await dispatchSwarmTasks({
      tasks: plan.tasks,
      concurrency,
      worker: this.worker,
      token,
      fallbackModel,
      options,
      mailbox,
      log: this.log,
    });
    results.push(...dispatchResults);

    // ─── Fork cleanup + auto-commit ─────────────────────────────
    let forkBranches: ForkBranchResult[] | undefined;
    if (forkMap.size > 0) {
      forkBranches = await cleanupSwarmForks(forkMap, this.log);
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    // Update trust registry for each completed task
    for (const result of results) {
      globalSwarmTrust.record(result.taskId, result.success);
    }
    const totalToolCalls = results.reduce(
      (sum, r) => sum + r.toolCalls.length,
      0,
    );
    const totalEstimatedInputTokens = results.reduce(
      (sum, r) => sum + (r.estimatedInputTokens ?? 0),
      0,
    );
    const totalEstimatedOutputTokens = results.reduce(
      (sum, r) => sum + (r.estimatedOutputTokens ?? 0),
      0,
    );

    const report: SwarmReport = {
      goal: plan.goal,
      results,
      totalDurationMs: totalDuration,
      successCount,
      failCount,
      totalToolCalls,
      totalEstimatedInputTokens,
      totalEstimatedOutputTokens,
      summary: formatSwarmSummary({
        goal: plan.goal,
        results,
        durationMs: totalDuration,
        forkBranches,
      }),
      forkBranches,
      mailboxMessages: mailbox?.getAll(),
      mailboxStats: mailbox?.getStats(),
      planApprovals,
      planApprovalManager,
    };

    this.log(
      `[Swarm] Complete: ${successCount}/${results.length} succeeded, ${failCount} failed, ${totalToolCalls} tool calls, ~${(totalEstimatedInputTokens / 1000).toFixed(1)}K in / ${(totalEstimatedOutputTokens / 1000).toFixed(1)}K out tokens, ${totalDuration}ms`,
    );
    options?.onProgress?.("swarm", "✅ Swarm complete");

    return report;
  }

  /**
   * Format a detailed report with full results for each worker.
   */
  formatReport(report: SwarmReport): string {
    return report.summary;
  }
}
