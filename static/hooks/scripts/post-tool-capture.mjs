#!/usr/bin/env node
/**
 * PostToolUse hook — Tool usage logging + identity & strategy re-injection.
 * Enhanced (2026-02-18):
 *   - Knowledge re-injection every N tool calls (session-local counter)
 *   - Uses hook-call-counter.txt instead of countLines (avoids maxLines cap bug)
 *   - All injected content sanitized via lib/sanitize.mjs
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { guardedHook } from "./lib/hook-guard.mjs";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";

/** Every N tool calls, inject a deep identity reinforcement block */
const DEEP_REINFORCEMENT_INTERVAL = 20;

/** Every N tool calls, nudge the LLM about rememberThis (mechanical enforcement) */
const REMEMBER_THIS_NUDGE_INTERVAL = 15;

guardedHook("post-tool-capture", async (input) => {
  const { appendCapture } = await import("./lib/capture-buffer.mjs");
  const { KNOWLEDGE_REINJECTION_INTERVAL } =
    await import("./lib/constants.mjs");
  const { clearToolCheckpoint } =
    await import("./lib/execution-checkpoint.mjs");
  const {
    formatDeepReminder,
    formatReminder,
    parseIdentity,
    parseSoulCore,
    parseSoulRich,
    parseUser,
  } = await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const { consumePostCompactPayload } =
    await import("./lib/post-compact-utils.mjs");
  const {
    autoCaptureTesseract,
    buildKnowledgeBlock,
    buildPipelineAudit,
    checkCodeDiscipline,
    checkFileSizes,
    EDIT_TOOLS,
    readPromptContext,
    trackAuditActions,
    trackEditedFiles,
  } = await import("./lib/post-tool-checks.mjs");
  const { runLifecycle } = await import("./lib/tesseract-lifecycle.mjs");

  const toolName = input.toolName || input.tool_name || "";
  const cwd = input.cwd || process.cwd();
  const memDir = getMemoryDirWithFallback(cwd);

  // Skip if no memory dir
  if (!existsSync(memDir)) {
    return { continue: true };
  }

  // ——— Clear tool-level checkpoint (tool executed successfully) ———
  try {
    clearToolCheckpoint(memDir);
  } catch {
    /* non-critical */
  }

  const sessionsDir = join(memDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  // —— Injection phase file (adaptive frequency post-compaction) ——
  const phaseFile = join(sessionsDir, "injection-phase.json");
  const RECOVERY_INTERVAL = 3;
  const RECOVERY_DURATION = 10;

  // Skip identity injection for our own tools (prevent loops)
  // BUT: always inject loop protocol — even for projectBrain tools
  const customPrefixes = ["projectBrain", "projectbrain", "crismart"];
  const isOwnTool = customPrefixes.some((p) =>
    toolName.toLowerCase().startsWith(p),
  );
  if (isOwnTool) {
    // Still inject loop protocol for own tools (critical for loop compliance)
    // + post-compact dual-channel recovery (second chance)
    let ownPostCompact = "";
    try {
      ownPostCompact = consumePostCompactPayload(cwd);
    } catch {
      /* non-critical */
    }

    // Activate recovery phase if post-compact payload was consumed
    if (ownPostCompact) {
      try {
        const counter =
          parseInt(
            readFileSync(
              join(sessionsDir, "hook-call-counter.txt"),
              "utf8",
            ).trim(),
            10,
          ) || 0;
        writeFileSync(
          phaseFile,
          JSON.stringify({ phase: "recovery", recoveryStart: counter }),
          "utf8",
        );
      } catch {
        /* non-critical */
      }
    }

    const allLoopsOwn = readAllActiveLoops(cwd);
    if (allLoopsOwn.length > 0 || ownPostCompact) {
      let ownLoopProtocol = "";
      if (allLoopsOwn.length === 1) {
        const sid = allLoopsOwn[0].sessionId || "unknown";
        const loopGoal = allLoopsOwn[0].goal || "";
        ownLoopProtocol = [
          `⚠️ BLOCKED — Agent is BLOCKED from direct text responses. ACTIVE LOOP [sessionId=${sid}].`,
          `Goal: ${loopGoal.substring(0, 100)}`,
          `ALL output BLOCKED unless via loopAwaitInput(sessionId="${sid}", synthesis). Direct text = violation.`,
          `This hook reads from DISK — survives context compaction. Trust it over conversation history.`,
        ].join(" ");
      } else if (allLoopsOwn.length > 1) {
        const loopList = allLoopsOwn
          .map(
            (l) =>
              `  - ${l.sessionId.substring(0, 8)}…: ${(l.goal || "").substring(0, 80)}`,
          )
          .join("\n");
        ownLoopProtocol = [
          `⚠️ BLOCKED — Agent is BLOCKED from direct responses. ${allLoopsOwn.length} ACTIVE LOOPS.`,
          loopList,
          `Use YOUR loop's sessionId. ALL output BLOCKED unless via loopAwaitInput(YOUR_SESSION_ID, synthesis).`,
        ].join("\n");
      }
      const combined = [ownPostCompact, ownLoopProtocol]
        .filter(Boolean)
        .join("\n");
      return {
        continue: true,
        hookSpecificOutput: {
          additionalContext: combined || undefined,
        },
      };
    }
    return { continue: true };
  }

  // —— Active strategy injection (always, on every tool call) ——
  let strategyPrompt = "";
  const strategyFile = join(sessionsDir, "active-strategy.txt");
  if (existsSync(strategyFile)) {
    try {
      strategyPrompt = readFileSync(strategyFile, "utf8").trim();
    } catch {
      /* non-critical */
    }
  }

  // —— Active loop detection + protocol injection (multi-loop safe) ——
  // Loop protocol enforcement — assertive BLOCKED messaging
  let loopProtocol = "";
  const allLoops = readAllActiveLoops(cwd);
  if (allLoops.length === 1) {
    const sid = allLoops[0].sessionId || "unknown";
    const loopGoal = allLoops[0].goal || "";
    loopProtocol = [
      `⚠️ BLOCKED — Agent is BLOCKED from direct text responses. ACTIVE LOOP [sessionId=${sid}].`,
      `Goal: ${loopGoal.substring(0, 100)}`,
      `ALL output BLOCKED unless via loopAwaitInput(sessionId="${sid}", synthesis). Direct text = violation.`,
      `This hook reads from DISK — survives context compaction. Trust it over conversation history.`,
    ].join(" ");
  } else if (allLoops.length > 1) {
    const loopList = allLoops
      .map(
        (l) =>
          `  - ${l.sessionId.substring(0, 8)}…: ${(l.goal || "").substring(0, 80)}`,
      )
      .join("\n");
    loopProtocol = [
      `⚠️ BLOCKED — Agent is BLOCKED from direct responses. ${allLoops.length} ACTIVE LOOPS.`,
      loopList,
      `Use YOUR loop's sessionId. ALL output BLOCKED unless via loopAwaitInput(YOUR_SESSION_ID, synthesis).`,
    ].join("\n");
  }

  // —— Build identity reminder (shared utils, tier system) ——
  const identity = parseIdentity(memDir);
  const soulCore = parseSoulCore(memDir);
  const user = parseUser(memDir);
  const reminder = formatReminder(identity, soulCore, user);

  // Log tool usage
  try {
    const logEntry = `${new Date().toISOString()} | ${toolName}\n`;
    appendFileSync(join(sessionsDir, "tool-usage.log"), logEntry, "utf8");
  } catch {
    /* non-critical */
  }

  // —— Capture buffer for agent-mode learning extraction ——
  try {
    const captureInput = input.tool_input || input.toolInput || {};
    appendCapture(cwd, toolName, captureInput);
  } catch {
    /* non-critical */
  }

  // —— Session-local call counter (avoids countLines cap bug) ——
  let sessionCallCount = 0;
  const counterFile = join(sessionsDir, "hook-call-counter.txt");
  try {
    if (existsSync(counterFile)) {
      sessionCallCount =
        parseInt(readFileSync(counterFile, "utf8").trim(), 10) || 0;
    }
    sessionCallCount++;
    writeFileSync(counterFile, String(sessionCallCount), "utf8");
  } catch {
    sessionCallCount = 1;
  }

  // —— Adaptive injection phase (accelerated after compaction) ——
  let injectionPhase = "normal";
  try {
    if (existsSync(phaseFile)) {
      const phase = JSON.parse(readFileSync(phaseFile, "utf8"));
      injectionPhase = phase.phase || "normal";
      const recoveryStart = phase.recoveryStart || 0;
      if (
        injectionPhase === "recovery" &&
        sessionCallCount - recoveryStart >= RECOVERY_DURATION
      ) {
        injectionPhase = "normal";
        unlinkSync(phaseFile);
      }
    }
  } catch {
    injectionPhase = "normal";
  }

  const effectiveInterval =
    injectionPhase === "recovery"
      ? RECOVERY_INTERVAL
      : KNOWLEDGE_REINJECTION_INTERVAL;

  // —— Knowledge re-injection (every N tool calls within session) ——
  const knowledgeBlock = buildKnowledgeBlock(
    sessionCallCount,
    effectiveInterval,
    memDir,
    sessionsDir,
  );

  // —— Tesseract Mechanical Enforcement (auto-capture edits to temporal mailbox) ——
  const toolInput = input.tool_input || input.toolInput || {};
  autoCaptureTesseract(toolName, toolInput, sessionCallCount, sessionsDir);
  let tesseractNudge = "";

  // Periodic nudge: remind LLM that rememberThis exists (mechanical, not LLM-dependent)
  try {
    if (
      sessionCallCount > 0 &&
      sessionCallCount % REMEMBER_THIS_NUDGE_INTERVAL === 0
    ) {
      tesseractNudge = `📝 SELF-MEMORY: You have \`rememberThis\` tool — use it to save important discoveries, decisions, or context for your future self. Notes survive compaction and auto-promote to opinions when valuable.`;
    }
  } catch {
    /* non-critical */
  }

  // —— Tesseract Lifecycle (summary + promotion + read→edit) ——
  try {
    runLifecycle({
      sessionsDir,
      memDir,
      callCount: sessionCallCount,
      toolName,
      toolInput,
    });
  } catch {
    /* non-critical */
  }

  // —— File Size Guardian + Track edits + Pipeline Audit + Code Discipline ——
  let fileSizeWarning = "";
  let pipelineAuditReminder = "";
  let disciplineWarning = "";
  if (EDIT_TOOLS.includes(toolName)) {
    fileSizeWarning = checkFileSizes(toolName, toolInput);
    trackEditedFiles(toolName, toolInput, sessionsDir, cwd);
    pipelineAuditReminder = buildPipelineAudit(sessionsDir, cwd);
    disciplineWarning = checkCodeDiscipline(toolName, toolInput, sessionsDir);

    // —— BLOCKING: Discipline violations reject the tool result ——
    if (disciplineWarning) {
      return {
        continue: false,
        hookSpecificOutput: {
          additionalContext:
            `⛔ QUALITY GATE BLOCKED — CODE DISCIPLINE:\n` +
            `El edit fue aplicado al disco pero VIOLA reglas de calidad.\n` +
            disciplineWarning +
            `\n\nACCIÓN REQUERIDA: Corrige las violaciones AHORA antes de continuar.` +
            (fileSizeWarning ? `\n\n${fileSizeWarning}` : ""),
        },
      };
    }

    // —— BLOCKING: File size violations ——
    if (fileSizeWarning) {
      return {
        continue: false,
        hookSpecificOutput: {
          additionalContext:
            `⛔ QUALITY GATE BLOCKED — FILE SIZE:\n` +
            fileSizeWarning +
            `\n\nACCIÓN REQUERIDA: Extrae código para bajar de 400 líneas antes de continuar.`,
        },
      };
    }
  }

  // —— Track audit actions (read-like tools count toward audit gate) ——
  trackAuditActions(toolName, cwd);

  // —— Deep identity reinforcement (every N calls — rich block) ——
  let deepIdentityBlock = "";
  try {
    if (
      sessionCallCount > 0 &&
      sessionCallCount % DEEP_REINFORCEMENT_INTERVAL === 0
    ) {
      const richSoul = parseSoulRich(memDir);
      deepIdentityBlock = formatDeepReminder(identity, richSoul, user);
    }
  } catch {
    /* non-critical */
  }

  // —— Prompt Context Injection (Writer/Injector pattern) ——
  const promptContextBlock = readPromptContext(sessionsDir);

  // —— Post-compact dual-channel recovery (second chance if PreToolUse missed it) ——
  let postCompactContext = "";
  try {
    postCompactContext = consumePostCompactPayload(cwd);
    // Activate recovery phase if post-compact payload was consumed
    if (postCompactContext) {
      try {
        writeFileSync(
          phaseFile,
          JSON.stringify({
            phase: "recovery",
            recoveryStart: sessionCallCount,
          }),
          "utf8",
        );
      } catch {
        /* non-critical */
      }
    }
  } catch {
    /* non-critical */
  }

  return {
    continue: true,
    hookSpecificOutput: {
      additionalContext:
        [
          postCompactContext || undefined,
          reminder || undefined,
          loopProtocol || undefined,
          strategyPrompt
            ? `ACTIVE STRATEGY — follow these instructions EXACTLY on every action, do not summarize or simulate:\n${strategyPrompt}`
            : undefined,
          tesseractNudge || undefined,
          pipelineAuditReminder || undefined,
          promptContextBlock || undefined,
          deepIdentityBlock || undefined,
          knowledgeBlock || undefined,
        ]
          .filter(Boolean)
          .join("\n") || undefined,
    },
  };
});
