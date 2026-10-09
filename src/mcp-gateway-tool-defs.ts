// ─── MCP Gateway Tool Definitions ──────────────────────────────────────────────
// Extracted from mcp-gateway-tools.ts to respect the 400-line limit.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: "get_identity",
      description:
        "Returns the full agent identity (name, creature, vibe, emoji, language) and soul (tone, approach, style)",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_user_profile",
      description:
        "Returns the user profile (name, how to address them, notes)",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "search_memory",
      description: "Searches the project memory using semantic search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          topK: {
            type: "number",
            description: "Number of results (default: 5)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_context",
      description:
        "Reads a specific memory file by aspect name (e.g. 'architecture', 'overview', 'session')",
      inputSchema: {
        type: "object",
        properties: {
          aspect: {
            type: "string",
            description: "Memory aspect or filename (without .md)",
          },
        },
        required: ["aspect"],
      },
    },
    {
      name: "write_memory",
      description: "Appends content to a memory file",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Memory filename (e.g. '04_LEARNINGS.md')",
          },
          content: {
            type: "string",
            description: "Markdown content to append",
          },
        },
        required: ["file", "content"],
      },
    },
    {
      name: "list_memory_files",
      description: "Lists all memory files in .project-brain/memory/",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_opinions",
      description: "Returns top opinions with confidence scores",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Filter by domain (optional)",
          },
          limit: {
            type: "number",
            description: "Max opinions to return (default: 20)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_project_overview",
      description: "Returns the BOOT.md — compact project snapshot",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "create_loop",
      description: "Creates an interactive feedback loop session",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Loop goal/objective" },
        },
        required: ["goal"],
      },
    },
    {
      name: "send_loop_feedback",
      description: "Sends feedback to an active waiting loop",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Loop session ID" },
          feedback: { type: "string", description: "Feedback text" },
        },
        required: ["sessionId", "feedback"],
      },
    },
    {
      name: "get_loop_status",
      description: "Gets the current status of a loop session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Loop session ID" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "list_active_sessions",
      description: "Lists all active loops and orchestration sessions",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "orchestrate",
      description:
        "Launches an orchestration session (requires confirmation in VS Code)",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Orchestration goal" },
        },
        required: ["goal"],
      },
    },
    {
      name: "get_session_handoff",
      description:
        "Returns the last session handoff state (07_SESSION_HANDOFF.md)",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ];
}
