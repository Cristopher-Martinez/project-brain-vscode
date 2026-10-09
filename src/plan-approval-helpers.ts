// ============================================================
// plan-approval-helpers.ts
// Planning mode helper functions extracted from plan-approval.ts
// ============================================================

import * as vscode from "vscode";
import type { TaskPlan } from "./plan-approval";

// ─── Planning Mode Helpers ──────────────────────────────────────────────────

/**
 * Read-only tool filter for planning mode.
 * Workers can read files, search, and analyze — but NOT write, modify, or execute.
 */
export function planOnlyToolFilter(
  tool: vscode.LanguageModelToolInformation,
): boolean {
  const name = tool.name;
  const nameLower = name.toLowerCase();

  // Block ALL write/modify operations
  const writePatterns = [
    "create_file",
    "edit_file",
    "replace_string",
    "write",
    "delete",
    "rename",
    "move",
    "mkdir",
    "commit",
    "push",
    "merge",
    "checkout",
    "stash",
    "run_in_terminal",
    "run_command",
    "execute",
    "install",
  ];

  if (writePatterns.some((p) => nameLower.includes(p))) {
    console.log(`[PlanFilter] BLOCKED (write pattern): ${name}`);
    return false;
  }

  // Allow Project Brain read tools
  if (name.startsWith("projectBrain_")) {
    // Block brain tools that write
    if (
      nameLower.includes("write") ||
      nameLower.includes("create") ||
      nameLower.includes("delete")
    ) {
      console.log(`[PlanFilter] BLOCKED (brain write): ${name}`);
      return false;
    }
    console.log(`[PlanFilter] ALLOWED (brain read): ${name}`);
    return true;
  }

  // Allow RAG server read tools
  if (name.startsWith("mcp_rag-docs_")) {
    if (
      nameLower.includes("write") ||
      nameLower.includes("delete") ||
      nameLower.includes("index")
    ) {
      return false;
    }
    return true;
  }

  // Allow GitHub read-only tools
  if (name.startsWith("mcp_github_")) {
    if (
      nameLower.includes("create") ||
      nameLower.includes("update") ||
      nameLower.includes("delete") ||
      nameLower.includes("push") ||
      nameLower.includes("merge")
    ) {
      return false;
    }
    return true;
  }

  // Allow GitKraken read-only tools
  if (name.startsWith("mcp_gitkraken_")) {
    if (
      nameLower.includes("commit") ||
      nameLower.includes("push") ||
      nameLower.includes("checkout") ||
      nameLower.includes("stash") ||
      nameLower.includes("create")
    ) {
      return false;
    }
    return true;
  }

  // Allow VS Code built-in read-only tools (search, read, list, etc.)
  const readPatterns = [
    "read",
    "search",
    "find",
    "list",
    "get",
    "grep",
    "glob",
    "semantic_search",
    "file_search",
    "grep_search",
    "list_dir",
    "list_code_usages",
    "test_failure",
    "ask_questions",
    "manage_todo",
  ];
  if (readPatterns.some((p) => nameLower.includes(p))) {
    console.log(`[PlanFilter] ALLOWED (read pattern): ${name}`);
    return true;
  }

  // Block everything else by default in plan mode
  console.log(`[PlanFilter] BLOCKED (default deny): ${name}`);
  return false;
}

/**
 * Build a planning-mode system prompt for a worker.
 * Instructs the model to analyze and plan, but NOT execute changes.
 */
export function buildPlanningPrompt(workerId: string): string {
  return [
    `You are Worker ${workerId} in PLANNING MODE.`,
    "",
    "Your job is to ANALYZE the task and produce a structured plan — you must NOT execute any changes.",
    "",
    "PLANNING RULES:",
    "1. You have READ-ONLY access to the codebase. Use search and read tools to understand the task.",
    "2. Do NOT modify any files, run commands, or make changes.",
    "3. Analyze what needs to be done, identify affected files, and assess risk.",
    "4. Output a structured plan in the following format:",
    "",
    "```plan",
    "## Plan: [brief title]",
    "",
    "### What I'll do",
    "[Step-by-step description of changes]",
    "",
    "### Files to read",
    "[List of files I need to examine]",
    "",
    "### Files to modify",
    "[List of files I will change, with brief description of each change]",
    "",
    "### Tools I'll use",
    "[List of tools I plan to use during execution]",
    "",
    "### Estimated rounds",
    "[Number of agentic loop rounds I expect to need]",
    "",
    "### Risk assessment",
    "[low|medium|high] - [reason]",
    "```",
    "",
    "Be thorough in your analysis. The plan will be reviewed before execution is authorized.",
  ].join("\n");
}

/**
 * Parse a worker's plan-mode output into a structured TaskPlan.
 * Extracts sections from the markdown plan format.
 */
export function parsePlanOutput(taskId: string, rawText: string): TaskPlan {
  console.log(
    `[PlanParse] Parsing plan for ${taskId} (${rawText.length} chars)`,
  );
  const plan: TaskPlan = {
    taskId,
    planText: rawText,
    intendedTools: [],
    intendedReads: [],
    intendedWrites: [],
    estimatedRounds: 4,
    riskLevel: "medium",
    createdAt: Date.now(),
  };

  // Extract sections from the plan block
  const planBlock = rawText.match(/```plan\s*([\s\S]*?)```/);
  const content = planBlock ? planBlock[1] : rawText;

  // Parse "Files to read" section
  const readsMatch = content.match(/### Files to read\s*\n([\s\S]*?)(?=###|$)/);
  if (readsMatch) {
    plan.intendedReads = extractListItems(readsMatch[1]);
  }

  // Parse "Files to modify" section
  const writesMatch = content.match(
    /### Files to modify\s*\n([\s\S]*?)(?=###|$)/,
  );
  if (writesMatch) {
    plan.intendedWrites = extractListItems(writesMatch[1]);
  }

  // Parse "Tools I'll use" section
  const toolsMatch = content.match(
    /### Tools I'?ll use\s*\n([\s\S]*?)(?=###|$)/,
  );
  if (toolsMatch) {
    plan.intendedTools = extractListItems(toolsMatch[1]);
  }

  // Parse "Estimated rounds"
  const roundsMatch = content.match(/### Estimated rounds\s*\n\s*(\d+)/);
  if (roundsMatch) {
    plan.estimatedRounds = parseInt(roundsMatch[1], 10);
  }

  // Parse "Risk assessment"
  const riskMatch = content.match(
    /### Risk assessment\s*\n\s*(low|medium|high)/i,
  );
  if (riskMatch) {
    plan.riskLevel = riskMatch[1].toLowerCase() as "low" | "medium" | "high";
  }

  console.log(
    `[PlanParse] ${taskId}: risk=${plan.riskLevel}, reads=${plan.intendedReads.length}, writes=${plan.intendedWrites.length}, tools=${plan.intendedTools.length}, rounds=${plan.estimatedRounds}`,
  );

  return plan;
}

/** Extract list items (- item or * item) from a text block. */
function extractListItems(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+(.+)/);
    if (match) {
      // Clean up: remove markdown formatting, take just the file path or tool name
      const cleaned = match[1]
        .replace(/`/g, "")
        .split(/\s*[-—:]/)[0]
        .trim();
      if (cleaned) items.push(cleaned);
    }
  }
  return items;
}
