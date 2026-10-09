// ─── Swarm Sub-Agent ───────────────────────────────────────────────────
// Lightweight agentic loop for sub-agent delegation within swarm workers.
// Uses the same free VS Code LM API — no additional credits.

import * as vscode from "vscode";
import { SUB_AGENT_MAX_ROUNDS } from "./swarm-tool-defs";
import { READ_ONLY_TOOLS, toolInfoToChat } from "./swarm-tool-helpers";

/**
 * Execute a focused sub-agent with read-only Project Brain tools.
 * Sub-agents get searchMemory, getContext, findSkill, listMemoryFiles,
 * and RAG docs search tools. No file-reading tools.
 * Max SUB_AGENT_MAX_ROUNDS rounds, then returns findings as text.
 */
export async function executeSubAgent(
  model: vscode.LanguageModelChat,
  taskDescription: string,
  context: string | undefined,
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  token: vscode.CancellationToken,
  log: (msg: string) => void,
): Promise<string> {
  const subId = `sub-${Date.now().toString(36)}`;
  log(`[SubAgent ${subId}] Starting: "${taskDescription.substring(0, 100)}"`);

  const subTools = gatherSubAgentTools(log, subId);
  const messages = buildSubAgentMessages(taskDescription, context);
  const requestOptions: vscode.LanguageModelChatRequestOptions = {
    tools: subTools,
  };

  let fullText = "";
  let rounds = 0;

  while (rounds < SUB_AGENT_MAX_ROUNDS) {
    rounds++;
    if (token.isCancellationRequested) {
      log(`[SubAgent ${subId}] Cancelled at round ${rounds}`);
      break;
    }

    const { textParts, toolCallParts } = await sendSubAgentRequest(
      model,
      messages,
      requestOptions,
      token,
    );
    log(
      `[SubAgent ${subId}] Round ${rounds}: ${textParts.length} text, ${toolCallParts.length} tool calls`,
    );

    fullText += textParts.map((p) => p.value).join("");

    if (toolCallParts.length === 0) break;

    // Deduplicate tool calls
    const seen = new Set<string>();
    const uniqueCalls = toolCallParts.filter((tc) => {
      if (seen.has(tc.callId)) return false;
      seen.add(tc.callId);
      return true;
    });

    messages.push(vscode.LanguageModelChatMessage.Assistant(uniqueCalls));

    await executeSubAgentToolCalls(
      uniqueCalls,
      messages,
      toolInvocationToken,
      token,
      log,
      subId,
    );
  }

  log(`[SubAgent ${subId}] Done: ${rounds} rounds, ${fullText.length} chars`);
  return fullText || "(sub-agent produced no output)";
}

/** Gather tools available for sub-agents (read-only project brain tools). */
function gatherSubAgentTools(
  log: (msg: string) => void,
  subId: string,
): vscode.LanguageModelChatTool[] {
  const SUB_AGENT_WRITE_TOOLS = new Set([
    "mcp_rag-docs_write_memory",
    "mcp_rag-docs_index_project",
    "mcp_rag-docs_watch_project",
    "projectBrain_awaken",
  ]);

  const subTools = vscode.lm.tools
    .filter((t) => {
      const n = t.name;
      if (SUB_AGENT_WRITE_TOOLS.has(n)) return false;
      if (n.startsWith("projectBrain_")) return true;
      if (n.startsWith("mcp_rag-docs_")) return true;
      if (READ_ONLY_TOOLS.has(n) && n !== "get_terminal_output") return true;
      return false;
    })
    .map(toolInfoToChat);

  log(
    `[SubAgent ${subId}] ${subTools.length} tools: ${subTools.map((t) => t.name).join(", ")}`,
  );
  return subTools;
}

/** Build initial messages for a sub-agent session. */
function buildSubAgentMessages(
  taskDescription: string,
  context: string | undefined,
): vscode.LanguageModelChatMessage[] {
  const systemPrompt = [
    "You are a focused research sub-agent with access to Project Brain memory and RAG search tools.",
    "You can search project memory (searchMemory), read memory files (getContext), find skills (findSkill),",
    "list indexed files (listMemoryFiles), and search semantic relations (search_relations).",
    "You do NOT have access to file-reading tools like read_file or grep_search.",
    "",
    "RULES:",
    "1. Focus ONLY on the assigned task — do not deviate",
    '2. Use projectBrain_toolbox with tool="searchMemory" to search project knowledge',
    '3. Use projectBrain_toolbox with tool="getContext" to read specific memory aspects',
    "4. Be concise — your output returns to the parent worker",
    "5. When you have enough info, write your final answer as plain text",
    "6. Do NOT try to use tools that aren't listed — you will fail",
  ].join("\n");

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
  ];

  let userMsg = `## Task\n${taskDescription}`;
  if (context) {
    userMsg += `\n\n## Additional Context\n${context}`;
  }
  messages.push(vscode.LanguageModelChatMessage.User(userMsg));

  return messages;
}

/** Send a request and collect stream parts. */
async function sendSubAgentRequest(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  requestOptions: vscode.LanguageModelChatRequestOptions,
  token: vscode.CancellationToken,
): Promise<{
  textParts: vscode.LanguageModelTextPart[];
  toolCallParts: vscode.LanguageModelToolCallPart[];
}> {
  const textParts: vscode.LanguageModelTextPart[] = [];
  const toolCallParts: vscode.LanguageModelToolCallPart[] = [];

  const resp = await model.sendRequest(messages, requestOptions, token);
  for await (const part of resp.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textParts.push(part);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCallParts.push(part);
    }
  }

  return { textParts, toolCallParts };
}

/** Execute tool calls for a sub-agent round. */
async function executeSubAgentToolCalls(
  uniqueCalls: vscode.LanguageModelToolCallPart[],
  messages: vscode.LanguageModelChatMessage[],
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  token: vscode.CancellationToken,
  log: (msg: string) => void,
  subId: string,
): Promise<void> {
  for (const tc of uniqueCalls) {
    log(
      `[SubAgent ${subId}] 🔧 ${tc.name}(${JSON.stringify(tc.input).substring(0, 60)})`,
    );

    try {
      const toolResult = await vscode.lm.invokeTool(
        tc.name,
        { input: tc.input, toolInvocationToken },
        token,
      );

      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(tc.callId, toolResult.content),
        ]),
      );
    } catch (toolErr: unknown) {
      const errMsg = `Tool ${tc.name} failed: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
      log(`[SubAgent ${subId}] ❌ ${errMsg}`);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(tc.callId, [
            new vscode.LanguageModelTextPart(errMsg),
          ]),
        ]),
      );
    }
  }
}
