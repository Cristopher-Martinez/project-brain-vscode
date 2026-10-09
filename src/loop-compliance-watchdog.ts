export const COMPLIANCE_WATCHDOG_IGNORE_LABEL = "Ignorar";
export const COMPLIANCE_RECENT_ACTIVITY_WINDOW_MS = 60_000;
export const COMPLIANCE_BUSY_GRACE_MS = 4 * 60 * 1000;
export const COMPLIANCE_MAILBOX_REMINDER_INTERVAL_MS = 5 * 60 * 1000;
export const COMPLIANCE_WATCHDOG_SENDER_ID = "__loop_watchdog__";

export interface ComplianceWatchdogPlan {
  level: 1 | 2 | 3;
  warningMessage: string;
  primaryLabel: string;
  secondaryLabel: string;
  ignoreLabel: string;
  preservesLoop: true;
}

export interface ComplianceWarnSuppressionInput {
  startedAt: number;
  now: number;
  lastActivityAt?: number;
}

function clampLevel(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  if (level >= 3) return 3;
  return 2;
}

export function buildComplianceWatchdogPlan(
  level: number,
  sessionId: string,
): ComplianceWatchdogPlan {
  const normalizedLevel = clampLevel(level);
  const shortSessionId = sessionId.substring(0, 8);

  const warningMessages: Record<1 | 2 | 3, string> = {
    1:
      `El agente no ha respondido al loop (${shortSessionId}...). ` +
      "Reabre el chat del loop para reinyectar el sessionId sin perder estado.",
    2:
      `SEGUNDO AVISO: el loop (${shortSessionId}...) sigue sin síntesis. ` +
      "Reabre el chat o márcalo como desconectado para conservarlo y recuperarlo luego.",
    3:
      `TERCER AVISO: el loop (${shortSessionId}...) sigue colgado, pero NO se cierra. ` +
      "Reabre el chat del loop o márcalo como desconectado para recuperarlo desde checkpoint.",
  };

  return {
    level: normalizedLevel,
    warningMessage: warningMessages[normalizedLevel],
    primaryLabel: "Reabrir chat del loop",
    secondaryLabel: "Marcar como desconectado",
    ignoreLabel: COMPLIANCE_WATCHDOG_IGNORE_LABEL,
    preservesLoop: true,
  };
}

export function shouldSuppressComplianceWarn(
  input: ComplianceWarnSuppressionInput,
): boolean {
  const lastActivityAt = input.lastActivityAt ?? 0;

  if (
    lastActivityAt > 0 &&
    input.now - lastActivityAt < COMPLIANCE_RECENT_ACTIVITY_WINDOW_MS
  ) {
    return true;
  }

  return input.now - input.startedAt < COMPLIANCE_BUSY_GRACE_MS;
}

export function buildComplianceMailboxReminder(sessionId: string): string {
  return [
    "Recordatorio automatico del monitor de protocolo.",
    `Sigues dentro de un loop activo con sessionId=${sessionId}.`,
    "Si sigues trabajando, conserva este sessionId y termina la ronda con loopAwaitInput.",
    "No respondas por texto directo fuera del loop.",
  ].join(" ");
}