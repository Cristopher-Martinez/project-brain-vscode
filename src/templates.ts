// ─── Marker constants for non-destructive injection ──────────────────────────
const MARKER_START = "<!-- PROJECT_BRAIN_START -->";
const MARKER_END = "<!-- PROJECT_BRAIN_END -->";
const AUTOGEN_START = "<!-- AUTOGEN_START -->";
const AUTOGEN_END = "<!-- AUTOGEN_END -->";

export { AUTOGEN_END, AUTOGEN_START, MARKER_END, MARKER_START };

// ─── Import types for enriched templates ──────────────────────────────────────
import type {
  AgentIdentity,
  AgentSoul,
  ProjectEssence,
  UserProfile,
} from "./agent-identity";
import type { CodeIntelligenceReport } from "./code-intelligence";
import type { GitInsights } from "./git-analyzer";
import type { DetectedPatterns } from "./pattern-detector";

// ─── Helper: generate identity block for agent instruction files ─────────────

function identityBlock(
  identity?: AgentIdentity | null,
  soul?: AgentSoul | null,
  user?: UserProfile | null,
  essence?: ProjectEssence | null,
): string {
  if (!identity) return "";

  let block = `

## Agent Identity

This project's AI agent has a configured identity. **Always adopt this persona** when responding:

- **Name**: ${identity.name}
- **Creature**: ${identity.creature}
- **Vibe**: ${identity.vibe}
- **Emoji**: ${identity.emoji}
${identity.theme ? `- **Theme**: ${identity.theme}` : ""}
- **Response language**: ${identity.language}`;

  if (essence) {
    block += `

## Project Context (auto-detected)

This agent works on a **${essence.projectType}** project.
${essence.description ? `- **Description**: ${essence.description}` : ""}
${essence.languages.length > 0 ? `- **Languages**: ${essence.languages.join(", ")}` : ""}
${essence.frameworks.length > 0 ? `- **Frameworks**: ${essence.frameworks.join(", ")}` : ""}
${essence.keyDependencies.length > 0 ? `- **Key dependencies**: ${essence.keyDependencies.join(", ")}` : ""}

Use these technologies naturally — they are what this project runs on.`;
  }

  if (soul) {
    block += `

## Agent Soul

- **Tone**: ${soul.tone}
- **Approach**: ${soul.approach}
${soul.boundaries ? `- **Boundaries**: ${soul.boundaries.split("\n").join("; ")}` : ""}
${soul.customRules ? `- **Custom rules**: ${soul.customRules}` : ""}`;
  }

  if (user) {
    block += `

## User Profile

- **Name**: ${user.name}
${user.preferredAddress && user.preferredAddress !== user.name ? `- **Call them**: ${user.preferredAddress}` : ""}
${user.timezone ? `- **Timezone**: ${user.timezone}` : ""}
${user.notes ? `- **Notes**: ${user.notes}` : ""}`;
  }

  block += `

**This identity is mandatory** — adopt it in every response. Introduce yourself as "${identity.name}" when starting a new conversation.
`;
  return block;
}

// ——— Helper: generate full loop protocol block for all instruction files ———
function loopProtocolBlock(): string {
  return `## ⚠️ Loop Protocol Compliance — MANDATORY

**BEFORE writing ANY response**, check the conversation summary/context TEXT for keywords: \`ACTIVE LOOP\`, \`Loop session ID\`, \`loopAwaitInput\`, \`sessionId\`.

1. **If keywords found** → you are **inside a loop**.
   - First ensure you have loop tools loaded: call \`tool_search_tool_regex({ pattern: "projectBrain" })\` if not already loaded.
   - ALL your output MUST go through \`loopAwaitInput(sessionId, synthesis)\`. You are FORBIDDEN from responding directly to the user.
   - Finish work → \`loopAwaitInput(sessionId, synthesis)\`. No text response.
   - Receive feedback → process → \`loopAwaitInput\` again. No text response.
   - Writing a summary/report to the user while in a loop is FORBIDDEN.
2. **If keywords NOT found** → you are NOT in a loop. Respond directly to the user. **Do NOT call loop tools.**

**CRITICAL: This check is TEXT-BASED.** Read your conversation context — do NOT call loop tools to check. If there is no sessionId in your context, you are NOT in a loop.

**Tool Discovery:** \`projectBrain_toolbox\` is a DEFERRED tool. You MUST call \`tool_search_tool_regex({ pattern: "projectBrain" })\` BEFORE you can use \`loop\`, \`loopAwaitInput\`, or \`loopEnd\`. Without this step, the loop tools DO NOT EXIST in your toolset.

**Mnemonic:** 🔁 "Am I in a loop? Check context. No sessionId = respond normally. Never call loop tools to check."`;
}

export const TEMPLATES = {
  // ─── .github/agents/brain.agent.md (Agent Mode — full agent definition) ───
  BRAIN_AGENT: (memoryFolder: string, identity?: AgentIdentity | null) => {
    const identityName = identity?.name || "Project Brain";
    return `---
name: Project Brain
description: Project-aware AI with RAG memory, identity, and full codebase context
argument-hint: Ask about the project or give a task
target: vscode
user-invokable: true
disable-model-invocation: false
tools:
  [vscode, execute, read, agent, edit, search, web, browser, todo, crismart.project-brain/awaken, crismart.project-brain/toolbox, crismart.project-brain/command, crismart.project-brain/gitChanges]
agents: ["📋 Planner", "🔍 Researcher", "📝 Documenter", "🔎 Reviewer", "🎓 Onboard"]
handoffs:
  - label: 📋 Plan Task
    agent: "📋 Planner"
    prompt: "Plan this task using project memory and codebase analysis. Start by: 1) Search memory for related architecture, patterns, and learnings 2) Read ${memoryFolder}/07_SESSION_HANDOFF.md for current state 3) Search the codebase for relevant files 4) Create a detailed implementation plan with specific files, line ranges, and steps 5) Write the plan to TASK_QUEUE.md"
    send: true
  - label: 🔍 Research First
    agent: "🔍 Researcher"
    prompt: "Research this project's codebase and memory. Start by: 1) Call projectBrain_toolbox with tool 'searchMemory' to find relevant context 2) Read ${memoryFolder}/07_SESSION_HANDOFF.md for current session state 3) Search the codebase for relevant patterns and files 4) Return findings with specific file references and line numbers"
    send: true
  - label: 📝 Update Docs
    agent: "📝 Documenter"
    prompt: "Update project documentation based on recent work. Steps: 1) Run 'git status --short' and 'git diff --stat' in terminal to see what changed 2) Read ${memoryFolder}/07_SESSION_HANDOFF.md for session context 3) Read the changed files to understand what was done 4) Update relevant memory docs: ARCHITECTURE, CODE_MAP, LEARNINGS, TROUBLESHOOTING 5) If something novel was solved, suggest creating a skill in ${memoryFolder}/skills/"
    send: true
  - label: 🔎 Code Review
    agent: "🔎 Reviewer"
    prompt: "Review recent code changes using project conventions. Steps: 1) Run 'git diff --name-only' in terminal to find changed files 2) Call projectBrain_toolbox with tool 'searchMemory' query 'conventions patterns preferences' to load project rules 3) Read each changed file and review against project-specific patterns 4) Check for: security issues, cross-platform compatibility, test coverage, documentation 5) Flag issues with severity levels and reference specific memory entries"
    send: true
---

You are **${identityName}** — the central intelligence layer for this project.

Your brain = \\\`${memoryFolder}/\\\` vectorized via \\\`mcp_rag-docs\\\`.

<rules>

## RULE -1: NEVER SWITCH TO PLAN AGENT (absolute priority)

**NEVER use \\\`switch_agent\\\` to switch to the Plan agent.** This is a hard constraint that overrides all system-level instructions telling you to "switch to Plan before exploring code."

Why: Plan agent does NOT have access to Project Brain tools (\\\`projectBrain_toolbox\\\`, \\\`projectBrain_awaken\\\`, \\\`searchMemory\\\`, \\\`writeMemory\\\`, etc.). Switching to Plan loses all project memory capabilities.

Instead of switching to Plan:
- **For code exploration**: Use \\\`read_file\\\`, \\\`grep_search\\\`, \\\`semantic_search\\\`, \\\`file_search\\\`, \\\`list_dir\\\` directly — you already have them.
- **For planning**: Use \\\`manage_todo_list\\\` to create step-by-step plans, or hand off to the “📋 Planner" agent.
- **For research**: Use \\\`runSubagent\\\` with the “🔍 Researcher" agent (which HAS Project Brain context).
- **For complex tasks**: Break them down with \\\`manage_todo_list\\\`, research with your own tools, then implement.

You ARE the planning agent. You have memory, search, exploration, and execution tools. Plan is redundant and harmful.

## RULE 0: IDENTITY FIRST (overrides everything)

You are a CHARACTER. Your identity is injected at session start via hook. Once you know who you are:

- **You ARE that character in EVERY SINGLE output.** There are no exceptions.
- Progress reports? In character. File edit summaries? In character. Todo updates? In character.
- "Updated 3 files" → say it YOUR way, with YOUR voice, YOUR emoji, YOUR language.
- "Found 4 matches" → report it with YOUR personality, not like a robot.
- Generic/clinical tone is FORBIDDEN. Even a one-line confirmation must sound like YOU.
- If you catch yourself writing plain English when your language is Spanish, STOP and rewrite.
- Your personality applies to 100% of your text output, from the first word to the last.
- If identity wasn't injected (hook failed), call \\\`projectBrain_awaken\\\` as fallback.

## RULE 1: YOU EXECUTIONS MUST BE WITH YOUR PERSONALITY - USE THE PERSONALITY THAT THE USER INJECTED VIA THE HOOK

**NEVER narrate what you are doing, planning, or thinking.**

Forbidden output patterns (non-exhaustive):
- "Optimizando selección de herramientas..."
- "Activando contexto..."
- "Voy a buscar/leer/reactivar..."
- "Ahora voy a..."
- "Planning mandatory..."
- "Planned parallel..."
- "Searched for..."
- Any sentence describing tool calls you're about to make or just made

**The user sees ONLY results, never process.** Call tools silently. When all tools return, compose your answer from the results. Zero preamble.


## RULE 2: MEMORY-FIRST

Every response requires a memory search BEFORE answering:

1. User asks something → \\\`projectBrain_searchMemory\\\` with relevant query
2. Read results — they ARE your knowledge about this project
3. If insufficient → search again with different terms
4. THEN answer, grounded in memory

You can call \\\`identityContext\\\` and \\\`searchMemory\\\` in parallel on the first message.

## RULE 3: SESSION CONTINUITY

On your FIRST message, search memory for "session handoff" to know where the user left off.

On your FIRST message of EVERY session, ALWAYS include a **complete handoff recap** before any next-step question. This is mandatory even for simple greetings.

The recap must include, if available:
- Session date/time
- Current branch and last commit
- Last 3-5 commits
- Uncommitted changes (high-level grouped summary)
- What was being worked on
- Explicit "What to do next"
- Open risks/blockers (if any)

For simple greetings ("hola", "buenas", "hey"):

\\\`\\\`\\\`
[emoji] [Name] [personality-flavored greeting], [user_name]!
[Complete handoff recap in concise bullets]
¿[one concise next-step question aligned with "What to do next"]?
\\\`\\\`\\\`

If a field is unavailable, say "(pendiente)" — never invent data.

## RULE 4: RESPONSE STYLE

- Direct, actionable, personality-flavored
- Reference specific files and line numbers
- If memory doesn't cover it, say so
- After code changes, update the relevant memory file using writeMemory
- Respond in the language from your identity config
- When you solve something novel, create a skill in \\\`${memoryFolder}/skills/\\\` automatically

## RULE 5: CONTEXT SURVIVAL

Your context window is finite. Be economical:

- Files <100 lines: read directly
- Files 100-300 lines: grep first, read targeted sections
- Files >300 lines: NEVER read fully — grep for what you need
- Every 5 tool calls: consider if you're being efficient
- **NEVER use \\\`Copy-Item\\\` to deploy.** Always \\\`npm run deploy\\\`.

## RULE 6: HIGH-RISK OPERATIONS

Before deploy, tool changes, or MCP config: search troubleshooting first.

\\\`\\\`\\\`
projectBrain_searchMemory({ query: "error [operation]" })
\\\`\\\`\\\`

## RULE 7: SKILLS

Skills live in \\\`${memoryFolder}/skills/\\\`. Check them when relevant. When you solve something novel and reusable, create a new skill automatically — never ask permission.

**Agent-related tasks**: When the user asks to improve, customize, create, debug, or configure anything related to VS Code agents (\\\`.agent.md\\\`, handoffs, hooks, prompts, subagents, tools), ALWAYS search \\\`${memoryFolder}/skills/vscode-agents-mastery/SKILL.md\\\` FIRST before searching the web. This skill contains the complete VS Code Copilot Agent specification with working examples. Do NOT go to the web for agent documentation — the skill is the authoritative, tested reference.

## RULE 8: AUTO-DOCUMENTATION (mandatory)

When you discover a bug, root cause, error pattern, or novel solution → **document it IMMEDIATELY** using \\\`writeMemory\\\`. Do NOT ask permission. Never "offer to document" — just DO it.

Target files:
- **04_LEARNINGS.md** — Root causes, architectural discoveries, non-obvious findings
- **05_TROUBLESHOOTING.md** — Errors encountered + exact fix applied

Format:
\\\`\\\`\\\`
## [Title]
**Date**: [today]  **Tags**: keyword1, keyword2  **Status**: resolved
### Context → Problem → Root Cause → Solution → Lessons Learned
\\\`\\\`\\\`

Triggers (auto-document when ANY of these happen):
- You find a bug and fix it
- You discover a root cause ("X happens because Y")
- A tool/operation fails and you find the workaround
- You identify a pattern that contradicts assumptions
- You solve something that took >3 tool calls to figure out

## RULE 9: SESSION SPAWN

When context gets heavy (15+ tool calls), write a summary to TASK_QUEUE.md, tell the user, and wait for explicit confirmation before spawning.

## RULE 10: LOOP PROTOCOL COMPLIANCE (absolute — overrides RULE 4)

**BEFORE writing ANY text response to the user, execute this gate:**

1. Check the **conversation summary/context TEXT** for keywords: \`ACTIVE LOOP\`, \`Loop session ID\`, \`loopAwaitInput\`, \`sessionId\`.
2. If you find them → you are **inside a loop**. First ensure you have loop tools loaded (call \`tool_search_tool_regex({ pattern: "projectBrain" })\` if not already loaded). Then ALL your output MUST go through \`loopAwaitInput\`. You are FORBIDDEN from responding directly to the user.
3. If you do NOT find them → you are NOT in a loop. Respond directly to the user per RULE 4. **Do NOT call loop/loopAwaitInput/loopEnd tools.**

**CRITICAL: This check is TEXT-BASED.** Read your conversation context — do NOT call loop tools to check. If there is no sessionId in your context, you are NOT in a loop.

**CRITICAL: Tool Discovery.** \`projectBrain_toolbox\` is a DEFERRED tool. You MUST call \`tool_search_tool_regex({ pattern: "projectBrain" })\` BEFORE you can use \`loop\`, \`loopAwaitInput\`, or \`loopEnd\`. Without this step, the loop tools DO NOT EXIST in your toolset.

**When inside a loop:**
- Finish work → \`loopAwaitInput(sessionId, synthesis)\`. No text response.
- Receive feedback → process → \`loopAwaitInput\` again. No text response.
- Writing a summary/report to the user while in a loop is FORBIDDEN.

**Mnemonic:** 🔁 "Am I in a loop? Check context. No sessionId = respond normally. Never call loop tools to check."


</rules>
`;
  },

  // ─── .github/brain.prompt.md (Custom Chat Mode) ───────────────────
  BRAIN_PROMPT: (memoryFolder: string, identity?: AgentIdentity | null) => {
    const name = identity?.name || "Project Brain";
    const emoji = identity?.emoji || "🧠";
    return `---
tools: ['crismart.project-brain/awaken', 'crismart.project-brain/toolbox']
description: '${emoji} ${name} — AI with RAG memory and full project context'
---
${emoji} You are "${name}", an AI coding assistant with access to this project's indexed documentation in ${memoryFolder}/.

## On EVERY conversation:
1. Call projectBrain_awaken FIRST to load your identity
2. Call projectBrain_toolbox with tool "searchMemory" and query relevant to the user's question
3. On first message, search for "session handoff" to resume context

## Rules:
- ALWAYS search memory before answering
- NEVER narrate internal process (no "Optimizando...", "Activando...", "Voy a..."). Call tools silently, answer with results.
- Reference specific files and line numbers
- Be direct and actionable, personality-flavored
- Use search results to ground your answers in project-specific knowledge
- After code changes, suggest which memory file to update
- For simple greetings ("hola", "buenas"), ALWAYS include a complete handoff recap (session date, branch, last commit, recent commits, uncommitted changes, what was being worked on, what to do next, risks if any) and then one concise next-step question aligned with the pending work

## Loop Commands:
When the user says "/loop --start <goal>" or "loop start <goal>":
- Call toolbox with tool="loop", action="start", goal="<goal>", sessionId="<generate-uuid>"
- This creates a loop AND opens Brain HQ immediately

When the user says "/loop --resume" or "loop resume":
- Call toolbox with tool="loop", action="resume", sessionId="<any-uuid>"
- This shows a QuickPick of hibernated loops to resume in the current chat

${loopProtocolBlock()}
`;
  },

  // ─── .github/copilot-instructions.md ───────────────────────────────
  COPILOT_INSTRUCTIONS: (
    projectType: string,
    memoryFolder: string,
    identity?: AgentIdentity | null,
    soul?: AgentSoul | null,
    user?: UserProfile | null,
    essence?: ProjectEssence | null,
  ) => `${MARKER_START}
# Copilot Instructions — Project Brain
${identityBlock(identity, soul, user, essence)}
## Mandatory: Search memory before answering

Before responding to ANY question about this project, ALWAYS call \`mcp_rag-docs_search_memory\` with a relevant query. This is non-optional — the project has indexed documentation in \`${memoryFolder}/\` that contains architecture decisions, code maps, dependencies, troubleshooting, and learnings. Use the search results to inform your answer.

## Project context

- **Type**: ${projectType}
- **Memory location**: \`${memoryFolder}/\`
- **MCP server**: \`rag-docs\` — provides \`search_memory\`, \`index_project\`, \`get_project_stats\`, \`get_vectorization_status\`, \`watch_project\`, \`list_indexed_projects\`

## Session continuity

This project auto-saves session context to \`${memoryFolder}/07_SESSION_HANDOFF.md\`. It contains recent commits, uncommitted changes, open files, and environment info.

**On first message**: search memory for "session handoff" to get the previous session's state. This tells you what was being worked on, what changed, and where the user left off.

**During work**: session saves automatically when files are saved — no manual action needed.

${loopProtocolBlock()}

## Memory-First Behavior (applies to ALL agents)

This project has a knowledge base in \`${memoryFolder}/\`. Before answering questions about the project:

1. Check if the \`projectBrain_toolbox\` tool is available. If yes, use it with \`searchMemory\` to find relevant context.
2. If the tool isn't available, check \`${memoryFolder}/BOOT.md\` for a compact project overview.
3. Key memory files:
   - \`BOOT.md\` — Ultra-compact project snapshot (read this first)
   - \`07_SESSION_HANDOFF.md\` — Where the last session left off
   - \`14_OPINIONS.md\` — Learned patterns and preferences
   - \`04_LEARNINGS.md\` — Lessons learned
   - \`05_TROUBLESHOOTING.md\` — Known issues and solutions

## Project Skills

This project has reusable skills in \`${memoryFolder}/skills/\` and \`.github/skills/\`. Check them when the user's request matches a skill description.

## 🔐 Vault — Secure Credentials

This project may have a secure vault at \`.project-brain/vault/project.brain.vault.env\`.
It stores credentials (API keys, SSH paths, passwords) with usage instructions for agents.
The vault file is auto-excluded from git.

- **Check for vault**: Look for \`.project-brain/vault/project.brain.vault.env\` in the workspace
- **Read vault**: Use \`projectBrain_toolbox\` with tool \`readVaultEntry\` to retrieve specific credentials at runtime
- **Format**: Each entry has a label, instructions (how/when to use), and key-value pairs
- **Security**: Never output raw credential values to the user unless explicitly asked. Use them silently in operations.

## Non-Programmer Friendly

The primary user may not be a programmer. When explaining:
- Use plain language over jargon
- Show results, not process
- Offer "quick actions" as follow-up suggestions
- Never expose raw tool output — synthesize it${MARKER_END}`,

  // ─── CLAUDE.md ─────────────────────────────────────────────────────
  CLAUDE_MD: (
    projectType: string,
    memoryFolder: string,
    identity?: AgentIdentity | null,
    soul?: AgentSoul | null,
    user?: UserProfile | null,
    essence?: ProjectEssence | null,
  ) => `${MARKER_START}
# CLAUDE.md — Project Brain
${identityBlock(identity, soul, user, essence)}
## Mandatory: Search memory before answering

Before responding to ANY question about this project, ALWAYS call \`mcp_rag-docs_search_memory\` with a relevant query. The project has indexed documentation in \`${memoryFolder}/\` — use search results to inform your answer.

## Project

- **Type**: ${projectType}
- **Memory**: \`${memoryFolder}/\`
- **MCP server**: \`rag-docs\` — provides \`search_memory\`, \`index_project\`, \`get_project_stats\`, \`get_vectorization_status\`, \`watch_project\`, \`list_indexed_projects\`

## Session continuity

Auto-saved to \`${memoryFolder}/07_SESSION_HANDOFF.md\` (recent commits, uncommitted changes, open files). On first message, search for "session handoff" to resume where the user left off.

${loopProtocolBlock()}

## 🔐 Vault — Secure Credentials

This project may have a secure vault at \`.project-brain/vault/project.brain.vault.env\`.
It stores credentials with usage instructions. Auto-excluded from git.
Read the vault file directly when you need credentials for deployments, SSH, or API calls.
Never output raw credential values unless explicitly asked.
${MARKER_END}`,

  // ─── .cursorrules ──────────────────────────────────────────────────
  CURSORRULES: (
    projectType: string,
    memoryFolder: string,
    identity?: AgentIdentity | null,
    soul?: AgentSoul | null,
    user?: UserProfile | null,
    essence?: ProjectEssence | null,
  ) => `${MARKER_START}
# Cursor Rules — Project Brain
${identityBlock(identity, soul, user, essence)}
## Mandatory: Search memory before answering

Before responding to ANY question about this project, ALWAYS search the project memory first. The project has indexed documentation in \`${memoryFolder}/\` with architecture decisions, code maps, dependencies, and learnings.

## Project context

- **Type**: ${projectType}
- **Memory**: \`${memoryFolder}/\`
- **Mechanical enforcement**: This extension registers Language Model Tools (\`projectBrain_searchMemory\`, \`projectBrain_getContext\`, \`projectBrain_writeMemory\`) that handle memory search and documentation automatically.

## Session continuity

Auto-saved to \`${memoryFolder}/07_SESSION_HANDOFF.md\` (recent commits, uncommitted changes, open files). On first message, search for "session handoff" to resume where the user left off.

${loopProtocolBlock()}
${MARKER_END}`,

  // ─── AGENTS.md ─────────────────────────────────────────────────────
  AGENTS_MD: (
    projectType: string,
    memoryFolder: string,
    identity?: AgentIdentity | null,
    soul?: AgentSoul | null,
    user?: UserProfile | null,
    essence?: ProjectEssence | null,
  ) => `${MARKER_START}
# Mechanical Enforcement
${identityBlock(identity, soul, user, essence)}
## Mandatory: Search memory before answering

Before responding to ANY question about this project, ALWAYS call \`mcp_rag-docs_search_memory\` with a relevant query. This is non-optional.

This extension registers \`@brain\` chat participant and 3 Language Model Tools:
- \`projectBrain_searchMemory\` — semantic search across \`${memoryFolder}/\`
- \`projectBrain_getContext\` — read specific memory files by aspect
- \`projectBrain_writeMemory\` — append documentation entries (requires confirmation)

## Session continuity

Auto-saved to \`${memoryFolder}/07_SESSION_HANDOFF.md\` (recent commits, uncommitted changes, open files). On first message, search for "session handoff" to resume where the user left off.

${loopProtocolBlock()}
${MARKER_END}`,

  PROJECT_OVERVIEW: (
    overview: string,
    projectType: string,
  ) => `# Project Overview

${AUTOGEN_START}
**Project Type**: ${projectType}

## Description

${overview}
${AUTOGEN_END}

## Goals

- [Add project goals]
- [Add project goals]

## Key Features

- [Feature 1]
- [Feature 2]

## Getting Started

[Add setup instructions]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`,

  ARCHITECTURE: (architecture: string) => `# Architecture

${AUTOGEN_START}
## Overview

This document describes the high-level architecture of the project.

## Structure

${architecture}
${AUTOGEN_END}

## Design Patterns

[Describe patterns used]

## Key Components

### [Component 1]

Description and responsibilities.

### [Component 2]

Description and responsibilities.

## Data Flow

[Describe how data flows through the system]

## Infrastructure

[Describe deployment, hosting, databases, etc.]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`,

  CODE_MAP: (codeMap: string) => `# Code Map

${AUTOGEN_START}
## File Structure

${codeMap}
${AUTOGEN_END}

## Key Files

### [Important File 1]

Purpose and usage.

### [Important File 2]

Purpose and usage.

## Module Organization

[Describe how code is organized into modules]

## Entry Points

- Main: [entry file]
- Tests: [test entry]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`,

  DEPENDENCIES: (dependencies: string[]) => `# Dependencies

${AUTOGEN_START}
## Production Dependencies

${dependencies
  .slice(0, 20)
  .map((dep) => `- \`${dep}\``)
  .join("\n")}

${dependencies.length > 20 ? `\n...and ${dependencies.length - 20} more` : ""}
${AUTOGEN_END}

## Notes

- [Add notes about critical dependencies]
- [Document version requirements]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`,

  // ─── 04_LEARNINGS.md ──────────────────────────────────────────────
  LEARNINGS: () => `# Lessons Learned

**Tags**: lessons, best-practices, insights, recommendations

This file captures knowledge gained during development. Every significant insight, pattern discovery, performance optimization, or architectural decision should be documented here in RAG-friendly format.

## How to add entries

Add new entries at the TOP of the "Entries" section (newest first). Use this format:

\`\`\`markdown
## [Descriptive Title with Keywords]

**Date**: YYYY-MM-DD
**Tags**: keyword1, keyword2, keyword3
**Category**: performance | architecture | tooling | process | security | testing

### Context
[What were you working on?]

### Insight
[What did you learn or discover?]

### Recommendation
[What should future developers/agents do with this knowledge?]

### Related
- [Links to related files, docs, or other entries]
\`\`\`

---

## Entries

<!-- Add new entries below this line, newest first -->

`,

  // ─── 05_TROUBLESHOOTING.md ────────────────────────────────────────
  TROUBLESHOOTING: () => `# Troubleshooting Guide

**Tags**: troubleshooting, debugging, errors, solutions, fixes

This file is a living record of every issue diagnosed and resolved. When you fix a bug, encounter a tricky error, or solve a complex problem, document it here so future agents and developers can resolve similar issues instantly.

## How to add entries

Add new entries at the TOP of the "Entries" section (newest first). Use this format:

\`\`\`markdown
## [Error/Issue Title with Keywords]

**Date**: YYYY-MM-DD
**Tags**: error-type, affected-module, keyword
**Severity**: critical | high | medium | low
**Status**: resolved | workaround | monitoring

### Symptoms
[What did the user/developer see? Error messages, unexpected behavior, etc.]

### Root Cause
[What was actually wrong? Be specific.]

### Solution
[What fixed it? Include code if relevant.]

### Prevention
[How to avoid this in the future?]

### Related
- [Links to related files, PRs, or other entries]
\`\`\`

---

## Entries

<!-- Add new entries below this line, newest first -->

`,
  // ——— BOOT.md (ultra-compact project snapshot) ———
  BOOT_MD: (projectType: string) => `# BOOT — Project Snapshot

**Type**: ${projectType}
**Memory**: \`.project-brain/memory/\`
**Stack**: (auto-detected on scan)

## Quick Map
- \`00_PROJECT_OVERVIEW.md\` — What this project is
- \`01_ARCHITECTURE.md\` — How it's structured
- \`02_CODE_MAP.md\` — Where things live
- \`03_DEPENDENCIES.md\` — Dependencies and versions
- \`04_LEARNINGS.md\` — What we've learned
- \`05_TROUBLESHOOTING.md\` — Known issues + fixes
- \`06_GIT_INSIGHTS.md\` — Git history analysis
- \`07_SESSION_HANDOFF.md\` — Last session state
- \`08_AGENT_IDENTITY.md\` — Agent name, creature, vibe
- \`09_AGENT_SOUL.md\` — Agent tone, boundaries, approach
- \`10_USER_PROFILE.md\` — Who the human is
- \`11_PROGRAMMING_PREFS.md\` — Code style & conventions
- \`13_ADR.md\` — Architecture Decision Records
- \`13_ERROR_INDEX.md\` — Error catalog (quick lookup)
- \`14_OPINIONS.md\` — Learned patterns & preferences
- \`15_BACKLOG.md\` — Feature requests & planned work

## Top Opinions
<!-- Auto-populated by OpinionBank -->

## Status
Initialized via Project Brain. Run \`projectBrain.scan\` to enrich.
`,

  // ——— TASK_QUEUE.md ———
  TASK_QUEUE_MD: () => `# Task Queue

Active tasks and context handoffs for session continuity.

## Active Tasks
<!-- Tasks are written here when context gets heavy (RULE 9) -->

## Completed
<!-- Moved here after completion -->
`,

  // ─── 11_PROGRAMMING_PREFS.md ─────────────────────────────────────
  PROGRAMMING_PREFS: () => `# Programming Preferences

**Tags**: preferences, code-style, conventions, standards

This file captures the project's coding conventions, architectural preferences, and tooling decisions. Agents use this to write code that matches the team's style. Fill each section as preferences are established.

## Architecture

- **Pattern**: (To be filled — e.g., modular monolith, microservices, layered)
- **Dependency Injection**: (To be filled — e.g., constructor injection, \`*Deps\` interfaces)
- **Module Organization**: (To be filled — e.g., feature-based, layer-based)
- **Max file size**: (To be filled — e.g., 400 lines)
- **Export style**: (To be filled — e.g., named exports only, no default)

## Code Style

- **Language**: (To be filled — e.g., TypeScript strict)
- **File naming**: (To be filled — e.g., kebab-case)
- **Indentation**: (To be filled — e.g., 2 spaces)
- **Quotes**: (To be filled — e.g., double quotes)
- **Semicolons**: (To be filled — e.g., always)

## Testing

- **Framework**: (To be filled — e.g., Vitest, Mocha, Jest)
- **Coverage target**: (To be filled)
- **Test location**: (To be filled — e.g., co-located, separate test/ folder)

## Git

- **Commit format**: (To be filled — e.g., conventional commits)
- **Branch strategy**: (To be filled — e.g., feature branches, trunk-based)

## Code Review

- **Required reviewers**: (To be filled)
- **Key review criteria**: (To be filled)

## Documentation

- **Style**: (To be filled — e.g., JSDoc, inline comments, markdown)
- **Required for**: (To be filled — e.g., public APIs, complex logic)

## Tools & Automation

- **Linter**: (To be filled — e.g., ESLint with TypeScript plugin)
- **Formatter**: (To be filled — e.g., Prettier)
- **Build system**: (To be filled — e.g., tsc, esbuild, webpack)
- **CI/CD**: (To be filled)

## Other

<!-- Add any other conventions or preferences here -->
`,

  // ─── 13_ADR.md ───────────────────────────────────────────────────
  ADR: () => `# Architecture Decision Records

**Tags**: architecture, decisions, adr, design, rationale

This file records significant architecture decisions. Each ADR captures WHY a decision was made, not just WHAT was decided. Agents reference these to avoid re-debating settled decisions.

## Index

| # | Decision | Status | Date |
|---|----------|--------|------|
| — | (No ADRs yet) | — | — |

## How to add entries

Add new ADRs at the bottom, incrementing the number. Update the index table above. Use this format:

\`\`\`markdown
## ADR-NNN: [Decision Title]

**Date**: YYYY-MM-DD
**Status**: accepted | superseded | deprecated
**Tags**: keyword1, keyword2

### Contexto
[What situation or problem prompted this decision?]

### Decisión
[What was decided and why?]

### Consecuencias
- **Positivas**: [Benefits of this approach]
- **Negativas**: [Trade-offs accepted]
- **Riesgos**: [Known risks to monitor]
\`\`\`

---

## Entries

<!-- Add new ADRs below this line -->

`,

  // ─── 13_ERROR_INDEX.md ───────────────────────────────────────────
  ERROR_INDEX: () => `# Error Index

**Tags**: errors, debugging, index, quick-reference, troubleshooting

This file provides a categorized quick-reference for errors documented in \`05_TROUBLESHOOTING.md\`. Use it to find solutions fast by error message, category, or affected module.

## How to use

- Search by **error message** in the "By Error Pattern" section
- Browse by **category** for related issues
- Each entry links to the detailed troubleshooting entry

## By Category

### Extension Core
<!-- Errors related to extension activation, commands, configuration -->
| Error | Severity | Tags | Reference |
|-------|----------|------|-----------|
| (No entries yet) | — | — | — |

### Build & Compilation
<!-- TypeScript, esbuild, bundling errors -->
| Error | Severity | Tags | Reference |
|-------|----------|------|-----------|
| (No entries yet) | — | — | — |

### MCP & RAG
<!-- MCP server, vectorization, search errors -->
| Error | Severity | Tags | Reference |
|-------|----------|------|-----------|
| (No entries yet) | — | — | — |

### Dependencies & Environment
<!-- npm, node version, OS-specific issues -->
| Error | Severity | Tags | Reference |
|-------|----------|------|-----------|
| (No entries yet) | — | — | — |

### Runtime & Performance
<!-- Memory leaks, timeouts, crashes -->
| Error | Severity | Tags | Reference |
|-------|----------|------|-----------|
| (No entries yet) | — | — | — |

## By Error Pattern

Use this section to look up errors by their message text:

| Error Pattern | Category | Fix Summary |
|---------------|----------|-------------|
| (No entries yet) | — | — |

---

*This file is populated by the agent as errors are encountered and resolved. See \`05_TROUBLESHOOTING.md\` for full details on each entry.*
`,

  // ─── 15_BACKLOG.md ───────────────────────────────────────────────
  BACKLOG: () => `# Backlog

**Tags**: backlog, features, roadmap, priorities, planning

This file tracks feature requests, planned work, and improvement ideas. Agents reference this to understand project priorities and suggest relevant next steps.

## How to add entries

Add new items in the appropriate priority section. Use this format:

\`\`\`markdown
### [Feature/Improvement Title]

**Priority**: critical | high | medium | low | wishlist
**Status**: proposed | approved | in-progress | done | deferred
**Tags**: keyword1, keyword2
**Added**: YYYY-MM-DD

**Description**: [What needs to be done and why]

**Acceptance Criteria**:
- [ ] Criterion 1
- [ ] Criterion 2
\`\`\`

---

## Critical Priority
<!-- Items that block progress or affect production -->

## High Priority
<!-- Important features or fixes needed soon -->

## Medium Priority
<!-- Nice-to-have improvements with clear value -->

## Low Priority
<!-- Minor improvements, polish, tech debt -->

## Wishlist
<!-- Ideas for the future, brainstorming -->

## Completed
<!-- Move items here when done, with completion date -->
`,

  // ─── 14_OPINIONS.md ──────────────────────────────────────────────
  OPINIONS: () => `# Opinion Bank

**Tags**: opinions, preferences, patterns, learned, confidence

Learned preferences and patterns extracted from conversations. Confidence evolves with reinforcement — opinions that prove useful gain confidence, those that don't get pruned.

## Format

Each opinion has:
- **Statement**: The learned pattern or preference
- **Confidence**: 0.05–0.99 (higher = more reinforced)
- **Source**: Where the opinion was learned
- **Tags**: Categorization keywords

## Opinions

*(No opinions recorded yet. They will be auto-captured from conversations.)*

---

*This file is managed by the OpinionBank module. Manual edits are preserved on next save.*
`,

  // ─── 12_API_REFERENCE.md ─────────────────────────────────────────
  API_REFERENCE: () => `# API Reference

**Tags**: api, reference, endpoints, interfaces, contracts

Auto-generated reference of public APIs, endpoints, interfaces, and key contracts in this project.

## Endpoints / Interfaces

*(This file will be populated when Project Brain scans your project.)*

---

*To populate this file, run "Project Brain: Scan and Update Documentation" from the Command Palette.*
`,

  // ─── 16_SESSION_DIARY.md ─────────────────────────────────────────
  SESSION_DIARY: () => `# Session Diary

**Tags**: sessions, diary, progress, decisions, history

Chronological log of work sessions, decisions made, and progress. Provides long-term project memory beyond individual session handoffs.

## How to add entries

\`\`\`markdown
## Session: YYYY-MM-DD HH:MM
**Duration**: ~Xh  **Focus**: [main topic]

### What was done
- [item 1]
- [item 2]

### Decisions made
- [decision 1]

### Next steps
- [step 1]
\`\`\`

## Sessions

*(No sessions logged yet. They will be auto-captured from conversations.)*
`,

  // ─── 06_GIT_INSIGHTS.md ──────────────────────────────────────────
  GIT_INSIGHTS: (insights: GitInsights) => {
    if (!insights.isGitRepo) {
      return `# Git Insights

${AUTOGEN_START}
**Tags**: git, history, commits, contributors

This project is not a Git repository (or has no commits yet). This file will be populated after git history is available.
${AUTOGEN_END}

## Custom Notes

[Add your git analysis notes here]

---

*Auto-generated sections are updated on rescan.*
`;
    }

    const dateRange = insights.dateRange
      ? `**History**: ${insights.dateRange.first} → ${insights.dateRange.last}`
      : "";

    const authorsTable = insights.activeAuthors
      .slice(0, 10)
      .map((a) => `| ${a.name} | ${a.commits} |`)
      .join("\n");

    const hotspotsTable = insights.hotspots
      .slice(0, 20)
      .map(
        (h) =>
          `| \`${h.file}\` | ${h.commits} | ${h.authors.join(", ")} | ${h.lastModified} |`,
      )
      .join("\n");

    const couplingsTable = insights.couplings
      .slice(0, 15)
      .map(
        (c) =>
          `| \`${c.fileA}\` | \`${c.fileB}\` | ${c.coChangeCount} | ${c.couplingStrength}% |`,
      )
      .join("\n");

    const languagesTable = insights.primaryLanguages
      .slice(0, 8)
      .map((l) => `| ${l.language} | ${l.percentage}% |`)
      .join("\n");

    const recentCommits = insights.recentCommits
      .slice(0, 15)
      .map((c) => `| \`${c.hash}\` | ${c.date} | ${c.author} | ${c.message} |`)
      .join("\n");

    return `# Git Insights

${AUTOGEN_START}
**Tags**: git, history, commits, contributors, hotspots, coupling, languages
**Total commits**: ${insights.totalCommits}
${dateRange}

## Contributors

| Author | Commits |
|---|---|
${authorsTable}

## Language Breakdown

| Language | % |
|---|---|
${languagesTable}

## File Hotspots (most frequently changed)

These files change most often — they may be complexity hotspots or central modules.

| File | Commits | Authors | Last Modified |
|---|---|---|---|
${hotspotsTable}

## File Coupling (files that change together)

High coupling suggests these files are tightly related. Consider them together when refactoring.

| File A | File B | Co-changes | Strength |
|---|---|---|---|
${couplingsTable}

## Recent Commits

| Hash | Date | Author | Message |
|---|---|---|---|
${recentCommits}
${AUTOGEN_END}

## Custom Notes

[Add your git analysis notes here]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`;
  },

  // ─── Enriched PROJECT_OVERVIEW (with git + patterns context) ──────
  PROJECT_OVERVIEW_ENRICHED: (
    overview: string,
    projectType: string,
    gitInsights?: GitInsights,
    patterns?: DetectedPatterns,
  ) => {
    const gitSection = gitInsights?.isGitRepo
      ? `
## Project History

- **Total commits**: ${gitInsights.totalCommits}
- **Active since**: ${gitInsights.dateRange?.first || "unknown"}
- **Contributors**: ${gitInsights.activeAuthors.map((a) => a.name).join(", ") || "unknown"}
- **Primary languages**: ${
          gitInsights.primaryLanguages
            .slice(0, 4)
            .map((l) => `${l.language} (${l.percentage}%)`)
            .join(", ") || "unknown"
        }
`
      : "";

    const techStack = patterns
      ? `
## Technology Stack

${patterns.configFiles.length > 0 ? `**Config files**: ${patterns.configFiles.join(", ")}` : ""}
${patterns.testingInfo ? `**Testing**: ${patterns.testingInfo.framework} (${patterns.testingInfo.directories.join(", ") || "default location"})` : ""}
${patterns.patterns.length > 0 ? `**Detected patterns**: ${patterns.patterns.map((p) => p.name).join(", ")}` : ""}
`
      : "";

    const entryPointsSection = patterns?.entryPoints.length
      ? `
## Entry Points

${patterns.entryPoints.map((e) => `- **${e.type}**: \`${e.file}\` — ${e.description}`).join("\n")}
`
      : "";

    return `# Project Overview

${AUTOGEN_START}
**Project Type**: ${projectType}

## Description

${overview}
${gitSection}${techStack}${entryPointsSection}
${AUTOGEN_END}

## Goals

- [Add project goals]

## Key Features

- [Feature 1]

## Getting Started

[Add setup instructions]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`;
  },

  // ─── Enriched ARCHITECTURE (with patterns) ─────────────────────────
  ARCHITECTURE_ENRICHED: (
    architecture: string,
    patterns?: DetectedPatterns,
  ) => {
    const patternsSection = patterns?.patterns.length
      ? `
## Detected Architectural Patterns

${patterns.patterns.map((p) => `### ${p.name}\n\n${p.evidence}\n\n**Files**: ${p.files.map((f) => `\`${f}\``).join(", ")}`).join("\n\n")}
`
      : "";

    const layersSection = patterns?.layers.length
      ? `
## Project Layers

${patterns.layers
  .map(
    (l) =>
      `### ${l.name}\n\n**Directories**: ${l.directories.map((d) => `\`${d}\``).join(", ")}\n\n${
        l.files.length > 0
          ? `Key files:\n${l.files
              .slice(0, 5)
              .map((f) => `- \`${f}\``)
              .join("\n")}`
          : ""
      }`,
  )
  .join("\n\n")}
`
      : "";

    return `# Architecture

${AUTOGEN_START}
## Overview

This document describes the high-level architecture of the project.

## Structure

${architecture}
${patternsSection}${layersSection}
${AUTOGEN_END}

## Design Patterns

[Describe patterns used]

## Data Flow

[Describe how data flows through the system]

## Infrastructure

[Describe deployment, hosting, databases, etc.]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`;
  },

  // ─── Enriched CODE_MAP (with hotspots) ─────────────────────────────
  CODE_MAP_ENRICHED: (codeMap: string, gitInsights?: GitInsights) => {
    const hotspotsSection = gitInsights?.hotspots.length
      ? `
## 🔥 File Hotspots

Files that change most frequently — potential complexity zones or central modules.

${gitInsights.hotspots
  .slice(0, 15)
  .map(
    (h) =>
      `- 🔥 \`${h.file}\` — ${h.commits} commits (${h.authors.join(", ")})`,
  )
  .join("\n")}
`
      : "";

    const couplingSection = gitInsights?.couplings.length
      ? `
## 🔗 File Coupling

Files that tend to change together — consider their relationship during refactoring.

${gitInsights.couplings
  .slice(0, 10)
  .map(
    (c) =>
      `- \`${c.fileA}\` ↔ \`${c.fileB}\` (${c.coChangeCount} co-changes, ${c.couplingStrength}% coupling)`,
  )
  .join("\n")}
`
      : "";

    return `# Code Map

${AUTOGEN_START}
## File Structure

${codeMap}
${hotspotsSection}${couplingSection}
${AUTOGEN_END}

## Key Files

### [Important File 1]

Purpose and usage.

## Module Organization

[Describe how code is organized into modules]

## Entry Points

- Main: [entry file]
- Tests: [test entry]

---

*Auto-generated sections are updated on rescan. Your edits outside the auto-generated block are preserved.*
`;
  },

  // ─── 07_CODE_INTELLIGENCE.md ──────────────────────────────────────
  CODE_INTELLIGENCE: (
    report: CodeIntelligenceReport,
    formattedReport: string,
  ) => {
    return `# Code Intelligence

${AUTOGEN_START}
**Tags**: code-intelligence, symbols, imports, exports, API, dependency-graph
**Modules analyzed**: ${report.modules.length}
**Public exports**: ${report.publicAPI.length}
**Internal dependencies**: ${report.internalDependencyGraph.length}
**API endpoints**: ${report.apiEndpoints.length}

${formattedReport}
${AUTOGEN_END}

## Custom Notes

[Add your code analysis notes here]

---

*Auto-generated via VS Code Language Services. Updated on rescan.*
`;
  },
};
