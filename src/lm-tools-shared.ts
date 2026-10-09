/**
 * Shared utility helpers used across lm-tools modules.
 *
 * Contains helpers that are used by multiple tool files:
 * - Plan gating constants
 * - Skill matching utilities
 * - Action closure system
 * - Embedding/CLI config helpers
 * - Tree builder
 *
 * Graph boost → lm-tools-graph-boost.ts
 * User preferences → lm-tools-preferences.ts
 *
 * Extracted to avoid circular dependencies between lm-tools-*.ts modules.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { MCPManager } from "./mcp-manager";
import type { Plan } from "./saas-client";

// ——— Project ID & Home Dir ———————————————————————————————————————

export function getProjectIdForTools(projectPath: string): string {
  return createHash("md5")
    .update(projectPath.replace(/\\/g, "/").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export function getHomeDir(): string {
  return (
    process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || ""
  );
}

// ——— Plan tier ranking for tool access ————————————————————————————

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

/**
 * Minimum plan required per sub-tool.
 * Tools not listed default to "free" (always accessible).
 */
export const TOOL_PLAN_REQUIREMENTS: Record<string, Plan> = {
  // Free tier
  searchMemory: "free",
  getContext: "free",
  writeMemory: "free",
  listMemoryFiles: "free",
  listProjects: "free",
  search: "free",
  findSkill: "free",
  // Pro tier
  heartbeat: "pro",
  reflect: "pro",
  delegateTask: "pro",
  swarm: "pro",
  indexProject: "pro",
  vectorizationStatus: "pro",
  watchProject: "pro",
  searchRelations: "pro",
  memoryHistory: "pro",
  createReminder: "pro",
  listReminders: "pro",
  snoozeReminder: "pro",
  completeReminder: "pro",
  strategyPicker: "pro",
  strategyFinalize: "pro",
  strategyComplete: "pro",
  orchestrate: "pro",
  orchEndSession: "pro",
  loop: "free",
  loopAwaitInput: "free",
  loopEnd: "free",
  readAgentDiary: "free",
  writeAgentDiary: "free",
  readVaultEntry: "free",
  writeVaultEntry: "free",
  removeVaultEntry: "free",
};

// ——— Skill Matching Utilities ——————————————————————————————————————

/** Short words that cause false-positive name matches via substring (e.g. "end" ⊂ "dependency") */
export const SKILL_NAME_STOPWORDS = new Set([
  "end",
  "are",
  "use",
  "set",
  "the",
  "for",
  "and",
  "not",
  "all",
  "any",
  "has",
  "had",
  "was",
  "get",
  "put",
  "run",
  "let",
  "var",
  "new",
  "try",
  "can",
  "may",
  "did",
  "its",
  "own",
  "add",
  "now",
  "top",
  "log",
  "raw",
]);

/** Basic suffix stemming for improved matching ("configuring" → "configur", "tests" → "test") */
export function stemWord(word: string): string {
  if (word.length < 5) return word;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4)
    return word.slice(0, -1);
  return word;
}

/** Score a word against a text field, with optional stopword protection for name fields */
export function skillMatchScore(
  word: string,
  text: string,
  isNameField: boolean,
): number {
  const stemmed = stemWord(word);
  // For name fields: skip stopwords (short ambiguous words that cause false positives)
  if (isNameField && word.length <= 3 && SKILL_NAME_STOPWORDS.has(word))
    return 0;
  if (text.includes(word) || text.includes(stemmed)) return isNameField ? 3 : 1;
  return 0;
}

// ——— Action Closure ————————————————————————————————————————————————

/** Embed an action suggestion as an HTML comment in tool output. */
const ACTION_MARKER_PREFIX = "<!-- action:";
const ACTION_MARKER_SUFFIX = " -->";
const MAX_ACTIONS = 2;

export interface ActionSuggestion {
  tool: string;
  params?: Record<string, unknown>;
  label: string;
}

/**
 * Create an action marker to embed in tool output text.
 * Post-processor in ToolboxTool.invoke() will extract and render these.
 */
export function createActionMarker(action: ActionSuggestion): string {
  return `${ACTION_MARKER_PREFIX}${JSON.stringify(action)}${ACTION_MARKER_SUFFIX}`;
}

/**
 * Extract action markers from output text and return clean text + actions.
 * Actions are capped at MAX_ACTIONS and only surfaced when confidence is high enough.
 */
export function extractActions(text: string): {
  cleanText: string;
  actions: ActionSuggestion[];
} {
  const regex = /<!-- action:({.*?}) -->/g;
  const actions: ActionSuggestion[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null && actions.length < MAX_ACTIONS) {
    try {
      const action = JSON.parse(match[1]) as ActionSuggestion;
      if (action.tool && action.label) actions.push(action);
    } catch {
      /* skip malformed actions */
    }
  }
  const cleanText = text.replace(/\s*<!-- action:{.*?} -->/g, "");
  return { cleanText, actions };
}

/**
 * Format extracted actions into 💡 suggestions appended to output.
 * Only shown when confidence ≥ HIGH threshold and suggestActions is enabled.
 */
export function formatActionSuggestions(actions: ActionSuggestion[]): string {
  if (actions.length === 0) return "";
  const lines = actions.map((a) => {
    const params = a.params ? ` ${JSON.stringify(a.params)}` : "";
    return `💡 **Suggested:** ${a.label} → \`toolbox.${a.tool}${params}\``;
  });
  return `\n\n---\n${lines.join("\n")}`;
}

// ——— Utility helpers ———————————————————————————————————————————————

export function getEmbeddingEnvFromConfig(): Record<string, string> {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const env: Record<string, string> = {};
  env.EMBEDDING_PROVIDER = config.get<string>("embeddings", "auto");
  const embeddingKey = config.get<string>("embeddingApiKey", "");
  if (embeddingKey) env.EMBEDDING_API_KEY = embeddingKey;
  const embeddingModel = config.get<string>(
    "embeddingModel",
    "BAAI/bge-small-en-v1.5",
  );
  if (embeddingModel) env.EMBEDDING_MODEL = embeddingModel;
  const embeddingBaseUrl = config.get<string>("embeddingBaseUrl", "");
  if (embeddingBaseUrl) env.EMBEDDING_BASE_URL = embeddingBaseUrl;
  return env;
}

export function getCliPathFromManager(mcpManager: MCPManager): string {
  const serverPath = mcpManager.getMCPServerPath();
  if (!serverPath) throw new Error("MCP server path not set");
  return mcpManager.getIsBundled()
    ? path.join(serverPath, "cli.mjs")
    : path.join(serverPath, "dist", "cli.js");
}

export function buildTree(dirPath: string, indent: string): string {
  let result = "";
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    const childIndent = isLast ? "    " : "│   ";
    if (entry.isDirectory()) {
      result += `${indent}${prefix}${entry.name}/\n`;
      result += buildTree(path.join(dirPath, entry.name), indent + childIndent);
    } else {
      result += `${indent}${prefix}${entry.name}\n`;
    }
  }
  return result;
}

// ——— Re-exports from extracted modules ———————————————————————————
export {
  loadGraphForBoost,
  graphBoostSkills,
  type ScoredSkill,
} from "./lm-tools-graph-boost";
export {
  getUserPreferences,
  getPreferenceHint,
  detectPreferenceSignal,
  type ResponseStyle,
  type ResponseLanguage,
} from "./lm-tools-preferences";

