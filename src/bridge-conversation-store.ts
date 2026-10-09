/**
 * bridge-conversation-store — Persist bridge PM conversations to disk.
 *
 * Saves all PM chat messages (user + PM) to:
 *   .project-brain/loops/{sessionId}/conversation.json
 *
 * Provides:
 *  - appendMessage(): non-destructive append
 *  - loadConversation(): full history
 *  - getOldMessages(): messages outside the sliding window
 */

import * as fs from "fs";
import * as path from "path";
import { log, logError } from "./logger";
import { getConversationPath, getLoopDir } from "./brain-paths";
import type { PmErrorCode, PmIntent, PmRisk, PmSuggestionResult } from "./auto-loop-bridge-types";

// ── Types ─────────────────────────────────────────────────────────

export interface ConversationEntry {
  id: number;
  role: "user" | "pm";
  text: string;
  timestamp: string;
  synthesisId?: string;
  intent?: PmIntent;
  recommendation?: string;
  reasoning?: string;
  risk?: PmRisk;
  suggestedWorkerFeedback?: string;
  errorCode?: PmErrorCode;
  hint?: string;
  debugRaw?: string;
}

export interface ConversationFile {
  sessionId: string;
  objective: string;
  provider: string;
  model: string;
  createdAt: string;
  messages: ConversationEntry[];
}

export interface PersistedPmMessagePayload {
  intent: PmIntent;
  recommendation: string;
  reasoning?: string;
  risk?: PmRisk;
  suggestedWorkerFeedback?: string;
  errorCode?: PmErrorCode;
  debugRaw?: string;
}

export interface PersistedPmErrorPayload {
  errorCode: PmErrorCode;
  message: string;
  hint?: string;
  debugRaw?: string;
}

export type ConversationPayload = string | PmSuggestionResult | PersistedPmMessagePayload | PersistedPmErrorPayload;

export interface AppendConversationOptions {
  persistDebugRaw?: boolean;
}

const MAX_TEXT_LEN = 4000;
const MAX_REASONING_LEN = 2000;
const MAX_FEEDBACK_LEN = 2000;
const MAX_DEBUG_RAW_LEN = 6000;

// ── Public API ────────────────────────────────────────────────────

/**
 * Initialize a conversation file for a new bridge session.
 */
export function initConversation(
  wsRoot: string,
  sessionId: string,
  objective: string,
  provider: string,
  model: string,
): void {
  const filePath = getConversationPath(wsRoot, sessionId);
  if (fs.existsSync(filePath)) { return; }

  const dir = getLoopDir(wsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const data: ConversationFile = {
    sessionId,
    objective,
    provider,
    model,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  writeJson(filePath, data);
  log(`[ConvStore] Initialized conversation for ${sessionId}`);
}

/**
 * Append a message to the conversation log.
 * Creates the file if it doesn't exist (idempotent).
 */
export function appendMessage(
  wsRoot: string,
  sessionId: string,
  role: "user" | "pm",
  payload: ConversationPayload,
  synthesisId?: string,
  options?: AppendConversationOptions,
): void {
  const filePath = getConversationPath(wsRoot, sessionId);
  const conv = loadConversationFile(filePath);
  if (!conv) { return; }

  const entry = buildConversationEntry(
    conv.messages.length + 1,
    role,
    payload,
    synthesisId,
    options,
  );

  conv.messages.push(entry);
  writeJson(filePath, conv);
}

/**
 * Load the full conversation from disk.
 */
export function loadConversation(
  wsRoot: string,
  sessionId: string,
): ConversationFile | null {
  const filePath = getConversationPath(wsRoot, sessionId);
  return loadConversationFile(filePath);
}

/**
 * Get messages that fall outside the sliding window.
 * These are candidates for RAG retrieval.
 *
 * @param windowSize Number of most-recent messages to exclude (the "active" window)
 * @returns Messages older than the window, chronological order
 */
export function getOldMessages(
  wsRoot: string,
  sessionId: string,
  windowSize: number,
): ConversationEntry[] {
  const conv = loadConversation(wsRoot, sessionId);
  if (!conv || conv.messages.length <= windowSize) { return []; }
  return conv.messages.slice(0, conv.messages.length - windowSize);
}

// ── Internal ──────────────────────────────────────────────────────

function loadConversationFile(filePath: string): ConversationFile | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ConversationFile;
    return normalizeConversationFile(parsed);
  } catch (err) {
    logError(`[ConvStore] Failed to load: ${err}`);
    return null;
  }
}

function buildConversationEntry(
  id: number,
  role: "user" | "pm",
  payload: ConversationPayload,
  synthesisId: string | undefined,
  options?: AppendConversationOptions,
): ConversationEntry {
  if (role === "user") {
    return {
      id,
      role,
      text: capRequiredString(typeof payload === "string" ? payload : serializePayload(payload), MAX_TEXT_LEN),
      timestamp: new Date().toISOString(),
      synthesisId,
    };
  }

  const normalized = normalizePmPayload(payload);
  const includeDebugRaw = !!options?.persistDebugRaw;

  return {
    id,
    role,
    text: capRequiredString(normalized.recommendation ?? normalized.message ?? "", MAX_TEXT_LEN),
    timestamp: new Date().toISOString(),
    synthesisId,
    intent: normalized.intent,
    recommendation: capString(normalized.recommendation, MAX_TEXT_LEN),
    reasoning: capString(normalized.reasoning, MAX_REASONING_LEN),
    risk: normalized.risk,
    suggestedWorkerFeedback: capString(normalized.suggestedWorkerFeedback, MAX_FEEDBACK_LEN),
    errorCode: normalized.errorCode,
    hint: capString(normalized.hint, MAX_REASONING_LEN),
    debugRaw: includeDebugRaw ? capString(normalized.debugRaw, MAX_DEBUG_RAW_LEN) : undefined,
  };
}

function normalizePmPayload(payload: ConversationPayload): {
  intent?: PmIntent;
  recommendation?: string;
  reasoning?: string;
  risk?: PmRisk;
  suggestedWorkerFeedback?: string;
  errorCode?: PmErrorCode;
  hint?: string;
  debugRaw?: string;
  message?: string;
} {
  if (typeof payload === "string") {
    const parsed = tryParseJson(payload);
    if (parsed) {
      return normalizePmPayload(parsed as ConversationPayload);
    }
    return { recommendation: payload, message: payload };
  }

  const maybeError = payload as PersistedPmErrorPayload;
  if (maybeError.errorCode && "message" in maybeError) {
    return {
      errorCode: maybeError.errorCode,
      recommendation: maybeError.message,
      message: maybeError.message,
      hint: maybeError.hint,
      debugRaw: maybeError.debugRaw,
    };
  }

  const maybeSuggestion = payload as PersistedPmMessagePayload;
  return {
    intent: maybeSuggestion.intent,
    recommendation: maybeSuggestion.recommendation,
    reasoning: maybeSuggestion.reasoning,
    risk: maybeSuggestion.risk,
    suggestedWorkerFeedback: maybeSuggestion.suggestedWorkerFeedback,
    errorCode: maybeSuggestion.errorCode,
    debugRaw: maybeSuggestion.debugRaw ?? (payload as PmSuggestionResult).raw,
  };
}

function normalizeConversationFile(file: ConversationFile): ConversationFile {
  if (!Array.isArray(file.messages)) {
    return { ...file, messages: [] };
  }

  const normalizedMessages = file.messages.map((entry, index) => normalizeLegacyEntry(entry, index + 1));

  return {
    ...file,
    messages: normalizedMessages,
  };
}

function normalizeLegacyEntry(entry: ConversationEntry, id: number): ConversationEntry {
  const base: ConversationEntry = {
    id,
    role: entry.role,
    text: capRequiredString(entry.text ?? "", MAX_TEXT_LEN),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    synthesisId: entry.synthesisId,
  };

  if (entry.role !== "pm") {
    return base;
  }

  const parsed = tryParseJson(entry.text);
  if (!parsed || typeof parsed !== "object") {
    return {
      ...base,
      recommendation: base.text,
    };
  }

  const normalized = normalizePmPayload(parsed as ConversationPayload);
  return {
    ...base,
    text: capRequiredString(normalized.recommendation ?? normalized.message ?? base.text, MAX_TEXT_LEN),
    intent: normalized.intent,
    recommendation: capString(normalized.recommendation, MAX_TEXT_LEN),
    reasoning: capString(normalized.reasoning, MAX_REASONING_LEN),
    risk: normalized.risk,
    suggestedWorkerFeedback: capString(normalized.suggestedWorkerFeedback, MAX_FEEDBACK_LEN),
    errorCode: normalized.errorCode,
    hint: capString(normalized.hint, MAX_REASONING_LEN),
  };
}

function capString(value: string | undefined, maxLen: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length <= maxLen) {
    return value;
  }
  return value.slice(0, maxLen);
}

function capRequiredString(value: string, maxLen: number): string {
  const capped = capString(value, maxLen);
  return capped ?? "";
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function writeJson(filePath: string, data: ConversationFile): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logError(`[ConvStore] Failed to write: ${err}`);
  }
}