// ============================================================
// SOURCE MAP — plan-approval.ts
// Plan Approval Flow: Two-phase worker execution
// Phase 1: Workers plan in read-only mode → produce a plan
// Phase 2: Plans reviewed (auto/manual) → approved plans execute
// ============================================================
// L1-10:       Source map
// L12-70:      Types (TaskPlan, PlanApprovalRequest, etc.)
// L72-238:     PlanApprovalManager class
// L240-241:    Re-exports from plan-approval-helpers.ts
// ============================================================

import * as vscode from "vscode";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A plan produced by a worker in planning mode. */
export interface TaskPlan {
  /** The task ID this plan belongs to */
  taskId: string;
  /** Worker-generated plan text (what it intends to do) */
  planText: string;
  /** Tools the worker plans to use */
  intendedTools: string[];
  /** Files the worker plans to read */
  intendedReads: string[];
  /** Files the worker plans to modify */
  intendedWrites: string[];
  /** Estimated complexity (from worker's perspective) */
  estimatedRounds: number;
  /** Risk assessment (from worker's analysis) */
  riskLevel: "low" | "medium" | "high";
  /** Timestamp when the plan was generated */
  createdAt: number;
}

export type PlanApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "auto-approved"
  | "timed-out";

/** A plan awaiting approval — bridges worker output to HQ UI. */
export interface PlanApprovalRequest {
  /** The task ID */
  taskId: string;
  /** The original task prompt */
  taskPrompt: string;
  /** The generated plan */
  plan: TaskPlan;
  /** Current approval status */
  status: PlanApprovalStatus;
  /** Who/what approved it */
  decidedBy?: string;
  /** Optional rejection reason */
  rejectionReason?: string;
  /** Timestamp when decided */
  decidedAt?: number;
}

export interface PlanApprovalConfig {
  /** Auto-approve low-risk plans (default: false) */
  autoApproveLowRisk?: boolean;
  /** Timeout in ms — auto-approve if no response (default: 0 = wait forever) */
  timeoutMs?: number;
  /** Logger */
  log?: (msg: string) => void;
}

// ─── PlanApprovalManager ────────────────────────────────────────────────────

/**
 * Manages the plan → approve/reject → execute lifecycle.
 *
 * Flow:
 * 1. Worker runs in "plan-only" mode (read-only tools, planning prompt)
 * 2. Worker produces a structured plan (TaskPlan)
 * 3. Plan submitted to PlanApprovalManager
 * 4. Manager emits event → Brain HQ shows the plan for review
 * 5. User approves/rejects via HQ UI (or auto-approve kicks in)
 * 6. Resolved promise unblocks the orchestrator to proceed with execution
 */
export class PlanApprovalManager {
  private pendingPlans = new Map<
    string,
    {
      request: PlanApprovalRequest;
      resolve: (approved: boolean) => void;
    }
  >();

  private readonly _onDidUpdatePlans = new vscode.EventEmitter<
    PlanApprovalRequest[]
  >();
  /** Fires when pending plans change — Brain HQ subscribes to this. */
  readonly onDidUpdatePlans = this._onDidUpdatePlans.event;

  private log: (msg: string) => void;
  private config: PlanApprovalConfig;

  constructor(config: PlanApprovalConfig = {}) {
    this.config = config;
    this.log = config.log ?? (() => {});
    this.log(
      `[PlanApproval] Initialized (autoApproveLowRisk=${config.autoApproveLowRisk ?? false}, timeoutMs=${config.timeoutMs ?? 0})`,
    );
  }

  /**
   * Submit a plan for approval. Returns a promise that resolves to
   * `true` (approved) or `false` (rejected).
   */
  async submitPlan(
    taskId: string,
    taskPrompt: string,
    plan: TaskPlan,
  ): Promise<boolean> {
    const request: PlanApprovalRequest = {
      taskId,
      taskPrompt,
      plan,
      status: "pending",
    };

    // Auto-approve low-risk plans if configured
    if (this.config.autoApproveLowRisk && plan.riskLevel === "low") {
      request.status = "auto-approved";
      request.decidedBy = "auto-approve (low risk)";
      request.decidedAt = Date.now();
      this.log(
        `[PlanApproval] Auto-approved ${taskId} (low risk, ${plan.intendedWrites.length} writes)`,
      );
      return true;
    }

    return new Promise<boolean>((resolve) => {
      this.pendingPlans.set(taskId, { request, resolve });
      this._onDidUpdatePlans.fire(this.getPendingPlans());
      this.log(`[PlanApproval] Plan submitted for ${taskId} — awaiting review`);

      // Timeout auto-approval
      if (this.config.timeoutMs && this.config.timeoutMs > 0) {
        setTimeout(() => {
          if (this.pendingPlans.has(taskId)) {
            this.log(`[PlanApproval] Timeout for ${taskId} — auto-approving`);
            this.approvePlan(taskId, "timeout-auto-approve");
          }
        }, this.config.timeoutMs);
      }
    });
  }

  /** Approve a pending plan. */
  approvePlan(taskId: string, decidedBy: string = "user"): void {
    const entry = this.pendingPlans.get(taskId);
    if (!entry) {
      this.log(
        `[PlanApproval] Cannot approve ${taskId} — not found in pending`,
      );
      return;
    }

    entry.request.status =
      decidedBy === "timeout-auto-approve" ? "timed-out" : "approved";
    entry.request.decidedBy = decidedBy;
    entry.request.decidedAt = Date.now();

    this.pendingPlans.delete(taskId);
    this._onDidUpdatePlans.fire(this.getPendingPlans());
    entry.resolve(true);
    this.log(`[PlanApproval] Approved ${taskId} by ${decidedBy}`);
  }

  /** Reject a pending plan. */
  rejectPlan(
    taskId: string,
    reason?: string,
    decidedBy: string = "user",
  ): void {
    const entry = this.pendingPlans.get(taskId);
    if (!entry) {
      this.log(`[PlanApproval] Cannot reject ${taskId} — not found in pending`);
      return;
    }

    entry.request.status = "rejected";
    entry.request.decidedBy = decidedBy;
    entry.request.rejectionReason = reason;
    entry.request.decidedAt = Date.now();

    this.pendingPlans.delete(taskId);
    this._onDidUpdatePlans.fire(this.getPendingPlans());
    entry.resolve(false);
    this.log(`[PlanApproval] Rejected ${taskId}: ${reason ?? "(no reason)"}`);
  }

  /** Approve all pending plans at once. */
  approveAll(decidedBy: string = "user"): void {
    const count = this.pendingPlans.size;
    this.log(
      `[PlanApproval] approveAll: ${count} pending plans, decidedBy=${decidedBy}`,
    );
    for (const taskId of [...this.pendingPlans.keys()]) {
      this.approvePlan(taskId, decidedBy);
    }
  }

  /** Reject all pending plans at once. */
  rejectAll(reason?: string, decidedBy: string = "user"): void {
    const count = this.pendingPlans.size;
    this.log(
      `[PlanApproval] rejectAll: ${count} pending plans, reason=${reason ?? "(none)"}, decidedBy=${decidedBy}`,
    );
    for (const taskId of [...this.pendingPlans.keys()]) {
      this.rejectPlan(taskId, reason, decidedBy);
    }
  }

  /** Get all currently pending plans. */
  getPendingPlans(): PlanApprovalRequest[] {
    return [...this.pendingPlans.values()].map((e) => e.request);
  }

  /** Check if there are pending plans. */
  hasPendingPlans(): boolean {
    return this.pendingPlans.size > 0;
  }

  /** Dispose — reject all pending plans. */
  dispose(): void {
    this.log(
      `[PlanApproval] Disposing (${this.pendingPlans.size} pending plans will be rejected)`,
    );
    this.rejectAll("session-ended", "system");
    this._onDidUpdatePlans.dispose();
  }
}

// Re-export planning helpers for backward compatibility
export { planOnlyToolFilter, buildPlanningPrompt, parsePlanOutput } from "./plan-approval-helpers";
