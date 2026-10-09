#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Writer side of Writer/Injector pattern.
 * UserPromptSubmit does NOT support additionalContext, so this hook
 * uses the Writer/Injector Split pattern:
 *   - WRITER (this file): Scans user prompt for problem keywords,
 *     matches against 05_TROUBLESHOOTING.md entries, writes signal
 *     to sessions/prompt-context.json
 *   - INJECTOR (post-tool-capture.mjs): Reads the signal file on
 *     first tool call after prompt, injects via additionalContext,
 *     then clears the file.
 * I/O Contract:
 *   stdin  → { prompt, cwd, sessionId, hookEventName, timestamp }
 *   stdout → { continue: true } (common format only)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";
import { guardedHook } from "./lib/hook-guard.mjs";

// ——— Problem Keywords (EN/ES) ———————————————————————————————
const PROBLEM_KEYWORDS = [
  // Errors & failures
  "error",
  "fail",
  "falla",
  "bug",
  "broken",
  "roto",
  "crash",
  "exception",
  "undefined",
  "null",
  "typeerror",
  "referenceerror",
  "nan",
  "enoent",
  "eperm",
  "eacces",
  // Build & compile
  "compile",
  "compilar",
  "tsc",
  "build",
  "deploy",
  "bundle",
  "esbuild",
  // Module system
  "import",
  "require",
  "module",
  "circular",
  // Runtime
  "timeout",
  "permission",
  "cors",
  "hang",
  "freeze",
  "cuelga",
  "memory leak",
  "infinite loop",
  "stack overflow",
  // General problem language (ES)
  "problema",
  "no funciona",
  "no compila",
  "no arranca",
  "no carga",
  "warning",
  "deprecated",
  "breaking",
  // Project-specific
  "vectoriz",
  "mcp",
  "hook",
  "identity",
  "soul",
  "opinion",
  "session",
  "handoff",
  "brain hq",
  "orchestrat",
];

guardedHook("user-prompt-writer", async (input) => {
  const { KNOWLEDGE_REINJECTION_INTERVAL } =
    await import("./lib/constants.mjs");
  const { parseIdentity } = await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const { sanitizeContent } = await import("./lib/sanitize.mjs");
  const { querySearchCache } = await import("./lib/search-cache.mjs");

  const prompt = (input.prompt || "").trim();
  const cwd = input.cwd || process.cwd();

  if (!prompt || prompt.length < 5)
    return { continue: true, hookSpecificOutput: {} };

  const promptLower = prompt.toLowerCase();

  // 1. Check for problem keyword matches
  const matchedKeywords = PROBLEM_KEYWORDS.filter((kw) =>
    promptLower.includes(kw),
  );

  // 2. Extract file mentions from prompt (proactive recall)
  const filePattern =
    /\b([\w-]+\.(?:ts|mjs|js|tsx|jsx|json|md|yaml|yml|css|html))\b/gi;
  const fileMatches = [
    ...new Set((prompt.match(filePattern) || []).map((f) => f.toLowerCase())),
  ];

  if (matchedKeywords.length === 0 && fileMatches.length === 0) {
    return { continue: true, hookSpecificOutput: {} };
  }

  // 3. Read troubleshooting entries
  const memDir = getMemoryDirWithFallback(cwd);
  const troublePath = join(memDir, "05_TROUBLESHOOTING.md");
  if (!existsSync(troublePath))
    return { continue: true, hookSpecificOutput: {} };

  const raw = readFileSync(troublePath, "utf8");
  const sections = raw.split(/^## /m).filter(Boolean);

  // 4. Score entries by keyword + file-mention overlap
  const entries = [];
  for (const section of sections) {
    const lines = section.split("\n");
    const title = (lines[0] || "").trim();
    if (!title || title.startsWith("<!--")) continue;

    const bodyPreview = lines.slice(0, 12).join("\n");
    const searchable = (title + " " + bodyPreview).toLowerCase();

    const kwOverlap = matchedKeywords.filter((kw) => searchable.includes(kw));
    const fileOverlap = fileMatches.filter((f) => searchable.includes(f));
    if (kwOverlap.length > 0 || fileOverlap.length > 0) {
      entries.push({
        title: sanitizeContent(title).substring(0, 200),
        snippet: sanitizeContent(bodyPreview).substring(0, 500),
        relevance: kwOverlap.length + fileOverlap.length * 2,
        keywords: kwOverlap,
      });
    }
  }

  // Only bail if no entries AND no file context to search
  if (entries.length === 0 && fileMatches.length === 0) {
    return { continue: true, hookSpecificOutput: {} };
  }

  // 5. Also check learnings for keyword + file-mention matches
  const learningEntries = [];
  const learningsPath = join(memDir, "04_LEARNINGS.md");
  if (existsSync(learningsPath)) {
    try {
      const learningsRaw = readFileSync(learningsPath, "utf8");
      const learnSections = learningsRaw.split(/^## /m).filter(Boolean);
      for (const section of learnSections.slice(-10)) {
        const lines = section.split("\n");
        const title = (lines[0] || "").trim();
        if (!title) continue;

        const bodyPreview = lines.slice(0, 8).join("\n");
        const searchable = (title + " " + bodyPreview).toLowerCase();

        const kwOverlap = matchedKeywords.filter((kw) =>
          searchable.includes(kw),
        );
        const fileOverlap = fileMatches.filter((f) => searchable.includes(f));
        if (kwOverlap.length > 0 || fileOverlap.length > 0) {
          learningEntries.push({
            title: sanitizeContent(title).substring(0, 200),
            snippet: sanitizeContent(bodyPreview).substring(0, 300),
            relevance: kwOverlap.length + fileOverlap.length * 2,
          });
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // 6. Fuzzy search via MiniSearch (opinions + supplementary matches)
  const sessionsDir = join(memDir, "sessions");
  let fuzzyMatches = "";
  try {
    fuzzyMatches = querySearchCache(sessionsDir, prompt.substring(0, 200), 5);
  } catch {
    /* non-critical */
  }

  // 7. Write signal file (top 3 troubleshooting + top 2 learnings + fuzzy)
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const signal = {
    keywords: matchedKeywords.slice(0, 10),
    fileMatches: fileMatches.slice(0, 5),
    troubleshooting: entries
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3),
    learnings: learningEntries
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 2),
    fuzzyMatches: fuzzyMatches || "",
    timestamp: new Date().toISOString(),
    promptSnippet: sanitizeContent(prompt.substring(0, 80)),
  };

  writeFileSync(
    join(sessionsDir, "prompt-context.json"),
    JSON.stringify(signal, null, 2),
    "utf8",
  );

  // ═══════════════════════════════════════════════════════════
  // 8. COMPACTION PREDICTOR — pre-write enriched payload
  // ═══════════════════════════════════════════════════════════
  // Estimate if the next exchange will trigger compaction.
  // If likely, pre-write post-compact-payload.json so PreCompact
  // can enrich it further, and the recovery is richer than cold-start.
  predictCompaction(cwd, prompt.length, readAllActiveLoops, parseIdentity);

  return { continue: true, hookSpecificOutput: {} };
});

/**
 * Predict if compaction is imminent based on heuristics.
 * When likely, pre-writes post-compact-payload.json so PreCompact can enrich it.
 * Heuristics:
 *   - High tool call count (>40 = many exchanges consumed)
 *   - Long user prompt (>2000 chars = heavy token pressure)
 *   - Active loops (higher compaction risk — long sessions)
 * The pre-written payload has `predictedAt` timestamp. PreCompact overwrites
 * it with fresh data, so this is a fallback if PreCompact runs before we
 * can enrich, or if the prediction fires early (harmless — 30min TTL).
 * @param {string} cwd - Workspace root
 * @param {number} promptLength - Length of current user prompt
 * @param {Function} readAllActiveLoops - Loop reader function
 * @param {Function} parseIdentity - Identity parser function
 */
function predictCompaction(
  cwd,
  promptLength,
  readAllActiveLoops,
  parseIdentity,
) {
  try {
    const memDir = getMemoryDirWithFallback(cwd);
    const sessionsDir = join(memDir, "sessions");
    const payloadPath = join(sessionsDir, "post-compact-payload.json");

    // Don't overwrite a fresh payload from actual PreCompact
    if (existsSync(payloadPath)) {
      try {
        const existing = JSON.parse(readFileSync(payloadPath, "utf8"));
        if (existing.reason === "context-compaction") return; // real payload exists
      } catch {
        /* corrupt, overwrite ok */
      }
    }

    // Read tool call counter
    let callCount = 0;
    const counterFile = join(sessionsDir, "hook-call-counter.txt");
    if (existsSync(counterFile)) {
      callCount = parseInt(readFileSync(counterFile, "utf8").trim(), 10) || 0;
    }

    const allLoops = readAllActiveLoops(cwd);

    // Scoring: higher = more likely compaction is imminent
    let risk = 0;
    if (callCount > 60) risk += 3;
    else if (callCount > 40) risk += 2;
    else if (callCount > 25) risk += 1;

    if (promptLength > 4000) risk += 2;
    else if (promptLength > 2000) risk += 1;

    if (allLoops.length > 0) risk += 1; // loops = long sessions

    // Threshold: risk >= 3 → pre-write
    if (risk < 3) return;

    const identity = parseIdentity(memDir);

    const predictedPayload = {
      timestamp: Date.now(),
      reason: "compaction-predicted",
      loops: allLoops.map((l) => ({
        sessionId: l.sessionId,
        goal: l.goal || "",
        startedAt: l.startedAt || "",
      })),
      identity: identity
        ? { name: identity.name, emoji: identity.emoji, lang: identity.lang }
        : null,
      deferredToolReminder: allLoops.length > 0,
      predictedAt: new Date().toISOString(),
      riskScore: risk,
      callCount,
    };

    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    writeFileSync(payloadPath, JSON.stringify(predictedPayload), "utf8");
  } catch {
    /* non-critical */
  }
}
