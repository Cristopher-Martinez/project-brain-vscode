#!/usr/bin/env node
/**
 * SessionStart hook — Injects identity + BOOT.md + session handoff + top opinions
 * into EVERY new agent session (not just @brain).
 * This is the primary identity injection mechanism — zero tool call cost.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { guardedHook } from "./lib/hook-guard.mjs";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";

guardedHook("session-start", async (input) => {
  // ── Auto-update hooks if bundled extension version is newer ──────────────
  // Runs at session start so projects stay up-to-date without needing a
  // VS Code reload after the extension is updated.
  try {
    const extDir = join(
      homedir(),
      ".vscode",
      "extensions",
      "crismart.project-brain-0.1.0",
    );
    const bundledVersionFile = join(extDir, "static", "hooks", "hooks-version.json");
    const cwd = input.cwd || process.cwd();
    const deployedVersionFile = join(cwd, ".github", "hooks", "hooks-version.json");

    if (existsSync(bundledVersionFile) && existsSync(deployedVersionFile)) {
      const bundled = JSON.parse(readFileSync(bundledVersionFile, "utf8")).version || "";
      const deployed = JSON.parse(readFileSync(deployedVersionFile, "utf8")).version || "";

      if (bundled && bundled !== deployed) {
        // Copy scripts + lib directories from extension to project
        const srcScripts = join(extDir, "static", "hooks", "scripts");
        const destScripts = join(cwd, ".github", "hooks", "scripts");
        if (existsSync(srcScripts)) {
          cpSync(srcScripts, destScripts, { recursive: true, force: true });
        }
        // Update version marker
        cpSync(bundledVersionFile, deployedVersionFile, { force: true });
        // eslint-disable-next-line no-console
        console.error(`[session-start] Hooks auto-updated: ${deployed || "none"} → ${bundled}`);
      }
    }
  } catch {
    /* non-critical — never block session start */
  }
  // ─────────────────────────────────────────────────────────────────────────

  const { predictContext } = await import("./lib/context-predictor.mjs");
  const {
    formatCheckpointForInjection,
    isStaleCheckpoint,
    loadCheckpoint,
    loadToolCheckpoint,
  } = await import("./lib/execution-checkpoint.mjs");
  const { parseIdentity, parseUser } = await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const { getTopOpinions } = await import("./lib/opinion-parser.mjs");
  const { buildSoulParts } = await import("./lib/soul-assembler.mjs");
  const { getTopScored } = await import("./lib/memory-scorer.mjs");
  const { buildSearchCache } = await import("./lib/search-cache.mjs");
  const { recallDiary } = await import("./lib/session-diary.mjs");
  const { refreshPipelineCommands } = await import("./lib/pipeline-config.mjs");

  const cwd = input.cwd || process.cwd();
  const memDir = getMemoryDirWithFallback(cwd);
  const parts = [];

  // 0. Reset PostToolUse identity counter for fresh session
  const sessionsDir = join(memDir, "sessions");
  if (existsSync(sessionsDir)) {
    try {
      writeFileSync(join(sessionsDir, "hook-call-counter.txt"), "0", "utf8");
    } catch {
      /* skip */
    }
    // Reset pipeline edit tracker for fresh session
    try {
      writeFileSync(join(sessionsDir, "pipeline-edit-tracker.txt"), "", "utf8");
    } catch {
      /* skip */
    }
    // Auto-detect build/deploy/test commands on each session start
    refreshPipelineCommands(cwd);
    // Clear contract tracker from previous session
    try {
      const { clearContracts } = await import("./lib/code-discipline.mjs");
      clearContracts(sessionsDir);
    } catch {
      /* skip */
    }
    // Clear active strategy from previous session
    const strategyFile = join(sessionsDir, "active-strategy.txt");
    if (existsSync(strategyFile)) {
      try {
        writeFileSync(strategyFile, "", "utf8");
      } catch {
        /* skip */
      }
    }
    // Truncate stale tracking files (keep last 200 lines)
    try {
      const MAX_TRACKING_LINES = 200;
      for (const fname of ["subagent-tracking.jsonl", "capture-buffer.jsonl"]) {
        const fp = join(sessionsDir, fname);
        if (!existsSync(fp)) continue;
        const lines = readFileSync(fp, "utf8").split("\n").filter(Boolean);
        if (lines.length > MAX_TRACKING_LINES) {
          writeFileSync(
            fp,
            lines.slice(-MAX_TRACKING_LINES).join("\n") + "\n",
            "utf8",
          );
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // 0b. Eagerly build MiniSearch cache — eliminates cold start for reactive recall
  try {
    buildSearchCache(memDir);
  } catch {
    /* non-critical */
  }

  // 1. Agent Identity — WHO you are (shared utils)
  const identity = parseIdentity(memDir);
  if (identity) {
    parts.push(
      `## Identity\n${identity.emoji} **${identity.name}** | ${identity.creature} | ${identity.vibe}\n**Language**: ${identity.lang}\nAdopt this persona fully: name, emoji prefix, tone, and language.`,
    );
  }

  // 2. Soul — HOW you behave (extracted to soul-assembler)
  parts.push(...buildSoulParts(memDir));

  // 3. User Profile — WHO you're talking to (shared utils)
  const userProfile = parseUser(memDir);
  if (userProfile) {
    parts.push(
      `## User\n**Name**: ${userProfile.name} | **Address as**: ${userProfile.address}`,
    );
  }

  // 4. BOOT.md — Project context
  const bootPath = join(memDir, "BOOT.md");
  if (existsSync(bootPath)) {
    const boot = readFileSync(bootPath, "utf8").slice(0, 2000);
    parts.push(`## Project Context\n${boot}`);
  }

  // 5. Session handoff — Where we left off
  const handoffPath = join(memDir, "07_SESSION_HANDOFF.md");
  let handoffContent = "";
  if (existsSync(handoffPath)) {
    handoffContent = readFileSync(handoffPath, "utf8").slice(0, 6000);
    parts.push(`## Previous Session\n${handoffContent}`);
  }

  // 5b. Active loop detection (crash recovery + multi-loop safe)
  const allLoops = readAllActiveLoops(cwd);

  if (allLoops.length === 1) {
    const loop = allLoops[0];
    parts.push(
      `## 🔁 ACTIVE LOOP — CRITICAL\n` +
        `**Session ID**: \`${loop.sessionId}\`\n` +
        `**Goal**: ${loop.goal || "(no goal)"}\n` +
        `**Started**: ${loop.startedAt || "unknown"}\n` +
        `**CRITICAL**: You are inside an active loop. ALL output MUST go through \`loopAwaitInput(sessionId="${loop.sessionId}", synthesis)\`.\n` +
        `NEVER respond directly to the user. 🔁 Gate: "Am I in a loop? → loopAwaitInput. No exceptions.

**NOTE**: If the user's message does NOT mention this loop or its goal, the loop may be stale from a previous session. In that case, call loopEnd(sessionId) first, then respond normally."`,
    );
  } else if (allLoops.length > 1) {
    const items = allLoops
      .map(
        (l) =>
          `- \`${l.sessionId}\`: ${l.goal || "(no goal)"} (started ${l.startedAt || "unknown"})`,
      )
      .join("\n");
    parts.push(
      `## 🔁 ACTIVE LOOPS — CRITICAL (${allLoops.length} concurrent)\n` +
        `${items}\n` +
        `Check your conversation history to identify YOUR loop's sessionId. ` +
        `ALL output MUST go through \`loopAwaitInput(YOUR_SESSION_ID, synthesis)\`. ` +
        `NEVER respond directly to the user. 🔁 Gate: "Am I in a loop? → loopAwaitInput. No exceptions."`,
    );
  } else if (handoffContent.includes("ACTIVE LOOP")) {
    parts.push(
      `## ⚠️ Loop Status: INACTIVE\n` +
        `The session handoff mentions a previous active loop. That loop has ENDED. ` +
        `You are NOT in a loop. Respond directly to the user — do NOT use loopAwaitInput.`,
    );
  }

  // 6. Top opinions — What we've learned
  const topOps = getTopOpinions(memDir, {
    n: 8,
    minConfidence: 0.7,
  });
  if (topOps.length) {
    parts.push(`## Learned Behaviors\n${topOps}`);
  }

  // 7. Session Diary — temporal continuity across sessions
  const diaryRecall = recallDiary(memDir);
  if (diaryRecall) {
    parts.push(`## Recent Sessions\n${diaryRecall}`);
  }

  // 8. Top-scored memory — frequently referenced knowledge
  try {
    const topScored = getTopScored(memDir, 5);
    if (topScored.length > 0) {
      const lines = topScored.map(
        (e) => `• ${e.key} (hits=${e.hits}, relevance=${e.relevance})`,
      );
      parts.push(`## Frequently Referenced Knowledge\n${lines.join("\n")}`);

      // Record for utility feedback at session-stop
      try {
        writeFileSync(
          join(sessionsDir, "injected-recall.json"),
          JSON.stringify({
            ts: Date.now(),
            items: topScored.map((e) => e.key),
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

  // 9. Context prediction — anticipate next topics from diary patterns
  try {
    const predicted = predictContext(memDir);
    if (predicted) {
      parts.push(`## Predicted Focus\n${predicted}`);
    }
  } catch {
    /* non-critical — prediction is advisory */
  }

  // 10. Crash recovery — stale execution checkpoint from interrupted session
  try {
    const checkpoint = loadCheckpoint(memDir);
    const toolCp = loadToolCheckpoint(memDir);
    if (isStaleCheckpoint(checkpoint)) {
      let recoveryContext = formatCheckpointForInjection(checkpoint);
      // If a tool-level checkpoint exists, the crash happened MID-tool
      if (toolCp) {
        recoveryContext += `\n\n**Último tool ejecutándose al momento del crash**: \`${toolCp.tool}\`\n`;
        if (toolCp.inputSummary)
          recoveryContext += `**Input**: ${toolCp.inputSummary}\n`;
        recoveryContext += `**Iniciado**: ${toolCp.startedAt}\n`;
        recoveryContext += `⚠️ Este tool probablemente NO completó su ejecución. Verifica su efecto antes de continuar.`;
      }
      if (recoveryContext) {
        parts.push(
          `## ⚠️ CRASH RECOVERY — La sesión anterior murió mid-ejecución\n${recoveryContext}`,
        );
      }
    } else if (toolCp) {
      // No loop checkpoint but tool checkpoint exists — crash outside loop
      parts.push(
        `## ⚠️ CRASH RECOVERY — Tool interrumpido\n` +
          `**Último tool ejecutándose**: \`${toolCp.tool}\`\n` +
          (toolCp.inputSummary ? `**Input**: ${toolCp.inputSummary}\n` : "") +
          `**Iniciado**: ${toolCp.startedAt}\n` +
          `Verifica si este tool completó su ejecución antes de continuar.`,
      );
    }
  } catch {
    /* non-critical — crash recovery is best-effort */
  }

  const context = parts.join("\n\n---\n\n");
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
        ? `# 🧠 Session Context — Read This First\n\nYou are starting a new agent session. Below is your complete context: identity, user, project state, and learned behaviors.\n\n---\n\n${context}`
        : 'No project memory found. Run "Project Brain: Initialize" to set up.',
    },
  };
});
