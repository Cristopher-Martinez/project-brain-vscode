#!/usr/bin/env node
/**
 * SubagentStart hook — Context inheritance for spawned subagents.
 * Responsibilities:
 *   1. Inject BOOT.md context so subagents know the project
 *   2. Inject identity basics (name, emoji, language) for persona consistency
 *   3. Track spawn chain in sessions/subagent-tracking.jsonl
 *   4. Inject relevant skills if agent_type matches known specializations
 * I/O Contract:
 *   stdin  → { agent_id, agent_type, cwd, sessionId, timestamp }
 *   stdout → { continue, hookSpecificOutput: { additionalContext } }
 * NOTE: agent_type values are not fully documented. We handle gracefully.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { guardedHook } from "./lib/hook-guard.mjs";
import { getMemoryDirWithFallback } from "./lib/brain-paths.mjs";

guardedHook("subagent-start", async (input) => {
  const { parseIdentity, parseSoulCore, parseUser } =
    await import("./lib/identity-utils.mjs");
  const { readAllActiveLoops } = await import("./lib/loop-utils.mjs");
  const {
    BOOT_MAX,
    KNOWLEDGE_MAX,
    OPINIONS_MAX,
    OPINIONS_MIN_CONFIDENCE,
    OPINIONS_TOP_N,
  } = await import("./lib/constants.mjs");
  const { readKnowledgeSummary, safeRead } = await import("./lib/fs-utils.mjs");
  const { getTopOpinions } = await import("./lib/opinion-parser.mjs");
  const { readPlanCache } = await import("./lib/plan-utils.mjs");
  const { sanitizeAgentId, sanitizeContent, sanitizeForInjection } =
    await import("./lib/sanitize.mjs");

  const cwd = input.cwd || process.cwd();
  const agentId = sanitizeAgentId(input.agent_id || "unknown");
  const agentType = input.agent_type || "unknown";
  const sessionId = input.sessionId || "unknown";
  const memoryDir = getMemoryDirWithFallback(cwd);
  const sessionsDir = join(memoryDir, "sessions");

  if (!existsSync(memoryDir)) {
    return { continue: true };
  }

  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  // ═══════════════════════════════════════════════════════════
  // 1. SPAWN CHAIN TRACKING
  // ═══════════════════════════════════════════════════════════

  const entry = {
    t: new Date().toISOString(),
    event: "start",
    agentId,
    agentType,
    parentSession: sessionId,
  };

  try {
    appendFileSync(
      join(sessionsDir, "subagent-tracking.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf8",
    );
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 2. CONTEXT INHERITANCE
  // ═══════════════════════════════════════════════════════════

  const contextParts = [];
  const plan = readPlanCache(memoryDir);

  // 2a. Identity + Soul basics (Pro+ only — enriched for persona consistency)
  if (plan !== "free") {
    const identity = parseIdentity(memoryDir);
    const soul = parseSoulCore(memoryDir);
    const user = parseUser(memoryDir);

    if (identity) {
      const idParts = [
        `**Agent**: ${identity.emoji} ${identity.name} (${identity.creature}) | **Language**: ${identity.lang}`,
      ];
      if (soul?.tone) idParts.push(`**Tone**: ${soul.tone}`);
      if (soul?.style) idParts.push(`**Style**: ${soul.style}`);
      if (soul?.approach) idParts.push(`**Approach**: ${soul.approach}`);
      if (soul?.boundaries) idParts.push(`**Boundaries**: ${soul.boundaries}`);
      if (user) idParts.push(`**User**: ${user.address || user.name}`);
      idParts.push(`Adopt this persona fully. Respond in ${identity.lang}.`);
      contextParts.push(idParts.join("\n"));
    }
  }

  // 2b. BOOT.md (compressed project context — sanitized + capped)
  const bootPath = join(memoryDir, "BOOT.md");
  if (existsSync(bootPath)) {
    const boot = safeRead(bootPath, BOOT_MAX);
    const compactBoot =
      boot.split("## Current Status")[0]?.trim().slice(0, BOOT_MAX) ||
      boot.slice(0, BOOT_MAX);
    contextParts.push(`## Project Context\n${sanitizeContent(compactBoot)}`);
  }

  // 2c. Top opinions (max OPINIONS_TOP_N, confidence ≥ OPINIONS_MIN_CONFIDENCE) — parse structured markdown
  const topOpinions = getTopOpinions(memoryDir, {
    n: OPINIONS_TOP_N,
    minConfidence: OPINIONS_MIN_CONFIDENCE,
    maxBytes: OPINIONS_MAX * 3,
    sanitize: sanitizeContent,
  });
  if (topOpinions) contextParts.push(`## Key Learnings\n${topOpinions}`);

  // ═══════════════════════════════════════════════════════════
  // 2d. KNOWLEDGE INJECTION (learnings, troubleshooting, prefs)
  // ═══════════════════════════════════════════════════════════

  // Priority: knowledge-summary.txt (pre-computed) > capped direct reads
  const knowledgeSummary = readKnowledgeSummary(memoryDir);
  if (knowledgeSummary) {
    contextParts.push(
      `## Knowledge (curated)\n${sanitizeContent(knowledgeSummary)}`,
    );
  } else {
    // Fallback: extract recent entries from memory files (capped, sanitized)
    const knowledgeParts = [];

    // Programming prefs (small file — safe to read fully)
    const prefsPath = join(memoryDir, "11_PROGRAMMING_PREFS.md");
    const prefs = safeRead(prefsPath, 800);
    if (prefs) {
      knowledgeParts.push(`**Prefs**: ${sanitizeForInjection(prefs, 600)}`);
    }

    // Recent learnings — extract last 5 entries (## headers)
    const learningsPath = join(memoryDir, "04_LEARNINGS.md");
    const learnings = safeRead(learningsPath, KNOWLEDGE_MAX);
    if (learnings) {
      const sections = learnings.split(/^## /m).filter(Boolean).slice(-5);
      const compact = sections
        .map((s) => {
          const firstLine = s.split("\n")[0] || "";
          return `• ${firstLine.slice(0, 120)}`;
        })
        .join("\n");
      if (compact) {
        knowledgeParts.push(
          `**Recent Learnings**:\n${sanitizeContent(compact)}`,
        );
      }
    }

    // Recent troubleshooting — extract last 3 entries
    const troublePath = join(memoryDir, "05_TROUBLESHOOTING.md");
    const trouble = safeRead(troublePath, KNOWLEDGE_MAX);
    if (trouble) {
      const sections = trouble.split(/^## /m).filter(Boolean).slice(-3);
      const compact = sections
        .map((s) => {
          const firstLine = s.split("\n")[0] || "";
          return `• ${firstLine.slice(0, 120)}`;
        })
        .join("\n");
      if (compact) {
        knowledgeParts.push(`**Known Issues**:\n${sanitizeContent(compact)}`);
      }
    }

    if (knowledgeParts.length) {
      contextParts.push(
        `## Knowledge (auto-extracted)\n${knowledgeParts.join("\n")}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2e. MAILBOX INSTRUCTION (learning capture from subagents)
  // ═══════════════════════════════════════════════════════════

  const mailboxPath = join(sessionsDir, `learning-mailbox-${agentId}.jsonl`);
  contextParts.push(`## Learning Capture
When you discover something useful (bug fix, decision, insight), write a JSONL line to:
\`.project-brain/memory/sessions/learning-mailbox-${agentId}.jsonl\`
Format: \`{"t":"ISO","type":"learning|fix|decision","text":"..."}\`
This will be processed and persisted by the extension.`);

  // ═══════════════════════════════════════════════════════════
  // 2f. ORPHAN MAILBOX RECOVERY
  // ═══════════════════════════════════════════════════════════

  try {
    if (existsSync(sessionsDir)) {
      const orphans = readdirSync(sessionsDir).filter(
        (f) => f.startsWith("learning-mailbox-") && f.endsWith(".jsonl"),
      );
      if (orphans.length > 3) {
        // Move old orphans to staging for extension-side ingestion
        const stagingFile = join(sessionsDir, "pending-learnings.jsonl");
        for (const orphan of orphans.slice(0, -3)) {
          try {
            const content = safeRead(join(sessionsDir, orphan), KNOWLEDGE_MAX);
            if (content.trim()) {
              appendFileSync(
                stagingFile,
                content.endsWith("\n") ? content : content + "\n",
                "utf8",
              );
            }
            // Cleanup handled by extension — don't delete in hooks
          } catch {
            /* non-critical */
          }
        }
      }
    }
  } catch {
    /* non-critical */
  }

  // ═══════════════════════════════════════════════════════════
  // 3. SKILL ROUTING (if agent_type matches known specializations)
  // ═══════════════════════════════════════════════════════════

  const skillsDir = join(memoryDir, "skills");
  if (existsSync(skillsDir) && agentType !== "unknown") {
    // Map agent types to potentially relevant skills
    const typeKeywords = agentType.toLowerCase().split(/[-_\s]+/);
    try {
      const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      const matchedSkills = skillDirs.filter((skill) => {
        const skillLower = skill.toLowerCase();
        return typeKeywords.some(
          (kw) => kw.length > 3 && skillLower.includes(kw),
        );
      });

      if (matchedSkills.length > 0 && matchedSkills.length <= 3) {
        contextParts.push(
          `## Relevant Skills\nCheck these skills for specialized knowledge: ${matchedSkills.map((s) => "`" + s + "`").join(", ")}`,
        );
      }
    } catch {
      /* non-critical */
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. ACTIVE LOOP INHERITANCE (multi-loop aware)
  // ═══════════════════════════════════════════════════════════
  const allLoops = readAllActiveLoops(cwd);
  if (allLoops.length === 1) {
    const loop = allLoops[0];
    contextParts.push(`## 🔁 ACTIVE LOOP — INHERITED
**Parent loop session**: \`${loop.sessionId}\`
**Goal**: ${(loop.goal || "").substring(0, 200)}
**CRITICAL**: The parent agent is inside an active loop. When you finish your task:
- Return your results as your FINAL message (the parent will route them to \`loopAwaitInput\`).
- Do NOT call \`loopAwaitInput\` yourself — only the parent agent does that.
- Be concise: your output goes into the parent's synthesis.`);
  } else if (allLoops.length > 1) {
    const loopList = allLoops
      .map(
        (l) =>
          `- Session \`${l.sessionId}\` — ${(l.goal || "?").substring(0, 120)}`,
      )
      .join("\n");
    contextParts.push(`## 🔁 ACTIVE LOOPS — MULTIPLE CONCURRENT
${loopList}
**CRITICAL**: Your parent agent is inside ONE of these loops. When you finish:
- Return your results as your FINAL message (the parent will route them to the correct \`loopAwaitInput\`).
- Do NOT call \`loopAwaitInput\` yourself — only the parent agent does that.
- Be concise: your output goes into the parent's synthesis.`);
  }

  // ═══════════════════════════════════════════════════════════
  // 5. CRITICAL RULES (always inject)
  // ═══════════════════════════════════════════════════════════

  contextParts.push(`## Rules for Subagents
- **Memory Checkpoint**: Code → Memory update → Reindex → Commit (NEVER skip)
- **Deploy**: Always use \`npm run deploy\`, NEVER \`Copy-Item\`
- **Files >500 lines**: grep first, NEVER read fully
- **Security**: Use \`execFile()\` not \`exec()\` for CLI calls`);

  // Build final context
  const additionalContext =
    contextParts.length > 0
      ? `# 🧠 Subagent Context (auto-injected)\n\n${contextParts.join("\n\n----\n\n")}`
      : "";

  return {
    continue: true,
    hookSpecificOutput: {
      additionalContext: additionalContext || undefined,
    },
  };
});
