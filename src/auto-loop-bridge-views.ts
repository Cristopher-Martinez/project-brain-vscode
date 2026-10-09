/**
 * auto-loop-bridge-views — Pure view mappers for the Auto Loop Bridge.
 *
 * Extracted from auto-loop-bridge-session.ts to keep file under 400 lines.
 * These map internal types to webview-safe view types.
 */

import type {
  BridgeSynthesis,
  BridgeSynthesisView,
  PmChatMessage,
  PmChatMessageView,
  PmSuggestionResult,
  PmSuggestionView,
} from "./auto-loop-bridge-types";

export function toSynthesisView(s: BridgeSynthesis): BridgeSynthesisView {
  return {
    synthesisId: s.synthesisId,
    round: s.round,
    contentPreview: s.content.slice(0, 200),
    timestamp: s.timestamp,
  };
}

export function toChatMessageView(m: PmChatMessage): PmChatMessageView {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    suggestion: m.suggestion ? toSuggestionView(m.suggestion) : undefined,
  };
}

export function toSuggestionView(s: PmSuggestionResult): PmSuggestionView {
  return {
    id: s.id,
    intent: s.intent,
    recommendation: s.recommendation,
    reasoning: s.reasoning,
    risk: s.risk,
    suggestedWorkerFeedback: s.suggestedWorkerFeedback,
  };
}
