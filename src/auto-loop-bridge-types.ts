/**
 * auto-loop-bridge-types — Central contracts for the Auto Loop Bridge subsystem.
 *
 * Defines session state, participants, synthesis, PM request/response,
 * budgets, events, and all shared types consumed by bridge modules.
 */

// ———————————————— Session  ————————————————

export type BridgeSessionStatus =
  | "idle"
  | "waiting_pm"
  | "waiting_user"
  | "waiting_worker"
  | "closed";

export interface AutoLoopBridgeSessionState {
  sessionId: string;
  title: string;
  status: BridgeSessionStatus;
  workerLoopSessionId: string;
  pmProviderId: string;
  pmModelId: string;
  activeSynthesisId: string | null;
  taskMemoryRef: string;
  tokenBudget: BridgeTokenBudget;
  pmChatThreads: Record<string, PmThreadSummary>;
  workerFeedbackDraft: string;
  participantState: BridgeParticipants;
  createdAt: number;
  updatedAt: number;
}

// —————————————— Participants ——————————————

export interface BridgeParticipants {
  user: BridgeParticipant;
  pm: BridgeParticipant;
  worker: BridgeParticipant;
}

export interface BridgeParticipant {
  role: BridgeRole;
  label: string;
  modelId?: string;
  active: boolean;
}

export type BridgeRole = "user" | "pm" | "worker";

// —————————————— Token Budget ——————————————

export interface BridgeTokenBudget {
  maxContextChars: number;
  maxRetrievedChunks: number;
  maxSuggestionTurns: number;
  maxTokensPerTurn?: number;
  consumedTurns: number;
}

// ——————————————— Synthesis ————————————————

export interface BridgeSynthesis {
  synthesisId: string;
  sessionId: string;
  content: string;
  round: number;
  timestamp: number;
}

// ———————————————— PM Chat —————————————————

export interface PmThreadSummary {
  synthesisId: string;
  summary: string;
  lastUpdatedAt: number;
  turnCount: number;
  modelId?: string;
}

export interface PmChatMessage {
  id: string;
  synthesisId: string;
  role: "user" | "pm" | "worker";
  text: string;
  timestamp: number;
  suggestion?: PmSuggestionResult;
}

// ——————————— PM Strategy Types ————————————

export interface PMProviderConfig {
  providerId: string;
  apiKeyRef: string;
  enabled: boolean;
  enabledModelIds: string[];
  defaultModelId?: string;
}

export interface PMModelDescriptor {
  id: string;
  label: string;
  contextWindow?: number;
  supportsStreaming?: boolean;
  supportsSystemPrompt?: boolean;
  enabledByDefault?: boolean;
}

export interface ProviderValidationResult {
  valid: boolean;
  error?: string;
}

export interface PMRequestInput {
  objective: string;
  activeSynthesis: BridgeSynthesis;
  decisionsSummary: string;
  retrievalPack: string[];
  pmChatHistory: PmChatMessage[];
  userMessage: string;
  responseLanguage?: string;
  identityPrompt?: string;
  workerLoopSessionId?: string;
  workerLoopState?: "active" | "awaiting" | "completed" | "error" | "disconnected";
  canDispatchFeedback?: boolean;
  budget: BridgeTokenBudget;
  bitacoraContext?: string;
  projectMemoryContext?: string;
  preClassifiedIntent?: PmIntent;
}

export interface PMProviderRequest {
  model: string;
  messages: PMProviderMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface PMProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PMProviderResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
}

export type PmIntent = 'direct_answer' | 'delegate' | 'clarification' | 'status_check';

export const PM_INTENT_VALUES: readonly PmIntent[] = ['direct_answer', 'delegate', 'clarification', 'status_check'] as const;

export type PmRisk = "low" | "medium" | "high";

export type PmErrorCode =
  | "NETWORK_REFUSED"
  | "NETWORK_TIMEOUT"
  | "NETWORK_DNS"
  | "UPSTREAM_4XX"
  | "UPSTREAM_5XX"
  | "UNKNOWN_PM_ERROR"
  | "BRIDGE_ROUTE_BLOCKED"
  | "BRIDGE_RATE_LIMIT"
  | "BRIDGE_SYNTHESIS_NOT_FOUND";

export interface PmSuggestionResult {
  id: string;
  intent: PmIntent;
  recommendation: string;
  reasoning: string;
  risk: PmRisk;
  suggestedWorkerFeedback: string;
  errorCode?: PmErrorCode;
  debugRaw?: string;
  /** @deprecated Use debugRaw instead. Kept for backward compatibility. */
  raw?: string;
}

// ——————————————— PM Client ————————————————

export interface PMClient {
  send(request: PMProviderRequest): Promise<PMProviderResponse>;
  dispose?(): void;
}

// —————————————— Task Memory ———————————————

export interface BridgeTaskMemoryData {
  sessionId: string;
  objective: string;
  approvedDecisions: BridgeDecision[];
  rejectedSuggestions: string[];
  pmChatSummaries: Record<string, string>;
  businessContext: string;
  updatedAt: number;
}

export interface BridgeDecision {
  id: string;
  synthesisId: string;
  summary: string;
  approvedAt: number;
}

// —————————————— Role Router ———————————————

export type BridgeChannel = "pm_chat" | "worker_feedback";

export interface BridgeMessageEnvelope {
  channel: BridgeChannel;
  origin: BridgeRole;
  sessionId: string;
  synthesisId?: string;
  text: string;
  timestamp: number;
}

export interface RouteValidation {
  allowed: boolean;
  reason?: string;
}

// —— Session Bitacora ——————————————————————————

export type BitacoraEntryType = "decision" | "constraint" | "context" | "correction";

export interface BitacoraEntry {
  turn: number;
  timestamp: number;
  type: BitacoraEntryType;
  text: string;
}

export interface SessionBitacora {
  sessionId: string;
  entries: BitacoraEntry[];
  maxChars: number;
  updatedAt: number;
}

// —— Project Memory Context ————————————————————

export interface ProjectMemoryContext {
  bootSummary: string;
  ragChunks: string[];
  fetchedAt: number;
}
// —— Session Bitacora ——————————————————————————

// —— Project Memory Context ————————————————————

export type BridgeEventType =
  | "session_created"
  | "session_updated"
  | "session_closed"
  | "synthesis_selected"
  | "synthesis_pushed"
  | "pm_suggestion"
  | "feedback_drafted"
  | "feedback_dispatched"
  | "budget_warning"
  | "budget_exhausted"
  | "budget_reset"
  | "error";

export interface BridgeEvent {
  type: BridgeEventType;
  sessionId: string;
  payload: unknown;
  timestamp: number;
}

// ———————————— Webview Messages ————————————

export type AutoLoopWebviewInbound =
  | { type: "createAutoLoopBridgeSession"; title: string; workerLoopSessionId: string; goal?: string }
  | { type: "selectAutoLoopBridgeSession"; sessionId: string }
  | { type: "selectAutoLoopSynthesis"; sessionId: string; synthesisId: string }
  | { type: "setAutoLoopPmModel"; sessionId: string; synthesisId?: string; modelId: string }
  | { type: "sendAutoLoopPmChat"; sessionId: string; synthesisId: string; text: string; modelId?: string }
  | { type: "promotePmSuggestionToWorkerFeedback"; sessionId: string; suggestionId: string }
  | { type: "updateAutoLoopWorkerFeedbackDraft"; sessionId: string; text: string }
  | { type: "dispatchAutoLoopWorkerFeedback"; sessionId: string; text: string }
  | { type: "requestAutoLoopBridgeState" };

export type AutoLoopWebviewOutbound =
  | { type: "autoLoopBridgeState"; sessions: AutoLoopBridgeSessionView[] }
  | { type: "autoLoopBridgeSessionCreated"; session: AutoLoopBridgeSessionView }
  | { type: "autoLoopBridgeSessionUpdated"; session: AutoLoopBridgeSessionView }
  | { type: "autoLoopBridgeActiveChanged"; sessionId: string }
  | { type: "autoLoopPmSuggestion"; sessionId: string; suggestion: PmSuggestionView }
  | { type: "autoLoopFeedbackDraftUpdated"; sessionId: string; text: string }
  | { type: "autoLoopFeedbackDispatched"; sessionId: string; dispatchedAt: number }
  | { type: "autoLoopError"; sessionId?: string; message: string };

// ——————————————— View Model ———————————————

export interface AutoLoopBridgeSessionView {
  sessionId: string;
  title: string;
  status: BridgeSessionStatus;
  workerLoopSessionId: string;
  workerLoopState: "active" | "awaiting" | "completed" | "error" | "disconnected";
  pmProviderLabel: string;
  pmModelLabel: string;
  availableModels: Array<{ id: string; label: string }>;
  activeSynthesisId: string | null;
  syntheses: BridgeSynthesisView[];
  pmChatMessages: PmChatMessageView[];
  workerFeedbackDraft: string;
  participants: BridgeParticipants;
  tokenBudget: BridgeTokenBudget;
  preClassifiedIntent?: PmIntent;
}

export interface BridgeSynthesisView {
  synthesisId: string;
  round: number;
  contentPreview: string;
  timestamp: number;
}

export interface PmChatMessageView {
  id: string;
  role: "user" | "pm" | "worker";
  text: string;
  timestamp: number;
  suggestion?: PmSuggestionView;
}

export interface PmSuggestionView {
  id: string;
  intent: PmIntent;
  recommendation: string;
  reasoning: string;
  risk: PmRisk;
  suggestedWorkerFeedback: string;
}