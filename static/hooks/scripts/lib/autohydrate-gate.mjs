/**
 * autohydrate-gate.mjs — AUTO-DOCUMENTATION gate for loop sessions.
 *
 * Triggers (any of these -> BLOCKDENY synthesis):
 *   1. Bug fix mentioned in chat history
 *   2. Root cause analysis discovered
 *   3. New pattern/learning identified
 *   4. Error+solution documented
 *   5. Architectural decision explained
 *
 * Uses autohydrate-state.json in .project-brain/loops/{sessionId}/.
 *
 * Pattern: Same as commit-gate.mjs but evaluates KNOWLEDGE relevance
 * instead of file changes.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getLoopDir } from "./brain-paths.mjs";

/** Strip UTF-8 BOM — PowerShell writes BOM by default, crashes JSON.parse. */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ===============================================================
// Constants
// ===============================================================

/** Max age (ms) for a classification to be considered fresh — 10 minutes. */
const CLASSIFICATION_TTL_MS = 10 * 60 * 1000;

/** Minimum relevance score (0-100) to trigger documentation requirement. */
const RELEVANCE_THRESHOLD = 60;

// ===============================================================
// State I/O
// ===============================================================

/**
 * Get the autohydrate state file path for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function getAutohydrateStatePath(cwd, sessionId) {
  const dir = getLoopDir(cwd, sessionId || "_default");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return join(dir, "autohydrate-state.json");
}

/**
 * Read the current autohydrate state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ lastDocTs: number|null, triggerCount: number, autohydrateBypass: boolean }}
 */
export function readAutohydrateState(cwd, sessionId) {
  const defaults = {
    lastDocTs: null,
    triggerCount: 0,
    autohydrateBypass: false,
  };

  try {
    const fp = getAutohydrateStatePath(cwd, sessionId);
    if (!existsSync(fp)) return defaults;
    const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    return { ...defaults, ...data };
  } catch {
    return defaults;
  }
}

/**
 * Write the autohydrate state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {object} state
 */
export function writeAutohydrateState(cwd, sessionId, state) {
  try {
    const fp = getAutohydrateStatePath(cwd, sessionId);
    writeFileSync(fp, JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

/**
 * Record that documentation was saved (resets tracking).
 * @param {string} cwd
 * @param {string} sessionId
 */
export function recordDocumentationDone(cwd, sessionId) {
  const state = readAutohydrateState(cwd, sessionId);
  state.lastDocTs = Date.now();
  state.triggerCount += 1;
  writeAutohydrateState(cwd, sessionId, state);
}

/**
 * Set the autohydrate bypass toggle for a session.
 * When true, autohydrate-gate will allow all synthesis without requiring docs.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {boolean} enabled
 */
export function setAutohydrateBypass(cwd, sessionId, enabled) {
  const state = readAutohydrateState(cwd, sessionId);
  state.autohydrateBypass = !!enabled;
  writeAutohydrateState(cwd, sessionId, state);
}

/**
 * Read the autohydrate bypass state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {boolean}
 */
export function getAutohydrateBypass(cwd, sessionId) {
  const state = readAutohydrateState(cwd, sessionId);
  return !!state.autohydrateBypass;
}

/**
 * Read the LLM/subagent classification file for a session.
 * Returns classification or null if missing/stale.
 * NOTE: No hash matching — classification is intent-based, not text-matched.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ verdict: string, reason: string, ts: number }|null}
 */
function readAutohydrateClassification(cwd, sessionId) {
  try {
    const dir = getLoopDir(cwd, sessionId || "_default");
    const fp = join(dir, "autohydrate-classification.json");
    if (!existsSync(fp)) return null;
    const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    if (Date.now() - data.ts > CLASSIFICATION_TTL_MS) return null;
    // Consume-on-read: delete to prevent stale bypass on next round
    try { unlinkSync(fp); } catch { /* ignore */ }
    return data;
  } catch {
    return null;
  }
}

// ===============================================================
// Relevance Detection (Pattern-based heuristics)
// ===============================================================

/**
 * Analyze chat history to detect documentation-worthy content.
 * Returns relevance score 0-100.
 * @param {string} chatHistory — combined user+agent messages from current round
 * @returns {{ score: number, triggers: string[] }}
 */
export function analyzeRelevance(chatHistory) {
  if (!chatHistory || chatHistory.length < 50) {
    return { score: 0, triggers: [] };
  }

  const lower = chatHistory.toLowerCase();
  const triggers = [];
  let score = 0;

  // ── Trigger 1: Bug fix patterns ────────────────────────────────────────
  const bugPatterns = [
    /\b(bug|error|fallo|problema|issue|failure|defect)\b.*\b(fix|fixed|arregl|solucion|resuelto|corregir|reparar|parchear)\b/i,
    /\b(corregir|reparar|parchear|solucionar)\b.*\b(bug|error|fallo|problema|issue)\b/i,
    /\b(solucionado|corregido|arreglado|fixed)\b.*\b(el|un|la)\s+(bug|error|fallo|problema|issue)\b/i,
    /root cause/i,
    /causa raíz/i,
    /raíz del problema/i,
    /\b(descubr|encontr|identific)\w*\s+(el|un|una)\s+(bug|error|problema|fallo|issue)\b/i,
  ];
  for (const pattern of bugPatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("bug-fix");
      score += 25;
      break;
    }
  }

  // ── Trigger 2: Root cause analysis ─────────────────────────────────────
  const rootCausePatterns = [
    /\b(root cause|causa raíz|raíz del problema|origen del problema)\b/i,
    /\b(el problema era|el error ocurría porque|la raíz del issue)\b/i,
    /\b(discovered that|descubrimos que|resulta que|ahora entiendo que)\b/i,
    /\b(culpable|responsible|causado por|caused by)\b/i,
    /\b(la raíz|the root|el origen|the source)\b.*\b(era|was|es|is)\b/i,
  ];
  for (const pattern of rootCausePatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("root-cause");
      score += 30;
      break;
    }
  }

  // ── Trigger 3: Learning/Pattern discovered ────────────────────────────
  const learningPatterns = [
    /\b(pattern|patron|patrón|architectural insight|lesson learned|aprendizaje|lección)\b/i,
    /\b(discovered|descubrimos|identificamos|ahora sabemos|now we know)\b.*\b(que|how|cómo)\b/i,
    /\b(nuevo enfoque|nueva estrategia|better approach|mejor forma|alternativa mejor)\b/i,
    /\b(insight|hallazgo|discovery|finding)\b/i,
    /\b(aprendimos|learned|ahora sé|now I know)\b.*\b(que|how|cómo)\b/i,
  ];
  for (const pattern of learningPatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("learning");
      score += 20;
      break;
    }
  }

  // ── Trigger 4: Solution with context ───────────────────────────────────
  const solutionPatterns = [
    /\b(solution|fix|workaround|solución|alternativa|remedio)\b.*\b(works|funciona|solved|resuelto)\b/i,
    /\b(aplicado|implemented|merged|committed|deployado|deployed)\b/i,
    /\b(ahora|now)\b.*\b(funciona|works|compila|passes|pasa)\b/i,
    /\b(solucionado con|resolved with|fixed by|corregido con)\b/i,
    /\b(finalmente funciona|finally works|al fin sirve)\b/i,
  ];
  for (const pattern of solutionPatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("solution");
      score += 15;
      break;
    }
  }

  // ── Trigger 5: Architectural decision ──────────────────────────────────
  const archPatterns = [
    /\b(decided to|decidimos|optamos por|chosen approach|elegimos)\b/i,
    /\b(design pattern|patrón de diseño|architecture|arquitectura)\b/i,
    /\b(refactor|migration|migración|reestructuración)\b/i,
    /\b(architectural|arquitectónico|estructural)\b/i,
    /\b(decision|decisión)\b.*\b(design|diseño|pattern|patrón|arquitectura)\b/i,
  ];
  for (const pattern of archPatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("architecture");
      score += 20;
      break;
    }
  }

  // ── Trigger 6: Troubleshooting steps ───────────────────────────────────
  const troubleshootingPatterns = [
    /\b(error|exception|crash|fallo|excepción)\b.*\b(stack trace|logs|output|traza)\b/i,
    /\b(tried|probamos|intentamos|intenté)\b.*\b(didn't work|no funcionó|falló|failed)\b/i,
    /\b(finally|finalmente|al final|después de)\b.*\b(worked|funcionó|success|exitoso)\b/i,
    /\b(threw|lanzó|arrojó)\b.*\b(error|exception|excepción)\b/i,
    /\b(debuggeando|debugging|investigando|investigating)\b/i,
  ];
  for (const pattern of troubleshootingPatterns) {
    if (pattern.test(chatHistory)) {
      triggers.push("troubleshooting");
      score += 15;
      break;
    }
  }

  // ── Anti-patterns: Deduct score for trivial content ────────────────────
  const trivialPatterns = [
    /^(ok|okay|yes|no|sí|hola|buenas|hey|gracias|thanks)\s*$/i,
    /\b(reading|leyendo|searching|buscando|looking for)\b/i,
    /\b(compilando|compiling|running test)\b/i,
  ];
  for (const pattern of trivialPatterns) {
    if (pattern.test(lower)) {
      score -= 10;
      break;
    }
  }

  return { score: Math.max(0, Math.min(100, score)), triggers };
}

// ===============================================================
// Evaluation (BLOCKING — called from PreToolUse at loopAwaitInput)
// ===============================================================

/**
 * Evaluate whether documentation is REQUIRED before synthesis.
 * Returns { decision, context } where decision is "deny" or "allow".
 *
 * BLOCKING: returns "deny" to force the agent to document first.
 * The agent MUST call projectBrain_toolbox({ tool: "writeMemory" }) before sending synthesis.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} chatHistory — combined user+agent messages from current round
 * @returns {{ decision: "deny"|"allow", context: string }}
 */
export function evaluateAutohydrateGate(cwd, sessionId, chatHistory) {
  const state = readAutohydrateState(cwd, sessionId);

  // ── Bypass toggle: if user approved bypass AND not expired, allow ──
  if (state.autohydrateBypass) {
    const expiresAt = state.bypassExpiresAt || 0;
    if (expiresAt && Date.now() > expiresAt) {
      // Bypass expired — auto-disable
      state.autohydrateBypass = false;
      delete state.bypassExpiresAt;
      delete state.bypassReason;
      writeAutohydrateState(cwd, sessionId, state);
    } else {
      return { decision: "allow", context: "" };
    }
  }

  // ── Recent documentation: if agent documented in last 60 seconds, allow ──
  const now = Date.now();
  if (state.lastDocTs && now - state.lastDocTs < 60000) {
    // 60 seconds grace period
    return { decision: "allow", context: "" };
  }

  // ── LLM Classification (optional bypass) ──
  // If agent called autohydrateClassify(sessionId, synthesis), check verdict
  const classification = readAutohydrateClassification(cwd, sessionId);
  if (classification) {
    if (classification.verdict === "mundane") {
      // LLM says no valuable learning → allow bypass
      return { decision: "allow", context: "" };
    }
    // If verdict is "valuable", continue to pattern analysis as confirmation
  }

  // ── Inline heuristic: auto-classify obviously mundane synthesis ──
  if (!classification && chatHistory) {
    const trimmed = chatHistory.trim();
    const isMundane =
      trimmed.length < 150 ||
      /^(listo|done|ok|entendido|got it|noted|cool|thanks|gracias|perfecto|confirmado|sí|si|claro)/i.test(trimmed) ||
      (trimmed.length < 300 && !/(bug|error|fix|soluc|causa|descubr|patr[oó]n|crash|fail|broken|because|root.?cause|workaround|learn)/i.test(trimmed));
    if (isMundane) {
      return { decision: "allow", context: "" };
    }
  }

  // ── Analyze relevance ──
  const { score, triggers } = analyzeRelevance(chatHistory || "");

  // Score too low -> allow (nothing relevant to document)
  if (score < RELEVANCE_THRESHOLD) {
    return { decision: "allow", context: "" };
  }

  // High relevance detected -> DENY until documented
  const triggerList = triggers.join(", ");
  return {
    decision: "deny",
    context: buildDenyMessage(score, triggerList),
  };
}

/**
 * Build the blocking deny message for autohydrate gate.
 * @param {number} score
 * @param {string} triggers
 * @returns {string}
 */
function buildDenyMessage(score, triggers) {
  return `
⛔ AUTOHYDRATE GATE — DOCUMENTA ANTES DE CONTINUAR

Relevancia: ${score}/100 | Triggers: ${triggers}

Este round contiene información valiosa. Documéntala con writeMemory:

\`\`\`
projectBrain_toolbox({ tool: "writeMemory",
  file: "04_LEARNINGS.md" o "05_TROUBLESHOOTING.md",
  title: "[Título descriptivo]",
  tags: "keyword1, keyword2",
  status: "resolved" | "pending",
  context: "[Qué se estaba haciendo]",
  problem: "[El problema encontrado]",
  rootCause: "[Por qué ocurrió]",
  solution: "[Cómo se resolvió]",
  lessonsLearned: "[Lecciones clave]"
})
\`\`\`

Bugs/errores → "05_TROUBLESHOOTING.md" | Patterns/learnings → "04_LEARNINGS.md"
Después de documentar, re-envía tu síntesis.
  `.trim();
}
