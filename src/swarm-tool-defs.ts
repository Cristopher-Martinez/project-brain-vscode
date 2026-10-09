// ─── Swarm Tool Definitions ────────────────────────────────────────────
// Virtual tool definitions injected into swarm workers.
// These tools are intercepted by the worker — they never reach VS Code.

import type * as vscode from "vscode";

// ─── Tool Name Constants ──────────────────────────────────────────────

export const MAILBOX_TOOL_NAME = "swarm_mailbox_post";
export const SUB_AGENT_TOOL_NAME = "swarm_sub_agent";
export const SUB_AGENT_MAX_ROUNDS = 5;
export const READ_FILE_TOOL_NAME = "swarm_read_file";
export const LIST_DIR_TOOL_NAME = "swarm_list_dir";
export const GREP_TOOL_NAME = "swarm_grep";

// ─── File Tool Constants ──────────────────────────────────────────────

export const MAX_FILE_CHARS = 15000;
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB hard limit
export const MAX_GREP_RESULTS = 30;
export const MAX_GREP_FILES = 500;

/** Extensions that are definitely binary — skip these entirely. */
export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".wasm",
  ".node",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".safetensors",
  ".bin",
  ".pkl",
  ".pt",
  ".onnx",
  ".sqlite",
  ".db",
]);

// ─── Mailbox Tool Definition ──────────────────────────────────────────

export const MAILBOX_TOOL_DEFINITION: vscode.LanguageModelChatTool = {
  name: MAILBOX_TOOL_NAME,
  description:
    "Post a message to the shared mailbox visible to all other workers in this session. " +
    "Use this to share findings, ask questions, report blockers, challenge conclusions, or build consensus. " +
    "Types: finding, question, challenge, update, blocker, consensus.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [
          "finding",
          "question",
          "challenge",
          "update",
          "blocker",
          "consensus",
        ],
        description: "Message type",
      },
      content: {
        type: "string",
        description: "Message content (be concise and specific)",
      },
      to: {
        type: "string",
        description: "Target worker ID (omit for broadcast to all)",
      },
    },
    required: ["type", "content"],
  },
};

// ─── Sub-Agent Tool Definition ────────────────────────────────────────

export const SUB_AGENT_TOOL_DEFINITION: vscode.LanguageModelChatTool = {
  name: SUB_AGENT_TOOL_NAME,
  description:
    "Spawn a lightweight sub-agent for focused research using Project Brain memory tools. " +
    "The sub-agent uses the VS Code LM API (free, no extra credits) and gets access to " +
    "searchMemory, getContext, findSkill, listMemoryFiles, and RAG docs search tools. " +
    "It runs for up to 5 tool rounds and returns its findings as text. " +
    "Use this for memory search, architecture questions, or knowledge lookup — NOT for reading source files directly. " +
    "To read source code, use swarm_read_file, swarm_list_dir, or swarm_grep instead.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Clear, focused task description. Be specific about what to investigate and what to return.",
      },
      context: {
        type: "string",
        description:
          "Optional context: relevant file paths, code snippets, or background info the sub-agent needs.",
      },
    },
    required: ["task"],
  },
};

// ─── File Tool Definitions ────────────────────────────────────────────

export const READ_FILE_TOOL_DEFINITION: vscode.LanguageModelChatTool = {
  name: READ_FILE_TOOL_NAME,
  description:
    "Read contents of a file from the workspace. " +
    "Path is relative to project root (e.g. 'src/extension.ts'). " +
    "Returns numbered lines. Optionally specify startLine/endLine (1-based) for a range. " +
    "For large files, read specific line ranges instead of the whole file.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "File path relative to workspace root (e.g. 'src/extension.ts')",
      },
      startLine: {
        type: "number",
        description: "1-based start line (default: 1)",
      },
      endLine: {
        type: "number",
        description: "1-based end line (default: end of file)",
      },
    },
    required: ["filePath"],
  },
};

export const LIST_DIR_TOOL_DEFINITION: vscode.LanguageModelChatTool = {
  name: LIST_DIR_TOOL_NAME,
  description:
    "List files and directories in a workspace folder. " +
    "Returns sorted entries (directories first, with / suffix). " +
    "Path is relative to project root — omit or use '.' for root.",
  inputSchema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: "Directory path relative to project root (default: '.')",
      },
    },
    required: [],
  },
};

export const GREP_TOOL_DEFINITION: vscode.LanguageModelChatTool = {
  name: GREP_TOOL_NAME,
  description:
    "Search for text patterns across workspace files. " +
    "Case-insensitive. Returns file:line:content for each match. " +
    "Use include to filter files (e.g. 'src/**/*.ts'). Max 30 results.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Text or regex pattern to search for",
      },
      include: {
        type: "string",
        description:
          "Glob pattern to filter files (default: '**/*.{ts,js,json,md}')",
      },
    },
    required: ["pattern"],
  },
};
