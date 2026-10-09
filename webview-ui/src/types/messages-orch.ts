// ─── Orchestration Types ────────────────────────────────────────────────────

export type ModelTier = "free" | "standard" | "premium" | "ultra" | "custom";

export interface OrchAgentSlot {
  agentId: string;
  agentName: string;
  agentIcon: string;
  modelId: string;
  tier: ModelTier;
}

export interface OrchWorkerState {
  agentId: string;
  agentName: string;
  agentIcon: string;
  taskId: string;
  message?: string;
  success?: boolean;
  error?: string;
  model?: string;
  tier?: string;
  rounds?: number;
  toolCalls?: number;
  durationMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface OrchRoundState {
  roundNumber: number;
  launchedAt: number;
  completedAt?: number;
  workers: OrchWorkerState[];
  durationMs?: number;
}

export type MailboxMessageType =
  | "finding"
  | "question"
  | "challenge"
  | "update"
  | "blocker"
  | "consensus";

export interface MailboxMessage {
  id: string;
  from: string;
  to: string | null;
  type: MailboxMessageType;
  content: string;
  timestamp: number;
  read: boolean;
  replyTo?: string;
}

export interface MailboxStats {
  totalMessages: number;
  byType: Record<MailboxMessageType, number>;
  byWorker: Record<string, number>;
  unreadCount: number;
}

export type PlanApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "auto-approved"
  | "timed-out";

export interface TaskPlan {
  taskId: string;
  planText: string;
  intendedTools: string[];
  intendedReads: string[];
  intendedWrites: string[];
  estimatedRounds: number;
  riskLevel: "low" | "medium" | "high";
  createdAt: number;
}

export interface PlanApprovalRequest {
  taskId: string;
  taskPrompt: string;
  plan: TaskPlan;
  status: PlanApprovalStatus;
  decidedBy?: string;
  rejectionReason?: string;
  decidedAt?: number;
}

export interface OrchUiState {
  sessionId: string | null;
  state: "idle" | "planning" | "active" | "paused" | "completed";
  goal?: string;
  mode?: "parallel" | "sequential";
  team: OrchAgentSlot[];
  currentRound?: OrchRoundState;
  completedRounds: OrchRoundState[];
  startedAt?: number;
  updatedAt: number;
  summary?: string;
  totalTokensIn: number;
  totalTokensOut: number;
  workerLogs: Record<string, string>;
  pendingSynthesis?: string;
  awaitingFeedback: boolean;
  mailboxMessages: MailboxMessage[];
  mailboxStats?: MailboxStats;
  pendingPlanApprovals: PlanApprovalRequest[];
  originalPrompt?: string;
  enhancedPrompt?: string;
}
