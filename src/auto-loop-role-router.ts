/**
 * auto-loop-role-router — Communication rules and permission enforcement
 * for the Auto Loop Bridge.
 *
 * Enforces invariants:
 *  - PM Chat never reaches worker
 *  - Worker feedback only from user
 *  - Synthesis read-only for PM
 *  - PM cannot dispatch feedback directly
 */

import { log, logWarn } from "./logger";
import {
  BridgeChannel,
  BridgeMessageEnvelope,
  BridgeRole,
  BridgeSessionStatus,
  RouteValidation,
} from "./auto-loop-bridge-types";

// ── Permission Matrix ────────────────────────────────────────────

interface ChannelPermission {
  allowedOrigins: BridgeRole[];
  blockedStatuses?: BridgeSessionStatus[];
}

const CHANNEL_PERMISSIONS: Record<BridgeChannel, ChannelPermission> = {
  pm_chat: {
    allowedOrigins: ["user"],
    blockedStatuses: ["closed"],
  },
  worker_feedback: {
    allowedOrigins: ["user"],
    blockedStatuses: ["closed", "idle"],
  },
};

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate whether a message envelope is allowed through the bridge.
 */
export function validateRoute(
  envelope: BridgeMessageEnvelope,
  sessionStatus: BridgeSessionStatus
): RouteValidation {
  const permission = CHANNEL_PERMISSIONS[envelope.channel];
  if (!permission) {
    return { allowed: false, reason: `Unknown channel: ${envelope.channel}` };
  }

  if (!permission.allowedOrigins.includes(envelope.origin)) {
    logWarn(
      `[RoleRouter] Blocked: ${envelope.origin} tried to send on ${envelope.channel}`
    );
    return {
      allowed: false,
      reason: `Role '${envelope.origin}' cannot send on channel '${envelope.channel}'`,
    };
  }

  if (permission.blockedStatuses?.includes(sessionStatus)) {
    return {
      allowed: false,
      reason: `Channel '${envelope.channel}' blocked in status '${sessionStatus}'`,
    };
  }

  return { allowed: true };
}

/**
 * Validate that a promotion from PM suggestion to worker feedback is legitimate.
 * Only the user can promote suggestions.
 */
export function validatePromotion(
  origin: BridgeRole,
  sessionStatus: BridgeSessionStatus
): RouteValidation {
  if (origin !== "user") {
    logWarn(`[RoleRouter] Promotion blocked: origin '${origin}' is not user`);
    return {
      allowed: false,
      reason: "Only user can promote PM suggestions to worker feedback",
    };
  }

  if (sessionStatus === "closed") {
    return { allowed: false, reason: "Cannot promote in closed session" };
  }

  return { allowed: true };
}

/**
 * Validate that feedback dispatch is allowed.
 * Only user can dispatch, session must be in a valid state.
 */
export function validateDispatch(
  origin: BridgeRole,
  sessionStatus: BridgeSessionStatus
): RouteValidation {
  if (origin !== "user") {
    logWarn(`[RoleRouter] Dispatch blocked: origin '${origin}' is not user`);
    return {
      allowed: false,
      reason: "Only user can dispatch feedback to worker",
    };
  }

  const dispatchableStatuses: BridgeSessionStatus[] = [
    "waiting_user",
    "waiting_pm",
    "idle",
  ];
  if (!dispatchableStatuses.includes(sessionStatus)) {
    return {
      allowed: false,
      reason: `Cannot dispatch feedback in status '${sessionStatus}'`,
    };
  }

  return { allowed: true };
}

// ── Envelope Factory ─────────────────────────────────────────────

/**
 * Create a validated message envelope for PM Chat.
 * Returns null if validation fails.
 */
export function createPmChatEnvelope(
  sessionId: string,
  synthesisId: string,
  text: string,
  sessionStatus: BridgeSessionStatus
): BridgeMessageEnvelope | null {
  const envelope: BridgeMessageEnvelope = {
    channel: "pm_chat",
    origin: "user",
    sessionId,
    synthesisId,
    text,
    timestamp: Date.now(),
  };

  const result = validateRoute(envelope, sessionStatus);
  if (!result.allowed) {
    logWarn(`[RoleRouter] PM Chat envelope rejected: ${result.reason}`);
    return null;
  }

  log(`[RoleRouter] PM Chat envelope created for synthesis ${synthesisId}`);
  return envelope;
}

/**
 * Create a validated message envelope for Worker Feedback.
 * Returns null if validation fails.
 */
export function createWorkerFeedbackEnvelope(
  sessionId: string,
  text: string,
  sessionStatus: BridgeSessionStatus
): BridgeMessageEnvelope | null {
  const envelope: BridgeMessageEnvelope = {
    channel: "worker_feedback",
    origin: "user",
    sessionId,
    text,
    timestamp: Date.now(),
  };

  const result = validateRoute(envelope, sessionStatus);
  if (!result.allowed) {
    logWarn(`[RoleRouter] Worker feedback envelope rejected: ${result.reason}`);
    return null;
  }

  log("[RoleRouter] Worker feedback envelope created");
  return envelope;
}
