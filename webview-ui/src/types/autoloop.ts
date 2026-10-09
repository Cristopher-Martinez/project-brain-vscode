// ─── Auto Loop Bridge Types (webview-side) ──────────────────────────────────

export interface AutoLoopBridgeSessionView {
  sessionId: string;
  title: string;
  status: "idle" | "waiting_pm" | "waiting_user" | "waiting_worker" | "closed";
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
}

export interface BridgeSynthesisView {
  synthesisId: string;
  round: number;
  contentPreview: string;
  timestamp: number;
}

export interface PmChatMessageView {
  id: string;
  role: "user" | "pm";
  text: string;
  timestamp: number;
  suggestion?: PmSuggestionView;
}

export type PmIntent = 'direct_answer' | 'delegate' | 'clarification' | 'status_check';

export interface PmSuggestionView {
  id: string;
  intent?: PmIntent;
  recommendation: string;
  reasoning: string;
  risk: "low" | "medium" | "high";
  suggestedWorkerFeedback: string;
}

export interface BridgeParticipants {
  user: { role: string; label: string; active: boolean };
  pm: { role: string; label: string; modelId?: string; active: boolean };
  worker: { role: string; label: string; active: boolean };
}

export interface BridgeTokenBudget {
  maxContextChars: number;
  maxRetrievedChunks: number;
  maxSuggestionTurns: number;
  maxTokensPerTurn?: number;
  consumedTurns: number;
}
