#!/usr/bin/env node
/**
 * PreCompact hook — Preserves critical state before context truncation.
 * Fires BEFORE VS Code compresses the conversation. This is the LAST CHANCE
 * to save state that would otherwise be lost. We write to SESSION_HANDOFF.md
 * because the agent's instructions say "search session handoff on first message".
 * Preserves:
 *   1. Active loop state (sessionId, goal) — prevents loop amnesia
 *   2. Agent identity (name, emoji, language) — prevents persona loss
 *   3. Key decisions from transcript — prevents strategic amnesia
 * @updated 2026-02-20 — Added loop + identity preservation
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";
import { guardedHook } from "./lib/hook-guard.mjs";

guardedHook("pre-compact", async (input) => {
  const { KNOWLEDGE_REINJECTION_INTERVAL } =
    await import("./lib/constants.mjs");
  const { safeRead } = await import("./lib/fs-utils.mjs");
  const { getTopNotesForInjection } =
    await import("./lib/temporal-mailbox.mjs");
  const { parseIdentity, parseSoulCore, parseUser } =
    await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const { querySearchCache } = await import("./lib/search-cache.mjs");

  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path;
  const memoryDir = getMemoryDirWithFallback(cwd);

  if (!existsSync(memoryDir)) {
    return { continue: true, hookSpecificOutput: {} };
  }

  const sessionsDir = join(memoryDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const sections = [];
  const now = new Date().toISOString();

  // ═══════════════════════════════════════════════════════════
  // 1. ACTIVE LOOP PRESERVATION (multi-loop safe, TTL-aware)
  // ═══════════════════════════════════════════════════════════
  const allLoops = readAllActiveLoops(cwd);
  for (const loop of allLoops) {
    sections.push(
      `## 🔁 ACTIVE LOOP — DO NOT FORGET`,
      `**Session ID**: \`${loop.sessionId}\``,
      `**Goal**: ${loop.goal || "(no goal)"}`,
      `**Started**: ${loop.startedAt || "unknown"}`,
      `**CRITICAL**: You are inside an active loop. ALL output MUST go through \`loopAwaitInput(sessionId="${loop.sessionId}", synthesis)\`.`,
      `NEVER respond directly to the user. 🔁 Gate: "Am I in a loop? → loopAwaitInput. No exceptions.

**NOTE**: The user's feedback topic MAY change within a loop — this is NORMAL. The loop goal evolves as the user pivots between tasks. Do NOT close the loop based on topic mismatch. Only the user can end a loop (via 'End Loop' in Brain HQ or explicit request). If unsure, ask the user via loopAwaitInput synthesis."`,
      ``,
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 1b. POST-COMPACT PAYLOAD (one-shot recovery for PreToolUse)
  // ═══════════════════════════════════════════════════════════
  // Write a flag file that PreToolUse reads on the FIRST tool call
  // after compaction. Provides explicit context injection so the LLM
  // doesn't have to rely on the compactor preserving everything.
  const identityForPayload = parseIdentity(memoryDir);
  const postCompactPayload = {
    timestamp: Date.now(),
    reason: "context-compaction",
    loops: allLoops.map((l) => ({
      sessionId: l.sessionId,
      goal: l.goal || "",
      startedAt: l.startedAt || "",
    })),
    identity: identityForPayload
      ? {
          name: identityForPayload.name,
          emoji: identityForPayload.emoji,
          lang: identityForPayload.lang,
        }
      : null,
    deferredToolReminder: allLoops.length > 0,
  };

  // 1b-ii. Include temporal notes (Tesseract) in payload for post-compact recovery
  try {
    const { notes } = getTopNotesForInjection(sessionsDir, 7);
    if (notes.length > 0) {
      postCompactPayload.temporalNotes = notes.map((n) => ({
        id: n.id,
        text: n.text,
        importance: n.importance,
        timestamp: n.timestamp,
      }));
    }
  } catch {
    /* non-critical */
  }

  try {
    writeFileSync(
      join(sessionsDir, "post-compact-payload.json"),
      JSON.stringify(postCompactPayload),
      "utf8",
    );
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 1c. RESET TOOL CALL COUNTER (force immediate knowledge re-injection)
  // ═══════════════════════════════════════════════════════════
  // PostToolUse uses hook-call-counter.txt to decide when to re-inject
  // knowledge (every N calls). After compaction, context is empty so
  // knowledge should re-inject on the FIRST post-compaction tool call.
  // Reset counter to N-1 so next increment triggers knowledge injection.
  try {
    writeFileSync(
      join(sessionsDir, "hook-call-counter.txt"),
      String(KNOWLEDGE_REINJECTION_INTERVAL - 1),
      "utf8",
    );
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 2. IDENTITY + SOUL PRESERVATION (full — using shared utils)
  // ═══════════════════════════════════════════════════════════
  const identity = parseIdentity(memoryDir);
  const soul = parseSoulCore(memoryDir);
  const user = parseUser(memoryDir);

  if (identity) {
    const idLines = [
      `## 🪪 Identity (Pre-Compact Save)`,
      `**You are**: ${identity.emoji} ${identity.name} (${identity.creature})`,
      `**Vibe**: ${identity.vibe}`,
      `**Language**: ${identity.lang} — respond in this language ALWAYS`,
    ];
    if (soul) {
      if (soul.tone) idLines.push(`**Tone**: ${soul.tone}`);
      if (soul.approach) idLines.push(`**Approach**: ${soul.approach}`);
      if (soul.style) idLines.push(`**Style**: ${soul.style}`);
      if (soul.boundaries) idLines.push(`**Boundaries**: ${soul.boundaries}`);
    }
    if (user) {
      idLines.push(`**User**: ${user.address || user.name}`);
    }
    idLines.push(``);
    sections.push(...idLines);
  }

  // ═══════════════════════════════════════════════════════════
  // 3. DECISION EXTRACTION FROM TRANSCRIPT
  // ═══════════════════════════════════════════════════════════
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const transcript = readFileSync(transcriptPath, "utf8");
      const decisions = [];
      const patterns = [
        /(?:decided|choosing|going with|will use|switched to)\s+(.{10,100})/gi,
        /(?:TODO|FIXME|HACK):\s*(.{10,100})/gi,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(transcript)) && decisions.length < 10) {
          decisions.push(match[1].trim());
        }
      }

      if (decisions.length > 0) {
        const entry = `\n## Pre-Compact Save (${now})\n${decisions.map((d) => `- ${d}`).join("\n")}\n`;
        appendFileSync(join(memoryDir, "TASK_QUEUE.md"), entry, "utf8");
      }
    } catch {
      /* non-critical */
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3b. TROUBLESHOOTING REFERENCE PRESERVATION
  // ═══════════════════════════════════════════════════════════
  // Use MiniSearch fuzzy cache to find relevant troubleshooting entries,
  // with fallback to keyword matching if cache unavailable.
  try {
    // Check edit-tracker for files being worked on
    const trackerPath = join(sessionsDir, "edit-tracker.txt");
    let editedFiles = [];
    if (existsSync(trackerPath)) {
      try {
        editedFiles = readFileSync(trackerPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((f) => f.replace(/\.[^.]+$/, "").toLowerCase());
      } catch {
        /* non-critical */
      }
    }

    if (editedFiles.length > 0) {
      // Extract domain keywords from edited files
      const keywords = [];
      for (const name of editedFiles) {
        for (const part of name.split(/[-_./\\]+/)) {
          if (part.length > 2) keywords.push(part);
        }
      }
      const query = [...new Set(keywords)].slice(0, 10).join(" ");

      // Try MiniSearch cache first
      const cached = querySearchCache(sessionsDir, query, 5);
      if (cached) {
        // Filter to troubleshooting entries only
        const troubleLines = cached
          .split("\n")
          .filter((l) => l.includes("[troubleshooting]"));
        if (troubleLines.length > 0) {
          sections.push(
            `## 🔍 Active Troubleshooting References`,
            `These may be relevant to your current work:`,
            ...troubleLines.slice(0, 5),
            `Check \`.project-brain/memory/05_TROUBLESHOOTING.md\` for full details.`,
            ``,
          );
        }
      }

      // Fallback: keyword matching if no cache results
      if (!cached) {
        const troublePath = join(memoryDir, "05_TROUBLESHOOTING.md");
        const troubleContent = safeRead(troublePath, 8000);
        if (troubleContent) {
          const troubleSections = troubleContent.split(/^## /m).filter(Boolean);
          const troubleTitles = troubleSections
            .map((s) => s.split("\n")[0]?.trim() || "")
            .filter(Boolean);

          const relevant = [];
          for (const title of troubleTitles) {
            const titleLower = title.toLowerCase();
            const isRelevant = editedFiles.some((f) =>
              f
                .split(/[-_]/)
                .some((kw) => kw.length > 2 && titleLower.includes(kw)),
            );
            if (isRelevant) relevant.push(title);
          }

          if (relevant.length > 0) {
            sections.push(
              `## 🔍 Active Troubleshooting References`,
              `These may be relevant to your current work:`,
              ...relevant.slice(0, 5).map((t) => `- ${t}`),
              `Check \`.project-brain/memory/05_TROUBLESHOOTING.md\` for full details.`,
              ``,
            );
          }
        }
      }
    }
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 4. WRITE SESSION HANDOFF (prepend critical sections)
  // ═══════════════════════════════════════════════════════════
  if (sections.length > 0) {
    const handoffPath = join(memoryDir, "07_SESSION_HANDOFF.md");
    let existing = "";
    if (existsSync(handoffPath)) {
      existing = readFileSync(handoffPath, "utf8");
    }

    // Remove any previous pre-compact sections to avoid stacking
    const cleaned = existing
      .replace(
        /## 🔁 ACTIVE LOOP — DO NOT FORGET[\s\S]*?(?=\n## [^🔁]|\n$|$)/g,
        "",
      )
      .replace(
        /## 🪪 Identity \(Pre-Compact Save\)[\s\S]*?(?=\n## [^🪪]|\n$|$)/g,
        "",
      )
      .trim();

    // Insert after the header line
    const headerEnd = cleaned.indexOf("\n\n");
    const header =
      headerEnd > 0 ? cleaned.substring(0, headerEnd) : "# Session Handoff";
    const body = headerEnd > 0 ? cleaned.substring(headerEnd) : "";

    const result = [
      header,
      "",
      `<!-- Pre-Compact Save: ${now} -->`,
      ...sections,
      body.trim(),
    ].join("\n");

    writeFileSync(handoffPath, result + "\n", "utf8");
  }

  return { continue: true, hookSpecificOutput: {} };
});
