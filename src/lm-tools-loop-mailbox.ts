/**
 * LM Tool: Loop Mailbox — STRAT-7
 *
 * Exposes inter-loop messaging to agents via the toolbox.
 * Actions: send, broadcast, read, reply, list
 */

import * as vscode from "vscode";
import {
  sendMessage,
  readMessages,
  getUnreadCount,
  getThread,
  clearSessionMessages,
  formatUnreadMessages,
  resolveMessage,
  resolveSessionMessages,
} from "./loop-mailbox";
import type { LoopMessageType, LoopMessage } from "./loop-mailbox";

export class LoopMailTool implements vscode.LanguageModelTool<LoopMailInput> {
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LoopMailInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action, sessionId, to, type, content, messageId } = options.input;
    this.log(
      `[LoopMail] action=${action}, session=${sessionId?.substring(0, 8)}`,
    );

    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!repoRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "No active loop session — mailbox not available.",
        ),
      ]);
    }

    if (!sessionId) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "sessionId is required for all mailbox operations.",
        ),
      ]);
    }

    switch (action) {
      case "send":
        return this.handleSend(
          repoRoot,
          sessionId,
          to,
          type,
          content,
          messageId,
        );
      case "broadcast":
        return this.handleBroadcast(repoRoot, sessionId, type, content);
      case "read":
        return this.handleRead(repoRoot, sessionId);
      case "reply":
        return this.handleReply(repoRoot, sessionId, messageId, content);
      case "unread":
        return this.handleUnread(repoRoot, sessionId);
      case "resolve":
        return this.handleResolve(repoRoot, sessionId, messageId);
      default:
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Unknown action '${action}'. Available: send, broadcast, read, reply, unread, resolve`,
          ),
        ]);
    }
  }

  private handleSend(
    repoRoot: string,
    from: string,
    to?: string,
    type?: LoopMessageType,
    content?: string,
    replyTo?: string,
  ): vscode.LanguageModelToolResult {
    if (!to) {
      return this.textResult("'to' (target sessionId) is required for send.");
    }
    if (!content) {
      return this.textResult("'content' is required for send.");
    }

    const msg = sendMessage(
      repoRoot,
      from,
      to,
      type || "warning",
      content,
      replyTo ? { replyTo } : undefined,
    );
    return this.textResult(
      `Message sent (id: ${msg.id}). Target: ${to.substring(0, 8)}, type: ${msg.type}`,
    );
  }

  private handleBroadcast(
    repoRoot: string,
    from: string,
    type?: LoopMessageType,
    content?: string,
  ): vscode.LanguageModelToolResult {
    if (!content) {
      return this.textResult("'content' is required for broadcast.");
    }

    const msg = sendMessage(repoRoot, from, null, type || "broadcast", content);
    return this.textResult(
      `Broadcast sent (id: ${msg.id}). Type: ${msg.type}. All active loops will see this.`,
    );
  }

  private handleRead(
    repoRoot: string,
    sessionId: string,
  ): vscode.LanguageModelToolResult {
    const messages = readMessages(repoRoot, sessionId);
    if (messages.length === 0) {
      return this.textResult("No unread messages. Inbox clean.");
    }

    const formatted = formatUnreadMessages(messages);
    const detail = messages.map((m) => this.formatMessage(m)).join("\n---\n");
    return this.textResult(`${formatted}\n\nDetalles:\n${detail}`);
  }

  private handleReply(
    repoRoot: string,
    from: string,
    messageId?: string,
    content?: string,
  ): vscode.LanguageModelToolResult {
    if (!messageId || !content) {
      return this.textResult(
        "'messageId' and 'content' are required for reply.",
      );
    }

    const thread = getThread(repoRoot, messageId);
    const original = thread[0];
    if (!original) {
      return this.textResult(`Message ${messageId} not found.`);
    }

    const msg = sendMessage(
      repoRoot,
      from,
      original.from,
      "answer",
      content,
      { replyTo: messageId },
    );
    return this.textResult(
      `Reply sent (id: ${msg.id}) to ${original.from.substring(0, 8)}.`,
    );
  }

  private handleUnread(
    repoRoot: string,
    sessionId: string,
  ): vscode.LanguageModelToolResult {
    const count = getUnreadCount(repoRoot, sessionId);
    return this.textResult(`Unread messages: ${count}`);
  }

  private handleResolve(
    repoRoot: string,
    sessionId: string,
    messageId?: string,
  ): vscode.LanguageModelToolResult {
    if (messageId) {
      const found = resolveMessage(repoRoot, messageId);
      return this.textResult(
        found
          ? `Message ${messageId} resolved.`
          : `Message ${messageId} not found.`,
      );
    }
    const count = resolveSessionMessages(repoRoot, sessionId);
    return this.textResult(
      count > 0
        ? `Resolved ${count} message(s) for session ${sessionId.substring(0, 8)}.`
        : "No active messages to resolve.",
    );
  }

  private formatMessage(m: LoopMessage): string {
    const from = m.from.substring(0, 8);
    const time = new Date(m.timestamp).toLocaleTimeString();
    return `[${time}] From: ${from} | Type: ${m.type}\n${m.content}`;
  }

  private textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}

interface LoopMailInput {
  action: "send" | "broadcast" | "read" | "reply" | "unread" | "resolve";
  sessionId?: string;
  to?: string;
  type?: LoopMessageType;
  content?: string;
  messageId?: string;
}
