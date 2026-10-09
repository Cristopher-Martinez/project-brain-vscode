/**
 * Activity Feed — writes tool call events to `.project-brain/loops/activity-feed.json`
 * for real-time visualization in Brain HQ's Neural Pulse panel.
 *
 * Called from `post-tool-capture.mjs` after each tool invocation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getLoopsDir } from "./brain-paths.mjs";
const FEED_FILE = "activity-feed.json";
const MAX_ENTRIES = 150;

// ——— Category classification ————————————————————————————
const CATEGORY_MAP = {
  replace_string_in_file: "edit",
  multi_replace_string_in_file: "edit",
  create_file: "edit",
  grep_search: "search",
  semantic_search: "search",
  file_search: "search",
  tool_search_tool_regex: "search",
  read_file: "read",
  list_dir: "read",
  run_in_terminal: "terminal",
  get_terminal_output: "terminal",
  manage_todo_list: "agent",
  runSubagent: "agent",
};

const CATEGORY_ICONS = {
  edit: "✏️",
  search: "🔍",
  read: "📖",
  terminal: "💻",
  brain: "🧠",
  agent: "🤖",
};

/**
 * Classify a tool name into an activity category.
 */
function classifyTool(toolName) {
  if (CATEGORY_MAP[toolName]) return CATEGORY_MAP[toolName];
  if (toolName.startsWith("projectBrain")) return "brain";
  if (toolName.startsWith("mcp_")) return "brain";
  return "agent";
}

/**
 * Extract a human-readable summary from tool input.
 */
function summarizeTool(toolName, toolInput) {
  const category = classifyTool(toolName);

  switch (category) {
    case "edit": {
      const fp = toolInput.filePath || "";
      const basename = fp.split(/[/\\]/).pop() || "file";
      const replacements = toolInput.replacements;
      if (replacements && Array.isArray(replacements)) {
        const files = [...new Set(replacements.map((r) => (r.filePath || "").split(/[/\\]/).pop()))];
        return `${files.length} file(s): ${files.join(", ")}`;
      }
      return basename;
    }
    case "search": {
      const query = toolInput.query || toolInput.pattern || toolInput.regex || "";
      return query.substring(0, 60) || toolName;
    }
    case "read": {
      const fp = toolInput.filePath || toolInput.dirPath || "";
      return fp.split(/[/\\]/).pop() || toolName;
    }
    case "terminal": {
      const cmd = toolInput.command || "";
      return cmd.substring(0, 80) || "command";
    }
    case "brain": {
      const tool = toolInput.tool || toolInput.action || "";
      const query = toolInput.query || toolInput.goal || "";
      return tool ? `${tool}: ${query.substring(0, 50)}` : toolName;
    }
    default:
      return toolName;
  }
}

/**
 * Write a tool activity entry to the feed file.
 */
export function writeActivityEntry(cwd, sessionId, toolName, toolInput) {
  if (!cwd || !toolName) return;

  const category = classifyTool(toolName);
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
    sessionId: sessionId || "unknown",
    timestamp: Date.now(),
    tool: toolName,
    category,
    icon: CATEGORY_ICONS[category] || "⚙️",
    summary: summarizeTool(toolName, toolInput || {}),
  };

  const dir = getLoopsDir(cwd);
  const fp = join(dir, FEED_FILE);

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let feed = { entries: [] };
    try {
      const raw = readFileSync(fp, "utf8");
      feed = JSON.parse(raw);
      if (!Array.isArray(feed.entries)) feed.entries = [];
    } catch {
      // New or corrupt file — start fresh
    }

    feed.entries.push(entry);
    if (feed.entries.length > MAX_ENTRIES) {
      feed.entries = feed.entries.slice(-MAX_ENTRIES);
    }

    writeFileSync(fp, JSON.stringify(feed), "utf8");
  } catch {
    // Non-fatal — activity feed is best-effort
  }
}
