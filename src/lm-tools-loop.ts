/**
 * Loop LM Tools — extracted from lm-tools.ts
 *
 * MULTI-SESSION: All state keyed by sessionId (Maps, no singletons).
 * Contains: LoopTool, LoopAwaitInputTool, LoopEndTool
 */

import * as vscode from "vscode";
import { detectCrossSessionConflicts } from "./branch-stale-checker";
import { getAllConflicts } from "./file-lock-registry";
import { getForkRoundContext } from "./fork-helpers";
import { getIsolationInfo } from "./fork-queries";
import { handleLoopResume, handleLoopStart } from "./lm-tools-loop-actions";
import {
  formatPrioritizedMessages,
  readMessagesWithPriority,
  waitAtPauseGate,
} from "./loop-control";
import {
  getAllLoopStates,
  getLoopState,
  hasActiveLoop,
  isSpawningLoop,
  loopIterationComplete,
  loopIterationStart,
  loopReconnect,
  loopStart,
  setLoopProtocolMonitor,
  loopWaitForFeedback,
  setLoopSessionOpen,
} from "./loop-engine";
import { consumeGateBlock } from "./loop-gate-file";
import { formatResumeContext, resumeHibernatedLoop } from "./loop-hibernate";
import {
  buildImagePriorityContext,
  cleanupFeedbackImages,
  extractImageParts,
} from "./loop-image-parts";
import { resolveSessionMessages } from "./loop-mailbox";
import { executeMigration, needsMigration } from "./loop-migration";
import { detectPathLeakage, formatLeakWarning } from "./path-rewriter";
import { pushSynthesisToConnectedBridges, sendBridgePmChat } from "./auto-loop-bridge-manager";
import {
  attemptLoopProtocolRepair,
  formatLoopProtocolRepairMessage,
} from "./loop-protocol-repair";
import {
  recordLoopProtocolViolation,
  type LoopProtocolMonitorSnapshot,
  type LoopProtocolViolationInput,
} from "./loop-protocol-monitor";

// ——— Types ————————————————————————————————————————————————————————

interface LoopInput {
  sessionId?: string;
  prompt?: string;
  goal?: string;
  action?: "start" | "resume";
}

interface LoopAwaitInputParams {
  sessionId?: string;
  synthesis?: string;
}

// ——— Per-session state (replaces module singletons) ——————————————

export const activeLoopGoals = new Map<string, string>();
export const loopRoundCounters = new Map<string, number>();

function markProtocolViolation(
  sessionId: string,
  violation: LoopProtocolViolationInput,
): LoopProtocolMonitorSnapshot | null {
  const snapshot = recordLoopProtocolViolation(sessionId, violation);
  if (snapshot) {
    setLoopProtocolMonitor(sessionId, snapshot);
  }
  return snapshot;
}

function getAlternativeActiveSessions(sessionId: string): string[] {
  return Array.from(getAllLoopStates().values())
    .filter(
      (state) =>
        state.sessionId &&
        state.sessionId !== sessionId &&
        state.state !== "completed" &&
        state.state !== "idle",
    )
    .map((state) => state.sessionId as string)
    .slice(0, 3);
}

// ——— LoopTool ————————————————————————————————————————————————————

/**
 * LoopTool — Starts or continues an interactive feedback loop.
 *
 * MULTI-SESSION: sessionId is required to track which loop session.
 */
export class LoopTool implements vscode.LanguageModelTool<LoopInput> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LoopInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sessionId = options.input.sessionId;
    if (!sessionId) {
      this.log("[Loop] no sessionId — caller is not in a loop session");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "NO_ACTIVE_LOOP — No estás dentro de un loop. " +
            "Responde directamente al usuario con texto normal. " +
            "NO vuelvas a llamar loop, loopAwaitInput ni loopEnd.",
        ),
      ]);
    }

    // ——— Action dispatch: --start / --resume ———
    const action = options.input.action;
    if (action === "start") {
      return handleLoopStart(
        sessionId,
        options.input.goal || options.input.prompt || "",
        activeLoopGoals,
        loopRoundCounters,
      );
    }
    if (action === "resume") {
      return handleLoopResume(sessionId, activeLoopGoals, loopRoundCounters);
    }

    const prompt = options.input.prompt;
    const goal = options.input.goal;
    const isNewSession = !hasActiveLoop(sessionId);

    // STRAT-9: Check if this is a resume from hibernation
    let resumeContext = "";
    if (isNewSession) {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        const snapshot = await resumeHibernatedLoop(wsRoot, sessionId);
        if (snapshot) {
          resumeContext = formatResumeContext(snapshot);
          this.log(
            `[Loop] Resuming hibernated session: ${sessionId.substring(0, 8)}`,
          );
        }
      }
    }

    if (isNewSession) {
      const loopGoal = goal || prompt || "Interactive loop session";
      activeLoopGoals.set(sessionId, loopGoal);
      loopRoundCounters.set(sessionId, 0);

      // If HQ pre-spawned this session, promote from "spawning" → "active"
      // instead of calling loopStart() which would duplicate state
      if (isSpawningLoop(sessionId)) {
        await loopStart(sessionId, loopGoal); // transitions spawning → active
        this.log(
          `[Loop] Session promoted from spawning: sessionId=${sessionId}`,
        );
      } else {
        await loopStart(sessionId, loopGoal);
      }
      setLoopSessionOpen(sessionId, true);
      this.log(
        `[Loop] Session started: sessionId=${sessionId}, goal="${loopGoal.substring(0, 60)}"`,
      );

      // Open Brain HQ (createOrShow is idempotent — safe if already open)
      vscode.commands.executeCommand("projectBrain.openBrainHQ").then(
        () => this.log("[Loop] Brain HQ opened"),
        (err) => this.log(`[Loop] Failed to open HQ: ${err}`),
      );
    }

    const activeGoal = activeLoopGoals.get(sessionId) || "Continue";
    const currentPrompt = prompt || activeGoal;
    const counter = (loopRoundCounters.get(sessionId) || 0) + 1;
    loopRoundCounters.set(sessionId, counter);
    const iterNum = loopIterationStart(sessionId, currentPrompt);

    const parts: string[] = [];
    if (resumeContext) {
      parts.push(resumeContext, "");
    }
    if (isNewSession && !resumeContext) {
      parts.push(
        `🔄 **Loop Mode iniciado** — Direct text responses now BLOCKED`,
        `**Objetivo:** ${activeGoal}`,
        `**sessionId:** ${sessionId}`,
        "",
      );
    }
    parts.push(
      `### 🔁 Iteración ${iterNum}`,
      "",
      `**Prompt:** ${currentPrompt}`,
      "",
      "---",
      `⚠️ BLOCKED — Direct text responses BLOCKED while in ACTIVE LOOP.`,
      `Procesa este prompt. Cuando tengas resultados, usa loopAwaitInput(sessionId="${sessionId}", synthesis).`,
      "El usuario verá tu síntesis en Brain HQ y podrá enviarte feedback.",
    );

    this.log(
      `[Loop] Iteration ${iterNum} sessionId=${sessionId}: "${currentPrompt.substring(0, 60)}"`,
    );
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(parts.join("\n")),
    ]);
  }
}

// ——— LoopAwaitInputTool (feedback loop blocker) ——————————————————

/**
 * LoopAwaitInputTool — Posts synthesis to HQ and blocks until user sends feedback.
 * MULTI-SESSION: requires sessionId.
 */
export class LoopAwaitInputTool implements vscode.LanguageModelTool<LoopAwaitInputParams> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LoopAwaitInputParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // ——— Gate block check: hook signaled a gate via file ———
    const gateBlock = consumeGateBlock();
    if (gateBlock) {
      if (gateBlock.sessionId) {
        markProtocolViolation(gateBlock.sessionId, {
          code: "GATE_BLOCKED",
          severity: "warn",
          message:
            "loopAwaitInput quedó bloqueado por una gate antes de entregar la síntesis.",
          details: {
            reason: gateBlock.reason?.slice(0, 160) ?? null,
          },
        });
        const repair = attemptLoopProtocolRepair(
          gateBlock.sessionId,
          gateBlock.reason?.slice(0, 240) ?? "Gate bloqueó la entrega de la síntesis.",
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            formatLoopProtocolRepairMessage(repair, {
              title: "GATE_BLOCKED",
              summary: "La gate impidió publicar la síntesis del loop.",
              retryInstruction:
                "Resuelve la gate indicada y reintenta exactamente una vez con loopAwaitInput. No respondas al usuario por texto directo.",
              blockedInstruction:
                "Acción de operador recomendada en Brain HQ: reabre el chat del loop, envía un mensaje urgente o márcalo como desconectado para recuperarlo sin perder contexto.",
            }),
          ),
        ]);
      }
      this.log(
        `[LoopAwaitInput] GATE_BLOCKED for session=${gateBlock.sessionId}: ${gateBlock.reason?.substring(0, 200)}`,
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ GATE_BLOCKED — Tu síntesis NO fue enviada al usuario.\n\n` +
            `${gateBlock.reason}\n\n` +
            `Resuelve el bloqueo indicado arriba y luego vuelve a llamar loopAwaitInput con tu síntesis.`,
        ),
      ]);
    }

    const sessionId = options.input?.sessionId;
    if (!sessionId) {
      this.log(
        "[LoopAwaitInput] no sessionId — caller is not in a loop session",
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "NO_ACTIVE_LOOP — No estás dentro de un loop. " +
            "Responde directamente al usuario con texto normal. " +
            "NO vuelvas a llamar loop, loopAwaitInput ni loopEnd.",
        ),
      ]);
    }

    if (!hasActiveLoop(sessionId)) {
      const reconnectable = loopReconnect(sessionId);
      if (reconnectable.ok) {
        // Auto-reconectado desde persistencia — continuar normalmente con contexto completo
        this.log(
          `[LoopAwaitInput] sessionId=${sessionId} auto-reconnected from persistence ` +
            `(${reconnectable.summary ? "with summary" : "minimal"})`,
        );
      } else {
        const alternatives = getAlternativeActiveSessions(sessionId);
        markProtocolViolation(sessionId, {
          code: alternatives.length > 0 ? "WRONG_SESSION_ID" : "SESSION_LOST",
          severity: alternatives.length > 0 ? "warn" : "error",
          message:
            alternatives.length > 0
              ? "loopAwaitInput llegó con un sessionId que no coincide con los loops activos actuales."
              : "loopAwaitInput no pudo reconectar la sesión desde persistencia.",
          details: {
            requestedSessionId: sessionId,
            activeCandidates: alternatives.join(", ") || null,
          },
        });
        const repair = attemptLoopProtocolRepair(
          sessionId,
          alternatives.length > 0
            ? `SessionId inválido para loop activo. Candidatos: ${alternatives.join(", ")}`
            : "La sesión no pudo reconectarse desde persistencia.",
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            formatLoopProtocolRepairMessage(repair, {
              title: alternatives.length > 0 ? "WRONG_SESSION_ID" : "SESSION_LOST",
              summary:
                alternatives.length > 0
                  ? `El sessionId ${sessionId} no coincide con los loops vivos. Activos: ${alternatives.join(", ")}.`
                  : `No se pudo recuperar la sesión ${sessionId} desde persistencia.`,
              retryInstruction:
                alternatives.length > 0
                  ? "Reintenta una sola vez con el sessionId correcto. No respondas al usuario mientras el loop siga bloqueado."
                  : "No respondas al usuario. Espera reparación desde Brain HQ o reconexión manual del loop.",
              blockedInstruction:
                "Acción de operador recomendada en Brain HQ: reabre el chat del loop, corrige el sessionId o marca la sesión como desconectada para recuperarla sin cerrarla.",
            }),
          ),
        ]);
      }
    }

    const roundNum = loopRoundCounters.get(sessionId) || 0;
    // Diagnostic: log full input shape to trace synthesis parameter passthrough
    const inputKeys = options.input
      ? Object.keys(options.input).join(", ")
      : "(no input)";
    const synthLen = options.input?.synthesis
      ? options.input.synthesis.length
      : 0;
    this.log(
      `[LoopAwaitInput] sessionId=${sessionId} inputKeys=[${inputKeys}] synthLen=${synthLen}`,
    );
    if (synthLen === 0) {
      // Log full input JSON (truncated) to diagnose missing synthesis
      const snapshot = JSON.stringify(options.input ?? null).slice(0, 300);
      this.log(
        `[LoopAwaitInput] WARN: no synthesis in input. snapshot=${snapshot}`,
      );
      markProtocolViolation(sessionId, {
        code: "EMPTY_SYNTHESIS",
        severity: "warn",
        message:
          "loopAwaitInput fue llamado sin síntesis explícita; se aplicó extracción de fallback.",
        details: { roundNum },
      });
      const repair = attemptLoopProtocolRepair(
        sessionId,
        `loopAwaitInput llegó sin síntesis explícita en la ronda ${roundNum}.`,
      );
      if (repair.blocking) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            formatLoopProtocolRepairMessage(repair, {
              title: "EMPTY_SYNTHESIS",
              summary:
                "El agente siguió invocando loopAwaitInput sin una síntesis válida.",
              retryInstruction:
                "",
              blockedInstruction:
                "Acción de operador recomendada en Brain HQ: reabre el chat del loop o márcalo como desconectado para recuperar la sesión sin cerrarla.",
            }),
          ),
        ]);
      }
    }
    // Resilient extraction: LLMs sometimes use alternative param names
    const inp = options.input as Record<string, unknown> | undefined;
    const rawSynthesis =
      options.input?.synthesis ||
      (typeof inp?.message === "string" ? inp.message : undefined) ||
      (typeof inp?.description === "string" ? inp.description : undefined) ||
      (typeof inp?.content === "string" ? inp.content : undefined) ||
      (typeof inp?.text === "string" ? inp.text : undefined) ||
      `⏳ Ronda ${roundNum} completada — el agente no proporcionó síntesis detallada.`;
    // Normalize escaped newlines — LLMs sometimes send literal \n instead of real newlines
    const synthesis = rawSynthesis.replace(/\\n/g, "\n");
    // Ensure iteration is tracked even when agent skips loop() and calls
    // loopAwaitInput directly (rounds 2+). Without this, currentIteration
    // is null after round 1 and loopIterationComplete silently skips.
    const loopState = getLoopState(sessionId);
    if (!loopState.currentIteration) {
      loopIterationStart(sessionId, `round-${roundNum}`);
    }
    loopIterationComplete(sessionId, synthesis);
    this.log(
      `[LoopAwaitInput] sessionId=${sessionId} posting synthesis, waiting for feedback...`,
    );

    // Push synthesis to connected Auto Loop Bridge sessions
    const bridgeHit = pushSynthesisToConnectedBridges(sessionId, synthesis, roundNum);
    if (bridgeHit) {
      this.log(`[LoopAwaitInput] Bridge intercept → ${bridgeHit.bridgeId}`);
      // Auto-generate PM opinion on synthesis arrival (fire-and-forget)
      sendBridgePmChat(
        bridgeHit.bridgeId,
        bridgeHit.synthesisId,
        "Nueva síntesis recibida. Analiza el progreso del worker y genera tu opinión.",
      ).then(
        (res) => this.log(`[LoopAwaitInput] Auto-opinion generated: ${res ? "ok" : "skipped"}`),
        (err) => this.log(`[LoopAwaitInput] Auto-opinion failed: ${err}`),
      );
    }

    // Auto-open Brain HQ — bridge tab if connected bridge exists, loop tab otherwise
    const hqTab = bridgeHit ? "bridge" : "loop";
    vscode.commands.executeCommand("projectBrain.openBrainHQ", hqTab).then(
      () => this.log(`[LoopAwaitInput] Brain HQ opened on ${hqTab} tab`),
      (err) => this.log(`[LoopAwaitInput] Failed to open HQ: ${err}`),
    );

    // Auto-resolve user messages — agent has processed, presenting synthesis
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      const resolved = resolveSessionMessages(wsRoot, sessionId);
      if (resolved > 0) {
        this.log(
          `[LoopAwaitInput] Auto-resolved ${resolved} mailbox message(s)`,
        );
      }
    }

    const feedback = await loopWaitForFeedback(sessionId, synthesis);

    // STRAT-8: Wait at pause gate before processing (blocks if paused)
    await waitAtPauseGate(sessionId);

    if (
      feedback === "__LOOP_ENDED__" ||
      feedback === "__HIBERNATED__" ||
      feedback === "__DISCONNECTED__"
    ) {
      this.log(`[LoopAwaitInput] sessionId=${sessionId} signal: ${feedback}`);
      activeLoopGoals.delete(sessionId);
      loopRoundCounters.delete(sessionId);
      // Cleanup orphaned images on disconnection
      if (feedback === "__DISCONNECTED__") {
        cleanupFeedbackImages(sessionId);
      }
      const reasons: Record<string, string> = {
        __LOOP_ENDED__: "El usuario cerró el loop.",
        __HIBERNATED__:
          "💤 Loop hibernado. El branch y worktree se mantienen intactos. El usuario puede resumir otro día.",
        __DISCONNECTED__:
          "La sesión quedó desconectada por inactividad. El usuario puede reconectarla desde Brain HQ.",
      };
      const needsCleanup = feedback === "__LOOP_ENDED__";
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          needsCleanup
            ? `🛑 **Loop finalizado** — ${reasons[feedback]}\n\nLlama a \`loopEnd\` para limpiar.`
            : `🔌 **Loop desconectado** — ${reasons[feedback]}\n\nNo llames \`loopEnd\`. Espera a que el usuario lo reconecte o abra una nueva sesión.`,
        ),
      ]);
    }

    this.log(
      `[LoopAwaitInput] sessionId=${sessionId} feedback: ${feedback.substring(0, 100)}...`,
    );

    // AUTO-MIGRATION: Check if maxCycles threshold reached
    if (needsMigration(sessionId)) {
      this.log(`[LoopAwaitInput] maxCycles reached — auto-migrating`);
      const migrated = await executeMigration(sessionId, feedback);
      if (migrated) {
        activeLoopGoals.delete(sessionId);
        loopRoundCounters.delete(sessionId);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "🔄 **Loop migrado automáticamente** — " +
              "Se abrió una nueva sesión de chat con todo el contexto. " +
              "Esta sesión ya no tiene un loop activo. " +
              "Llama a `loopEnd` para limpiar.",
          ),
        ]);
      }
    }

    // INC-12 + INC-13: Inject worktree diff context + branch drift
    let roundContext = "";
    try {
      const isolation = getIsolationInfo(sessionId);
      if (isolation) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
          roundContext = await getForkRoundContext(isolation);

          // INC-16: Cross-session file conflict detection
          const conflicts = await detectCrossSessionConflicts(wsRoot);
          const mine = conflicts.filter((c) => c.sessions.includes(sessionId));
          if (mine.length > 0) {
            const files = mine.map((c) => c.file).join(", ");
            roundContext += `\n⚠️ **CONFLICTO CROSS-SESSION:** Los siguientes archivos están siendo editados por OTRA sesión: ${files}. Coordina antes de mergear.\n`;
          }

          // STRAT-3: Detect path leakage in synthesis
          if (isolation.forkPath && options.input?.synthesis) {
            const leaks = detectPathLeakage(
              options.input.synthesis,
              wsRoot,
              isolation.forkPath,
            );
            roundContext += formatLeakWarning(leaks);
          }

          // STRAT-7/8: Mailbox — inject prioritized messages (user urgent + regular)
          try {
            const { urgent, regular } = readMessagesWithPriority(
              wsRoot,
              sessionId,
            );
            if (urgent.length > 0 || regular.length > 0) {
              roundContext += formatPrioritizedMessages(urgent, regular);
            }
          } catch {
            /* non-fatal */
          }

          // STRAT-4: File lock conflict summary
          const lockConflicts = getAllConflicts(wsRoot);
          const myLockConflicts = lockConflicts.filter((c) =>
            c.holders.includes(sessionId),
          );
          if (myLockConflicts.length > 0) {
            const lockFiles = myLockConflicts.map((c) => c.file).join(", ");
            roundContext += `\n🔒 **FILE LOCKS ACTIVOS:** ${lockFiles} — otros agentes también los editan. Usa \`fileLock check\` antes de editar.\n`;
          }
        }
      }
    } catch {
      /* non-fatal — feedback delivery is more important */
    }

    // Extract image DataParts for Vision API pass-through
    const imagePriorityContext = buildImagePriorityContext(feedback);
    const imageParts = extractImageParts(feedback);
    const resultParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelDataPart
    > = [];

    if (imagePriorityContext) {
      resultParts.push(new vscode.LanguageModelTextPart(imagePriorityContext));
      resultParts.push(...imageParts);
    }

    resultParts.push(
      new vscode.LanguageModelTextPart(
        [
          `⚠️ BLOCKED — Direct text responses BLOCKED. ACTIVE LOOP [sessionId=${sessionId}].`,
          "",
          "🚨 **MANDATORY FIRST ACTION**: Call `projectBrain_toolbox` with `searchMemory` or ANY other tool BEFORE writing text.",
          "Writing text to the user BEFORE calling a tool is a PROTOCOL VIOLATION.",
          "Sequence: tool call → work → loopAwaitInput. NEVER: text → tool call.",
          "",
          roundContext,
          "📨 **Feedback del usuario recibido:**",
          "",
          feedback,
          "",
          "---",
          `**INSTRUCCIÓN**: Incorpora feedback → trabaja → loopAwaitInput(sessionId="${sessionId}", synthesis).`,
          `Output BLOCKED unless via loopAwaitInput. This is non-negotiable.`,
        ].join("\n"),
      ),
    );

    return new vscode.LanguageModelToolResult(resultParts);
  }
}
// Re-export LoopEndTool (extracted to lm-tools-loop-end.ts)
export { LoopEndTool } from "./lm-tools-loop-end";

// Re-export LoopReconnectTool from actions file
export { LoopReconnectTool } from "./lm-tools-loop-actions";
