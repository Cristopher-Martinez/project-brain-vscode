import type { PmErrorCode } from "./auto-loop-bridge-types";

export interface MappedPmNetworkError {
  errorCode: PmErrorCode;
  userMessage: string;
  hint: string;
  detail: string;
  cause: string;
  stack: string;
  statusCode?: number;
  debugRaw: string;
}

export function mapPmNetworkError(
  err: unknown,
  pmProviderId: string,
  pmModelId: string,
): MappedPmNetworkError {
  const errText = toErrorText(err);
  const causeText = toCauseText(err);
  const stack = err instanceof Error ? err.stack ?? "" : "";
  const statusCode = getStatusCode(err);
  const combined = `${errText} ${causeText}`.toLowerCase();

  const errorCode = classifyErrorCode(combined, statusCode);
  const messageHint = mapUxCopy(errorCode, pmProviderId, pmModelId);

  return {
    errorCode,
    userMessage: messageHint.userMessage,
    hint: messageHint.hint,
    detail: `[BridgePM:${errorCode}] provider=${pmProviderId}/${pmModelId} status=${statusCode ?? "n/a"} error=${errText}`,
    cause: causeText,
    stack,
    statusCode,
    debugRaw: safeDebugRaw(err),
  };
}

function classifyErrorCode(combinedText: string, statusCode?: number): PmErrorCode {
  if (/econnrefused|connect\s+econnrefused/.test(combinedText)) {
    return "NETWORK_REFUSED";
  }

  if (/etimedout|timeout|aborterror|aborted/.test(combinedText)) {
    return "NETWORK_TIMEOUT";
  }

  if (/enotfound|eai_again|getaddrinfo|dns/.test(combinedText)) {
    return "NETWORK_DNS";
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode <= 499) {
    return "UPSTREAM_4XX";
  }

  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return "UPSTREAM_5XX";
  }

  return "UNKNOWN_PM_ERROR";
}

function mapUxCopy(errorCode: PmErrorCode, pmProviderId: string, pmModelId: string): { userMessage: string; hint: string } {
  const base = `No pude completar la respuesta del PM (${pmProviderId}/${pmModelId}).`;

  switch (errorCode) {
    case "NETWORK_REFUSED":
      return {
        userMessage: `${base} No hay conexion con el endpoint del proveedor.`,
        hint: "Verifica proxy/endpoint y que el servicio de red este levantado.",
      };
    case "NETWORK_TIMEOUT":
      return {
        userMessage: `${base} La solicitud expiro por tiempo.`,
        hint: "Reintenta y revisa conectividad o latencia del proveedor.",
      };
    case "NETWORK_DNS":
      return {
        userMessage: `${base} No se pudo resolver el host del proveedor.`,
        hint: "Revisa DNS, VPN o reglas de red locales.",
      };
    case "UPSTREAM_4XX":
      return {
        userMessage: `${base} El proveedor rechazo la solicitud (4xx).`,
        hint: "Valida API key, modelo configurado y permisos de cuenta.",
      };
    case "UPSTREAM_5XX":
      return {
        userMessage: `${base} El proveedor reporto una falla temporal (5xx).`,
        hint: "Reintenta en unos segundos o cambia de modelo/proveedor.",
      };
    default:
      return {
        userMessage: `${base} Ocurrio un error inesperado.`,
        hint: "Reintenta y revisa logs en modo debug para diagnostico.",
      };
  }
}

function toErrorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function toCauseText(err: unknown): string {
  if (!(err instanceof Error)) {
    return "";
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause === undefined) {
    return "";
  }
  if (cause instanceof Error) {
    return cause.message || String(cause);
  }
  if (typeof cause === "string") {
    return cause;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }

  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
    cause?: { status?: unknown; statusCode?: unknown };
  };

  const possible = [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
    candidate.response?.statusCode,
    candidate.cause?.status,
    candidate.cause?.statusCode,
  ];

  for (const value of possible) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function safeDebugRaw(err: unknown): string {
  if (err instanceof Error) {
    return JSON.stringify({
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: toCauseText(err),
    });
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
