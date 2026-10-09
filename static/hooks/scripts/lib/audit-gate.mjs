/**
 * audit-gate.mjs — Pre-synthesis audit enforcement for loop sessions.
 * Forces the agent to self-audit code before sending synthesis via loopAwaitInput.
 * Tracks edited files, audit rounds, and ensures quality gates are met.
 * Flow:
 * 1. PostToolUse: When edit tools succeed, record files in audit-state.json
 * 2. PreToolUse: When loopAwaitInput called, check if audit was done
 *    - Round 0 (no audit): DENY + inject audit requirements
 *    - Round 1-3: Allow but inject verification reminders
 *    - Round 4+: Inject "ask user for another round"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runTestsForModules, runTscCheck } from "./audit-runners.mjs";
import { getLoopDir } from "./brain-paths.mjs";
import { checkTestEditCorrelation } from "./code-discipline.mjs";
import {
  resetFastGateConvergence,
  runFastGateHook,
} from "./fast-gate-hook.mjs";
import { runHPDGateHook } from "./hpd-gate-hook.mjs";
import { checkInvariantGate } from "./invariant-gate.mjs";

/**
 * Get the audit state file path for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function getAuditStatePath(cwd, sessionId) {
  const dir = getLoopDir(cwd, sessionId || "_default");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return join(dir, "audit-state.json");
}

/**
 * Read the current audit state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ editedFiles: string[], auditRound: number, lastAuditTs: number|null, synthesisAttempts: number, urgentMessages: string[] }}
 */
export function readAuditState(cwd, sessionId) {
  const defaults = {
    editedFiles: [],
    auditRound: 0,
    lastAuditTs: null,
    synthesisAttempts: 0,
    urgentMessages: [],
  };

  try {
    const fp = getAuditStatePath(cwd, sessionId);
    if (!existsSync(fp)) return defaults;
    let raw = readFileSync(fp, "utf8");
    // Strip BOM (PowerShell writes UTF-8 BOM by default)
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const data = JSON.parse(raw);
    return { ...defaults, ...data };
  } catch {
    return defaults;
  }
}

/**
 * Write the audit state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {object} state
 */
export function writeAuditState(cwd, sessionId, state) {
  try {
    const fp = getAuditStatePath(cwd, sessionId);
    writeFileSync(fp, JSON.stringify(state, null, 2));
  } catch {}
}

/**
 * Record that a file was edited this session.
 * Called from PostToolUse hook when edit tools succeed.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string|string[]} filePaths
 */
export function recordEditedFile(cwd, sessionId, filePaths) {
  if (!sessionId) return;

  const state = readAuditState(cwd, sessionId);
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  for (const fp of paths) {
    if (fp && !state.editedFiles.includes(fp)) {
      state.editedFiles.push(fp);
    }
  }

  // Reset audit round when new files are edited after an audit
  if (state.auditRound > 0) {
    state.auditRound = 0;
    state.synthesisAttempts = 0;
  }

  writeAuditState(cwd, sessionId, state);
}

/**
 * Record that a read/verify action was performed (audit gate tracking).
 * Called from PostToolUse hook when read tools succeed.
 * @param {string} cwd
 * @param {string} sessionId
 */
export function recordAuditAction(cwd, sessionId) {
  if (!sessionId) return;
  const state = readAuditState(cwd, sessionId);
  state.auditRound = (state.auditRound || 0) + 1;
  state.lastAuditTs = Date.now();
  writeAuditState(cwd, sessionId, state);
}

/**
 * Record an urgent message from the user.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} message
 */
export function recordUrgentMessage(cwd, sessionId, message) {
  if (!sessionId || !message) return;
  const state = readAuditState(cwd, sessionId);
  state.urgentMessages.push(message);
  // Keep last 5 urgent messages
  if (state.urgentMessages.length > 5) {
    state.urgentMessages = state.urgentMessages.slice(-5);
  }
  writeAuditState(cwd, sessionId, state);
}

/**
 * Detect urgent keywords in user text.
 * @param {string} text
 * @returns {boolean}
 */
export function isUrgentMessage(text) {
  if (!text) return false;
  const urgentPatterns = [
    /\bURGENTE?\b/i,
    /\bSTOP\b/i,
    /\bPARA\b/i,
    /\bALTO\b/i,
    /\bBLOQUE/i,
    /\bCRITIC/i,
    /\bEMERGENC/i,
    /\b⛔\b/,
    /\b🚨\b/,
    /\b❌\b/,
    /\bIMPORTANT[E]?\b/i,
    /\bPRIORIDAD\b/i,
  ];
  return urgentPatterns.some((p) => p.test(text));
}

/** Max age (ms) for a classification to be considered fresh — 10 minutes. */
const CLASSIFICATION_TTL_MS = 10 * 60 * 1000;

/** Read fastGate config from discipline.json. */
function readFastGateConfig(cwd) {
  const defaults = {
    enabled: false,
    mode: "report",
    branchThreshold: 70,
    maxConvergenceIterations: 3,
    lintEscalationStrikes: 3,
    requireCoverage: false,
  };
  try {
    // Try .github/hooks/discipline.json first (deployed target), fall back to sessionsDir
    const paths = [
      join(cwd, ".github", "hooks", "discipline.json"),
      join(cwd, "discipline.json"),
    ];
    for (const fp of paths) {
      if (existsSync(fp)) {
        const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
        return data.fastGate ? { ...defaults, ...data.fastGate } : defaults;
      }
    }
  } catch {}
  return defaults;
}

/** Read HPD gate config from discipline.json. */
function readHPDConfig(cwd) {
  const defaults = {
    enabled: false,
    mode: "report",
    minScoreEnforce: 50,
    minScoreT4: 65,
  };
  try {
    const paths = [
      join(cwd, ".github", "hooks", "discipline.json"),
      join(cwd, "discipline.json"),
    ];
    for (const fp of paths) {
      if (existsSync(fp)) {
        const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
        return data.hpdGate ? { ...defaults, ...data.hpdGate } : defaults;
      }
    }
  } catch {}
  return defaults;
}

/**
 * Read the LLM/subagent classification file for a session.
 * Returns classification or null if missing/stale.
 * NOTE: No hash matching — classification is intent-based, not text-matched.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ verdict: string, reason: string, ts: number }|null}
 */
function readClassification(cwd, sessionId) {
  try {
    const dir = getLoopDir(cwd, sessionId || "_default");
    const fp = join(dir, "audit-classification.json");
    if (!existsSync(fp)) return null;
    const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    if (Date.now() - data.ts > CLASSIFICATION_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

// Re-export runners for backward compatibility
export { runTestsForModules, runTscCheck };

/**
 * Build the audit gate context for a loopAwaitInput call.
 * Returns { decision, context } where decision is "deny" or "allow".
 *
 * Flow:
 * 1. No edits → allow immediately
 * 2. Fresh classification with "no-audit" → allow (bypass rounds)
 * 3. Round 0 → deny once (require agent to review edited files)
 * 4. Rounds 1-3 → allow with reminder
 * 5. Round 4+ → allow, suggest asking user
 *
 * Classification is OPTIONAL — a bonus bypass, not a requirement.
 * If no classification exists, round-based audit works as fallback.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} synthesisText - The synthesis the agent wants to send
 * @returns {{ decision: "deny"|"allow", context: string }}
 */
export function evaluateAuditGate(cwd, sessionId, synthesisText) {
  const state = readAuditState(cwd, sessionId);
  const MAX_AUTO_ROUNDS = 3;

  // ── Audit bypass toggle: if user disabled audit gate, allow silently ──
  if (state.auditBypass) {
    return { decision: "allow", context: "" };
  }

  // Build urgent messages header (always visible)
  let urgentHeader = "";
  if (state.urgentMessages.length > 0) {
    urgentHeader =
      `🚨 MENSAJES URGENTES DEL USUARIO (procesar ANTES de cualquier auditoría):\n` +
      state.urgentMessages.map((m, i) => `  ${i + 1}. ${m}`).join("\n") +
      `\n\n`;
  }

  // No edits this session — no audit needed
  if (state.editedFiles.length === 0) {
    return {
      decision: "allow",
      context: urgentHeader || "",
    };
  }

  // ══════ Collect-All Gate Evaluation ══════
  // Run ALL gates and aggregate failures instead of fail-fast.
  // This way the agent sees every issue in one pass.
  const gateFailures = [];
  let tscPassed = true;

  // ── TSC Compilation Gate ──
  const tscResult = runTscCheck(cwd);
  if (!tscResult.pass) {
    const editedBases = state.editedFiles.map((f) => f.split(/[/\\]/).pop());
    const hasRelevantError = editedBases.some((b) =>
      tscResult.output.includes(b),
    );
    if (hasRelevantError) {
      tscPassed = false;
      gateFailures.push(
        `❌ TSC COMPILATION: TypeScript no compila.\n` +
          tscResult.output.substring(0, 800),
      );
    }
  }

  // ── Test Gate (skip if TSC failed — tests can't run) ──
  if (tscPassed) {
    const testResult = runTestsForModules(cwd, state.editedFiles);
    if (!testResult.pass) {
      gateFailures.push(
        `❌ TEST EXECUTION: Tests fallaron para módulos editados:\n` +
          testResult.output.substring(0, 800),
      );
    }
  }

  // ── Test Correlation Gate (ADVISORY — never blocks) ──
  // This is a heuristic that cannot distinguish a pure refactor (file split with
  // API preserved + tsc passing) from genuinely new untested code. Blocking on it
  // froze loops after refactors (see 05_TROUBLESHOOTING: "GATE_BLOCKED congelado por
  // TEST CORRELATION tras refactor puro"). The real quality bar is TSC compilation
  // + test execution, which remain blocking above. Correlation only advises now.
  let testCorrelationAdvisory = "";
  const correlationWarnings = checkTestEditCorrelation(state.editedFiles, cwd);
  if (correlationWarnings.length > 0) {
    testCorrelationAdvisory =
      `\n📋 TEST CORRELATION (aviso, no bloquea):\n` +
      correlationWarnings.join("\n") +
      `\nSi añadiste funcionalidad nueva, considera actualizar/crear tests. ` +
      `Refactors puros (split de archivos con API preservada) pueden ignorar este aviso.\n`;
  }

  // ── Invariant Deletion Gate ──
  const invariantResult = checkInvariantGate(cwd);
  if (!invariantResult.pass) {
    gateFailures.push(`❌ INVARIANT GATE:\n` + invariantResult.message);
  }

  // ── Fast Gate (coverage + lint + convergence) ──
  let fastGateContext = "";
  const fastGateConfig = readFastGateConfig(cwd);
  if (fastGateConfig.enabled) {
    const fastGateResult = runFastGateHook(cwd, fastGateConfig, {
      editedFiles: state.editedFiles,
    });
    fastGateContext = fastGateResult.report || "";
    if (fastGateResult.blocking) {
      gateFailures.push(`❌ FAST GATE:\n` + fastGateContext);
      fastGateContext = ""; // Already in failures
    } else if (fastGateContext) {
      fastGateContext = `\n📊 FAST GATE (report-only):\n${fastGateContext}\n`;
    }
  }

  // Thread the (non-blocking) test-correlation advisory into the report context
  // so it surfaces in every allow path without ever blocking the synthesis.
  fastGateContext += testCorrelationAdvisory;

  // ── HPD Gate (test depth analysis) ──
  let hpdGateContext = "";
  const hpdConfig = readHPDConfig(cwd);
  if (hpdConfig.enabled) {
    try {
      const hpdResult = runHPDGateHook(cwd, hpdConfig, {
        editedFiles: state.editedFiles,
      });
      hpdGateContext = hpdResult.report || "";
      if (hpdResult.blocking) {
        gateFailures.push(
          `❌ HPD GATE (score: ${hpdResult.score}):\n` + hpdGateContext,
        );
        hpdGateContext = ""; // Already in failures
      } else if (hpdGateContext) {
        hpdGateContext = `\n🧪 HPD GATE (${hpdResult.classification}):\n${hpdGateContext}\n`;
      }
    } catch (err) {
      hpdGateContext = `\n⚠️ HPD Gate error: ${err.message}\n`;
    }
  }

  // ══════ Aggregate Results ══════
  if (gateFailures.length > 0) {
    const plural =
      gateFailures.length > 1
        ? `${gateFailures.length} gates fallaron`
        : `1 gate falló`;
    return {
      decision: "deny",
      context:
        urgentHeader +
        `⛔ QUALITY GATE BLOCKED — ${plural}:\n\n` +
        gateFailures
          .map((f, i) => `[${i + 1}/${gateFailures.length}] ${f}`)
          .join("\n\n") +
        `\n\nResuelve TODOS los problemas antes de enviar la síntesis.`,
    };
  }

  // Optional: subagent/LLM classification bypass (no hash, just freshness)
  const classification = readClassification(cwd, sessionId);
  if (classification && classification.verdict === "no-audit") {
    // Reset editedFiles on allow — prevents cross-task accumulation
    state.editedFiles = [];
    writeAuditState(cwd, sessionId, state);
    return {
      decision: "allow",
      context:
        urgentHeader +
        `💬 Audit gate: clasificación pre-existente → bypass aprobado. Razón: ${classification.reason}` +
        fastGateContext +
        hpdGateContext,
    };
  }

  const fileList = state.editedFiles
    .map((f) => `  📄 ${f.split(/[/\\]/).pop()}`)
    .join("\n");

  state.synthesisAttempts += 1;

  // Round 0: First synthesis attempt — DENY and require audit
  if (state.auditRound === 0) {
    state.auditRound = 1;
    writeAuditState(cwd, sessionId, state);

    return {
      decision: "deny",
      context:
        urgentHeader +
        `⛔ QUALITY GATE BLOCKED — AUDIT GATE (Ronda 1/${MAX_AUTO_ROUNDS}): Modificaste ${state.editedFiles.length} archivo(s) esta sesión.\n` +
        `${fileList}\n\n` +
        `ANTES de enviar tu síntesis, DEBES:\n` +
        `1. Explicar por qué cada cambio es necesario (rubber duck debugging)\n` +
        `2. Re-leer cada archivo modificado (o los más críticos)\n` +
        `3. Verificar que los cambios compilan y son coherentes\n` +
        `4. Si encuentras problemas, CORREGIR primero\n` +
        `5. LUEGO llamar loopAwaitInput con tu síntesis\n\n` +
        `TIP: Puedes llamar auditClassify(sessionId, synthesis) para clasificar y bypass futuras rondas.` +
        fastGateContext +
        hpdGateContext,
    };
  }

  // Rounds 1-3: Allow but inject verification reminder
  // Reset editedFiles on allow — each task starts with a clean slate
  if (state.auditRound < MAX_AUTO_ROUNDS) {
    const auditedCount = state.editedFiles.length;
    state.auditRound += 1;
    state.editedFiles = [];
    writeAuditState(cwd, sessionId, state);

    return {
      decision: "allow",
      context:
        urgentHeader +
        `✅ AUDIT GATE (Ronda ${state.auditRound}/${MAX_AUTO_ROUNDS}): ` +
        `Si encontraste y corregiste problemas en la ronda anterior, VERIFICA de nuevo que los fixes son correctos. ` +
        `Si NO encontraste problemas, procede con la síntesis.\n` +
        `Archivos auditados: ${auditedCount}` +
        fastGateContext +
        hpdGateContext,
    };
  }

  // Round 4+: Ask user permission for another round
  // Reset editedFiles on allow — prevents cross-task accumulation
  if (state.auditRound >= MAX_AUTO_ROUNDS) {
    state.auditRound += 1;
    state.editedFiles = [];
    writeAuditState(cwd, sessionId, state);

    return {
      decision: "allow",
      context:
        urgentHeader +
        `⚠️ AUDIT GATE (Ronda ${state.auditRound}/${MAX_AUTO_ROUNDS}+): ` +
        `Has alcanzado el máximo de rondas de auditoría automática. ` +
        `INCLUYE en tu síntesis: "¿Deseas otra ronda de auditoría?" ` +
        `para que el usuario decida si continuar verificando.` +
        fastGateContext +
        hpdGateContext,
    };
  }

  // Fallthrough: reset editedFiles on allow
  state.editedFiles = [];
  writeAuditState(cwd, sessionId, state);
  return {
    decision: "allow",
    context: urgentHeader + fastGateContext + hpdGateContext,
  };
}

/**
 * Reset audit state for a session (call when loop ends or new feedback arrives).
 * @param {string} cwd
 * @param {string} sessionId
 */
export function resetAuditState(cwd, sessionId) {
  writeAuditState(cwd, sessionId, {
    editedFiles: [],
    auditRound: 0,
    lastAuditTs: null,
    synthesisAttempts: 0,
    urgentMessages: [],
  });
  // Reset fast gate convergence state on loop end
  try {
    resetFastGateConvergence(cwd);
  } catch {}
}

/**
 * Self-heal a frozen protocol-repair counter.
 *
 * Background: loop-protocol-monitor.json holds a `repair` block whose `attempts`
 * counter never auto-reset. Once it hit maxAttempts with `blocking: true`, the
 * loop kept re-serving a STALE checkpoint forever (see 05_TROUBLESHOOTING:
 * "GATE_BLOCKED congelado"). Call this whenever the audit gate ALLOWS — a passing
 * gate means the code is healthy, so any exhausted repair state is obsolete and
 * must be cleared so the next synthesis is never blocked by a ghost from a prior
 * failed round. The extension re-registers a fresh repair on the next real
 * violation, so resetting here is safe.
 *
 * @param {string} cwd
 * @param {string} sessionId
 */
export function clearFrozenRepairState(cwd, sessionId) {
  if (!sessionId) return;
  try {
    const monitorPath = join(getLoopDir(cwd, sessionId), "loop-protocol-monitor.json");
    if (!existsSync(monitorPath)) return;
    const monitor = JSON.parse(readFileSync(monitorPath, "utf8"));
    if (!monitor || typeof monitor !== "object" || !monitor.repair) return;
    const repair = monitor.repair;
    if (!repair.blocking && (repair.attempts ?? 0) === 0) return; // already healthy
    repair.attempts = 0;
    repair.blocking = false;
    monitor.status = "healthy";
    monitor.consecutiveViolations = 0;
    writeFileSync(monitorPath, JSON.stringify(monitor, null, 2), "utf8");
  } catch {
    // best-effort self-heal — never throw from the hook path
  }
}
