#!/usr/bin/env node
/**
 * Stop hook — Saves session handoff + writes pending context for AI summarization.
 * This hook is LIGHTWEIGHT — it only writes raw data.
 * The actual AI summarization happens in the extension (session-summarizer.ts)
 * using VS Code's Language Model API (Copilot) on next activation.
 * Output files:
 *   07_SESSION_HANDOFF.md   — Human-readable session state
 *   .session-pending.json   — Machine-readable context for AI summary
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { guardedHook } from "./lib/hook-guard.mjs";

guardedHook("session-stop", async (input) => {
  const { processCaptureBuffer } = await import("./lib/capture-buffer.mjs");
  const { analyzePatterns } = await import("./lib/cross-session-analyzer.mjs");
  const { dedupLearnings } = await import("./lib/dedup-learnings.mjs");
  const { updateEntityGraph } = await import("./lib/entity-graph.mjs");
  const { clearCheckpoint, clearToolCheckpoint } =
    await import("./lib/execution-checkpoint.mjs");
  const { safeRead } = await import("./lib/fs-utils.mjs");
  const { parseIdentity } = await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const { processScores } = await import("./lib/memory-scorer.mjs");
  const { getTopOpinions } = await import("./lib/opinion-parser.mjs");
  const { evolveOpinions } = await import("./lib/opinion-tracker.mjs");
  const { buildSearchCache } = await import("./lib/search-cache.mjs");
  const { appendDiaryEntry } = await import("./lib/session-diary.mjs");
  const { consolidateLearnings } = await import("./lib/smart-consolidator.mjs");
  const { getPromotableNotes, markPromoted } =
    await import("./lib/temporal-mailbox.mjs");

  if (input.stop_hook_active) {
    return { continue: true, hookSpecificOutput: {} };
  }

  const cwd = input.cwd || process.cwd();
  const memoryDir = getMemoryDirWithFallback(cwd);

  // ═══ LOOP GATE: block stop if active loops exist (one mechanical chance) ═══
  // ANTI-AMNESIA: The LLM may "forget" the loop after context compaction and try
  // to respond directly. Uses assertive BLOCKED messaging.
  let earlyLoops = [];
  if (existsSync(memoryDir)) {
    earlyLoops = readAllActiveLoops(cwd);
    if (earlyLoops.length > 0) {
      const loopIds = earlyLoops
        .map((l) => `sessionId="${l.sessionId}"`)
        .join(", ");
      return {
        continue: true,
        hookSpecificOutput: {
          decision: "block",
          reason: [
            `⚠️ BLOCKED — STOP BLOCKED. ${earlyLoops.length} ACTIVE LOOP(s): ${loopIds}.`,
            `Agent is BLOCKED from direct responses. MUST call loopAwaitInput(sessionId, synthesis).`,
            `This gate reads from disk — survives context compaction. Trust it.`,
          ].join(" "),
          additionalContext: `⚠️ STOP BLOCKED — ${earlyLoops.length} ACTIVE LOOP(s): ${loopIds}. Agent MUST call loopAwaitInput, not respond directly.`,
        },
      };
    }
  }

  if (!existsSync(memoryDir)) {
    return { continue: true, hookSpecificOutput: {} };
  }

  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      return "(unavailable)";
    }
  };

  const branch = runGit(["branch", "--show-current"]);
  const lastCommit = runGit(["log", "-1", "--format=%h %s"]);
  const status = runGit(["status", "--short"]);
  const recentCommits = runGit(["log", "--oneline", "-5"]);

  const now = new Date().toISOString();

  // ═══ 1. Write handoff (human-readable) ═══════════════════════════════════
  // Check for active loops (reuse earlyLoops from gate check — EC-3 fix: eliminates redundant FS read)
  const allLoops = earlyLoops || readAllActiveLoops(cwd);
  const loopSection =
    allLoops.length > 0
      ? allLoops
          .map(
            (loop) => `
## ⚠️ BLOCKED — ACTIVE LOOP
**Session ID**: \`${loop.sessionId}\`
**Goal**: ${loop.goal || "(no goal)"}
**Started**: ${loop.startedAt || "unknown"}
Agent is BLOCKED from direct text responses. ALL output MUST go through \`loopAwaitInput(sessionId="${loop.sessionId}", synthesis)\`.
This state is disk-backed — survives context compaction. Trust it.
`,
          )
          .join("")
      : "";

  // ═══ Gather enrichment data for handoff ═══════════════════════════════
  const topOpinions = getTopOpinions(memoryDir, {
    n: 5,
    maxBytes: 10000,
    bullet: "-",
    truncate: 120,
  });
  const recentLearnings = getRecentLearnings(memoryDir, 3, safeRead);

  const handoff = `# Session Handoff

<!-- Auto-generated. Provides context for next session/agent. -->

## Session Info
**Date**: ${now}
**Branch**: \`${branch}\`
**Last Commit**: \`${lastCommit}\`
${loopSection}
## What Was Being Worked On
${input.taskContext || "_(Not provided — check recent commits and changes below)_"}

## Recent Commits (Last 5)
${recentCommits
  .split("\n")
  .map((c) => `- \`${c}\``)
  .join("\n")}

## Uncommitted Changes
${
  status
    ? status
        .split("\n")
        .map((s) => `- ${s.trim()}`)
        .join("\n")
    : "- (clean working tree)"
}
${topOpinions ? `\n## Top Beliefs (highest confidence)\n${topOpinions}\n` : ""}${recentLearnings ? `\n## Recent Learnings\n${recentLearnings}\n` : ""}
## What To Do Next
${input.nextSteps || "_(Check TASK_QUEUE.md or ask what needs to be done)_"}

## Context for Handoffs
- **Project**: ${getProjectName(cwd)}
- **Build**: Check package.json for scripts
- **Memory**: .project-brain/memory/ (vectorized via MCP)
- **Identity**: ${getIdentityLine(cwd, parseIdentity)}
`;
  writeFileSync(join(memoryDir, "07_SESSION_HANDOFF.md"), handoff, "utf8");

  // ═══ 2b. Append session diary entry (episodic memory) ═══════════════
  appendDiaryEntry(memoryDir, {
    branch,
    status,
    lastCommit,
    taskContext: input.taskContext,
  });

  // ═══ 2c. Clear execution checkpoint (clean exit = no crash recovery needed) ═══
  clearCheckpoint(memoryDir);
  clearToolCheckpoint(memoryDir);

  // ═══ 2. Write pending context (for AI summarization on next activation)
  const diffStat = runGit(["diff", "--stat", "HEAD~5"]);
  const changedFiles = runGit(["diff", "--name-only", "HEAD~5"]);
  const recentCommits10 = runGit(["log", "--oneline", "-10"]);

  const pending = {
    date: now,
    branch,
    lastCommit,
    recentCommits: recentCommits10,
    uncommittedChanges: status || "(clean)",
    diffStat,
    changedFiles,
    taskContext: input.taskContext || "",
  };

  writeFileSync(
    join(memoryDir, ".session-pending.json"),
    JSON.stringify(pending, null, 2),
    "utf8",
  );

  // ═══ 3. Refresh knowledge-summary.txt (anti-staleness) ═══════════════
  refreshKnowledgeSummary(memoryDir, safeRead);

  // ═══ 3b. Deduplicate learnings (anti-bloat) ═══════════════════════════
  dedupLearnings(memoryDir);

  // ═══ 4. Evolve opinions from agent-mode signals ═══════════════════════
  evolveOpinions(memoryDir);

  // ═══ 4b. Cross-session pattern analysis ═══════════════════════════════
  analyzePatterns(memoryDir);

  // ═══ 4c. Semantic capture — feed session context to capture pipeline ═══
  try {
    const bufferPath = join(memoryDir, "sessions", "capture-buffer.jsonl");
    const extraTexts = [];
    if (input.taskContext && input.taskContext.length > 30) {
      extraTexts.push(input.taskContext);
    }
    if (lastCommit && lastCommit !== "(unavailable)") {
      extraTexts.push(`Recent work: ${lastCommit}`);
    }
    if (recentCommits && recentCommits !== "(unavailable)") {
      extraTexts.push(`Session commits: ${recentCommits}`);
    }
    for (const text of extraTexts) {
      const line =
        JSON.stringify({ ts: Date.now(), tool: "session-summary", text }) +
        "\n";
      appendFileSync(bufferPath, line, "utf8");
    }
  } catch {
    /* non-critical */
  }

  // ═══ 5. Process capture buffer for agent-mode learnings ═══════════════
  processCaptureBuffer(memoryDir);

  // ═══ 5b. Process memory scores (usage-based relevance) ═══════════════
  processScores(memoryDir);

  // ═══ 5c. Smart consolidation (archive stale learnings) ═══════════════
  consolidateLearnings(memoryDir);

  // ═══ 5d. Update entity graph (co-occurrence map) ═══════════════════════
  updateEntityGraph(memoryDir);

  // ═══ 5e. Promote mature temporal notes to opinions (Tesseract) ═══════
  try {
    const sessionsDir = join(memoryDir, "sessions");
    const { promotable } = getPromotableNotes(sessionsDir);
    if (promotable.length > 0) {
      const opinionsPath = join(memoryDir, "14_OPINIONS.md");
      const today = new Date().toISOString().slice(0, 10);
      const newEntries = promotable
        .map(
          (n) =>
            `\n### [auto-promoted] ${n.text.slice(0, 80)}\n- **Confidence**: ${(n.importance * 100).toFixed(0)}%\n- **Source**: Temporal self-reminder (promoted ${today})\n- **Hits**: ${n.hits}\n`,
        )
        .join("");
      appendFileSync(opinionsPath, newEntries, "utf8");
      markPromoted(
        sessionsDir,
        promotable.map((n) => n.id),
      );
    }
  } catch {
    /* non-critical */
  }

  // ═══ 6. Build MiniSearch cache for fuzzy domain matching ═══════════════
  buildSearchCache(memoryDir);

  return { continue: true, hookSpecificOutput: {} };
});

/**
 * Regenerate sessions/knowledge-summary.txt from current memory files.
 * This keeps injection data fresh — prevents subagents and PostToolUse
 * from injecting stale knowledge across sessions.
 * Sources: 11_PROGRAMMING_PREFS.md, 04_LEARNINGS.md, 05_TROUBLESHOOTING.md
 * Format must match what readKnowledgeSummary() in fs-utils.mjs returns.
 */
function refreshKnowledgeSummary(memoryDir, safeRead) {
  try {
    const sessionsDir = join(memoryDir, "sessions");
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const parts = [];

    // 1. Programming preferences (compact — first 600 chars)
    const prefs = safeRead(join(memoryDir, "11_PROGRAMMING_PREFS.md"), 800);
    if (prefs) {
      // Keep first section (usually Architecture & Patterns)
      const cutoff = prefs.indexOf("\n## ", 10);
      const compact = cutoff > 0 ? prefs.slice(0, cutoff).trim() : prefs.trim();
      parts.push(`## Preferences\n${compact.slice(0, 600)}`);
    }

    // 2. Recent learnings — last 5 section titles
    const learnings = safeRead(join(memoryDir, "04_LEARNINGS.md"), 8000);
    if (learnings) {
      const sections = learnings.split(/^## /m).filter(Boolean).slice(-5);
      const titles = sections
        .map((s) => `\u2022 ${s.split("\n")[0]?.trim().slice(0, 120) || ""}`)
        .filter((t) => t.length > 2);
      if (titles.length) {
        parts.push(`## Recent Learnings\n${titles.join("\n")}`);
      }
    }

    // 3. Recent troubleshooting — last 3 section titles
    const trouble = safeRead(join(memoryDir, "05_TROUBLESHOOTING.md"), 8000);
    if (trouble) {
      const sections = trouble.split(/^## /m).filter(Boolean).slice(-3);
      const titles = sections
        .map((s) => `\u2022 ${s.split("\n")[0]?.trim().slice(0, 120) || ""}`)
        .filter((t) => t.length > 2);
      if (titles.length) {
        parts.push(`## Known Issues\n${titles.join("\n")}`);
      }
    }

    if (parts.length > 0) {
      writeFileSync(
        join(sessionsDir, "knowledge-summary.txt"),
        parts.join("\n\n") + "\n",
        "utf8",
      );
    }
  } catch {
    /* non-critical — fail silently */
  }
}

function getIdentityLine(cwd, parseIdentity) {
  const memDir = getMemoryDirWithFallback(cwd);
  const identity = parseIdentity(memDir);
  return identity ? `${identity.name} ${identity.emoji}` : "Agent 🧠";
}

function getProjectName(cwd) {
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return pkg.name || "unknown";
    }
  } catch {
    /* non-critical */
  }
  return "unknown";
}

/**
 * Extract last N learning entry titles from 04_LEARNINGS.md.
 * Gives the next context window a quick view of recent knowledge.
 */
function getRecentLearnings(memoryDir, n, safeRead) {
  try {
    const raw = safeRead(join(memoryDir, "04_LEARNINGS.md"), 8000);
    if (!raw) return "";

    const sections = raw.split(/^## /m).filter(Boolean).slice(-n);
    const titles = sections
      .map((s) => `- ${s.split("\n")[0]?.trim().slice(0, 120) || ""}`)
      .filter((t) => t.length > 2);

    return titles.length > 0 ? titles.join("\n") : "";
  } catch {
    return "";
  }
}
