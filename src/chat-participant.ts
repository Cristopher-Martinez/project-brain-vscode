import * as vscode from "vscode";
import { AgentIdentityManager } from "./agent-identity";
import { getLoopRecoveryInfo } from "./loop-recovery";
import { ModelRouter } from "./model-router";
import { requireEnabled } from "./project-lifecycle-utils";

// ─── Handlers (extracted — Command pattern) ────────────────────────────────
import {
  HandlerContext,
  handleBootstrapConversation,
  handleDefaultRequest,
  handleDocCommand,
  handleIdentityCommand,
  handleLoopCommand,
  handlePromptCommand,
  handleRouterCommand,
  handleSearchCommand,
  handleSoulCommand,
  handleSpawnCommand,
  handleStatusCommand,
  handleUserCommand,
} from "./chat-handlers";

// Re-export for backward compatibility (lm-tools.ts imports these)
export { HandlerContext } from "./chat-handlers";

/**
 * @brain Chat Participant — Mechanical enforcement of memory usage.
 *
 * Unlike prompt engineering (which agents can ignore), this participant
 * ALWAYS searches project memory before answering. The LLM receives
 * memory context as part of the system prompt — it cannot skip it.
 *
 * Identity system (inspired by OpenClaw):
 *   - IDENTITY (08_AGENT_IDENTITY.md) — Who the agent is: name, creature, vibe
 *   - SOUL (09_AGENT_SOUL.md) — How it behaves: tone, boundaries, approach
 *   - USER (10_USER_PROFILE.md) — Who the human is: name, preferences
 *   - BOOTSTRAP (11_BOOTSTRAP.md) — First-run conversational ritual
 *
 * If no identity exists, the agent enters BOOTSTRAP mode: an organic
 * conversation to discover who it is and who the user is.
 *
 * Commands:
 *   (default)  — Search memory + answer with context
 *   /doc       — Generate documentation entry for recent changes
 *   /status    — Show project memory status
 *   /search    — Explicit memory search
 *   /identity  — View or reconfigure the agent's identity
 *   /soul      — View or reconfigure behavior/boundaries
 *   /user      — View or reconfigure user profile
 *   /router    — Model router status + slave delegation test
 *   /spawn     — Spawn new session for context continuity
 */

const PARTICIPANT_ID = "projectBrain.brain";



// ─── Stream Wrapper (Response Prefix) ──────────────────────────────────────

/**
 * Wraps a ChatResponseStream to inject identity prefix on first markdown write.
 * Example: "🏴‍☠️ Jasper | " before the first content.
 *
 * Inspired by OpenClaw's response prefix system for consistent character presence.
 */
function createPrefixedStream(
  stream: vscode.ChatResponseStream,
  identityManager: AgentIdentityManager,
): vscode.ChatResponseStream {
  let prefixInjected = false;

  const getPrefix = (): string => {
    const identity = identityManager.loadIdentity();
    if (!identity) return "";
    return `${identity.emoji} **${identity.name}** | `;
  };

  return {
    ...stream,
    markdown: (value: string | vscode.MarkdownString) => {
      if (!prefixInjected) {
        const prefix = getPrefix();
        if (prefix) {
          stream.markdown(prefix);
        }
        prefixInjected = true;
      }
      stream.markdown(value);
    },
    // Other methods (progress, reference, etc.) don't inject prefix
    progress: stream.progress.bind(stream),
    reference: stream.reference?.bind(stream),
    button: stream.button?.bind(stream),
    anchor: stream.anchor?.bind(stream),
    push: stream.push?.bind(stream),
  };
}

// ─── Registration ──────────────────────────────────────────────────────────

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  searchMemoryFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>,
  identityManager: AgentIdentityManager,
  log: (msg: string) => void,
  modelRouter?: ModelRouter,
  autoCapture?: import("./auto-capture").AutoCapture,
  promptLoader?: import("./prompt-loader").PromptLoader,
  promptManager?: import("./prompt-manager").PromptManager,
): vscode.ChatParticipant {
  // Handler context — shared dependencies (Parameter Object pattern)
  const ctx: HandlerContext = {
    searchMemoryFn,
    identityManager,
    log,
    modelRouter,
    autoCapture,
    promptLoader,
    promptManager,
  };

  // ─── Main Request Handler (Command dispatch) ────────────────────────────

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) => {
    // Workspace activation guard — block @brain if not initialized
    if (!requireEnabled()) {
      stream.markdown('Project Brain is not initialized in this workspace. Run **Project Brain: Initialize** first.');
      return { metadata: { command: 'blocked' } };
    }

    // Wrap stream to inject identity prefix on first markdown write
    const prefixedStream = createPrefixedStream(stream, identityManager);

    log(
      `@brain handler invoked — command: ${request.command || "(none)"}, prompt: "${request.prompt.substring(0, 50)}"`,
    );

    let result: vscode.ChatResult;

    try {
      // ─── Command Dispatch (switch replaces if/else chain) ──────
      switch (request.command) {
        case "identity":
          result = await handleIdentityCommand(request, prefixedStream, ctx);
          break;

        case "soul":
          result = await handleSoulCommand(request, prefixedStream, ctx);
          break;

        case "user":
          result = await handleUserCommand(request, prefixedStream, ctx);
          break;

        case "doc":
          result = await handleDocCommand(request, prefixedStream, token, ctx);
          break;

        case "status":
          result = await handleStatusCommand(prefixedStream, ctx);
          break;

        case "router":
          result = await handleRouterCommand(
            request,
            prefixedStream,
            token,
            ctx,
          );
          break;

        case "search":
          result = await handleSearchCommand(request, prefixedStream, ctx);
          break;

        case "spawn":
          result = await handleSpawnCommand(
            request,
            chatContext,
            prefixedStream,
            token,
            ctx,
          );
          break;

        case "prompt":
          result = await handlePromptCommand(
            request,
            chatContext,
            prefixedStream,
            token,
            ctx,
          );
          break;

        case "loop":
          result = await handleLoopCommand(request, prefixedStream, token, ctx);
          break;

        default: {
          // BOOTSTRAP or DEFAULT — based on identity existence
          const hasId = identityManager.hasIdentity();
          log(`@brain: hasIdentity() = ${hasId}`);

          if (!hasId) {
            log("@brain: → routing to BOOTSTRAP conversation");
            result = await handleBootstrapConversation(
              request,
              prefixedStream,
              token,
              ctx,
            );
          } else {
            log("@brain: → routing to DEFAULT handler (identity exists)");
            result = await handleDefaultRequest(
              request,
              chatContext,
              prefixedStream,
              token,
              ctx,
            );
          }
          break;
        }
      }
    } catch (err) {
      log(`@brain HANDLER ERROR: ${err}`);
      const identity = identityManager.loadIdentity();
      const isEs = /espa[nñ]ol|spanish/i.test(identity?.language ?? "English");
      stream.markdown(
        `⚠️ **${isEs ? "Error interno en @brain" : "Internal @brain error"}:** ${err}\n\n`,
      );
      stream.markdown(
        isEs
          ? "Revisa el panel de Output → Project Brain para más detalles.\n"
          : "Check the Output panel → Project Brain for more details.\n",
      );
      return { metadata: { error: true } };
    }

    return result;
  };

  // ─── Create Participant ──────────────────────────────────────────────────

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    handler,
  );
  participant.iconPath = new vscode.ThemeIcon("brain");

  // Followup provider — context-aware suggestions
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): vscode.ChatFollowup[] {
      const followups: vscode.ChatFollowup[] = [];
      const meta = result.metadata as Record<string, unknown> | undefined;

      if (meta?.hasCodeChanges) {
        followups.push({
          prompt: "Document the changes I just made",
          label: "📝 Document this change",
          command: "doc",
        });
      }

      // Loop recovery — detect interrupted loops and offer resume button
      const recoverable = getLoopRecoveryInfo();
      if (recoverable) {
        followups.unshift({
          prompt: `Resume interrupted loop session ${recoverable.sessionId} with goal: ${recoverable.goal}`,
          label: `🔁 Reanudar loop interrumpido: ${recoverable.goal.substring(0, 40)}`,
        });
      }

      // When error occurred during active loop, offer specific recovery
      if (meta?.error && recoverable) {
        followups.unshift({
          prompt: `The loop was interrupted. Reconnect and continue: ${recoverable.goal}`,
          label: "⚡ Reintentar loop (cancelado por servidor)",
        });
      }

      followups.push({
        prompt: "What is the current project status?",
        label: "📊 Project status",
        command: "status",
      });

      followups.push({
        prompt: "Spawn a new session to continue with fresh context",
        label: "🔄 Spawn new session",
        command: "spawn",
      });

      return followups;
    },
  };

  context.subscriptions.push(participant);
  log("@brain chat participant registered");
  return participant;
}

// ─── Real Token Counter for Chat History ───────────────────────────────────

/**
 * Tokenize the full chat history using the VS Code LM API.
 * This gives us REAL token counts for the conversation so far,
 * not just estimates. Runs async — doesn't block the handler.
 */

