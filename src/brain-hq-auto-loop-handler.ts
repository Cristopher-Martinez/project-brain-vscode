/**
 * brain-hq-auto-loop-handler — Message routing for Auto Loop Bridge tab.
 *
 * Handles webview ↔ extension messages for bridge sessions:
 * create, select, PM chat, promote, feedback, dispatch.
 *
 * Delegates to auto-loop-bridge-manager for all operations.
 */

import * as vscode from "vscode";
import { AgentIdentityManager } from "./agent-identity";
import { resolveBridgeApiKey, isWrongProviderKey } from "./bridge-api-key-resolver";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import {
  addSynthesisToBridge,
  closeBridgeSession,
  createBridgeSession,
  recoverBridgeSessions,
  dispatchBridgeFeedback,
  getAllBridgeSessionViews,
  getBridgeSession,
  getBridgeSessionView,
  promoteBridgeSuggestion,
  selectBridgeSynthesis,
  sendBridgePmChat,
  setBridgeSessionModel,
  updateBridgeFeedbackDraft,
} from "./auto-loop-bridge-manager";
import type { PMProviderConfig } from "./auto-loop-bridge-types";
import { getDefaultModelForProvider } from "./pm-provider-registry";
import { loopSendFeedback, loopHasPendingFeedback } from "./loop-engine";
import * as fs from "fs";
import * as path from "path";
import { getLoopDir } from "./brain-paths";
import { resolveFeedbackTargetLoopSessionId } from "./bridge-loop-state-resolver";
import { spawnNewLoopFromBridge, reconnectLoopFromBridge } from "./bridge-loop-spawner";

/**
 * Handle Auto Loop Bridge messages from the webview.
 * Returns true if the message was handled, false otherwise.
 */
export async function handleAutoLoopMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "requestAutoLoopBridgeState": {
      recoverBridgeSessions(instance.ctx.workspaceFolder.uri.fsPath);
      const sessions = getAllBridgeSessionViews();
      instance.ctx.log(
        `[AutoLoopHandler] requestState → ${sessions.length} sessions`,
      );
      instance.panel.webview.postMessage({
        type: "autoLoopBridgeState",
        sessions,
      });
      return true;
    }

    case "createAutoLoopBridgeSession": {
      const title = msg.title as string;
      let workerLoopSessionId = msg.workerLoopSessionId as string;
      const goal = msg.goal as string | undefined;

      if (!title) {
        instance.ctx.log("[AutoLoopHandler] Missing title");
        break;
      }

      // Mode: create new loop from scratch (no existing loop selected)
      if (!workerLoopSessionId && goal) {
        const spawnResult = await spawnNewLoopFromBridge(goal, instance.ctx.log);
        if (!spawnResult.launched) {
          instance.panel.webview.postMessage({
            type: "autoLoopError",
            message: spawnResult.error ?? "Failed to launch loop",
          });
          return true;
        }
        workerLoopSessionId = spawnResult.newLoopId;
      } else if (!workerLoopSessionId) {
        instance.ctx.log("[AutoLoopHandler] Missing workerLoopSessionId and goal");
        break;
      } else {
        // Mode: connect to existing loop — validate it exists
        const repoRoot = instance.ctx.workspaceFolder.uri.fsPath;
        const loopDir = getLoopDir(repoRoot, workerLoopSessionId);
        const histPath = path.join(loopDir, "history.json");
        if (!fs.existsSync(histPath)) {
          instance.ctx.log(`[AutoLoopHandler] Loop not found: ${workerLoopSessionId}`);
          instance.panel.webview.postMessage({
            type: "autoLoopError",
            message: `Loop ${workerLoopSessionId.slice(0, 8)}... not found or has no history`,
          });
          return true;
        }
      }

      const repoRoot =
        instance.ctx.workspaceFolder.uri.fsPath;
      const bridgeCfg = vscode.workspace.getConfiguration("projectBrain.bridge");
      const providerId = (msg.pmProviderId as string) || bridgeCfg.get<string>("defaultProvider", "gemini") || "gemini";
      const apiKeyResolution = await resolveBridgeApiKey(providerId, msg.pmApiKey as string | undefined);
      let resolvedKey = apiKeyResolution.apiKey;
      // Safety net: discard key if it belongs to wrong provider (e.g. Gemini key for OpenRouter)
      if (resolvedKey && isWrongProviderKey(resolvedKey, providerId)) {
        instance.ctx.log(`[AutoLoopHandler] Discarding resolved key for ${providerId}: wrong provider pattern`);
        resolvedKey = "";
      }
      instance.ctx.log(`[AutoLoopHandler] createSession: keySource=${apiKeyResolution.source}, provider=${providerId}, hasKey=${!!resolvedKey}, keyLen=${resolvedKey.length}`);
      const pmConfig: PMProviderConfig = {
        providerId,
        apiKeyRef: resolvedKey,
        enabled: true,
        enabledModelIds: bridgeCfg.get<string[]>(`${providerId}.enabledModelIds`, []),
        defaultModelId: (msg.pmModelId as string) || bridgeCfg.get<string>("defaultModel") || getDefaultModelForProvider(providerId),
      };

      let identityPrompt: string | undefined;
      try {
        const idMgr = new AgentIdentityManager(instance.ctx.workspaceFolder, instance.ctx.log);
        identityPrompt = idMgr.getIdentityPrompt() ?? undefined;
      } catch { /* identity is optional */ }

      const session = createBridgeSession({
        title,
        workerLoopSessionId,
        pmProviderId: pmConfig.providerId,
        pmModelId: pmConfig.defaultModelId ?? getDefaultModelForProvider(pmConfig.providerId),
        pmProviderConfig: pmConfig,
        repoRoot,
        objective: (msg.objective as string) || title,
        identityPrompt,
      });

      // Await model refresh so the initial view includes available models
      await session.refreshAvailableModels();
      const view = session.toView();
      instance.ctx.log(
        `[AutoLoopHandler] Session created: ${session.sessionId}, participants=${JSON.stringify(view.participants ? Object.keys(view.participants) : 'MISSING')}`,
      );
      instance.panel.webview.postMessage({
        type: "autoLoopBridgeSessionCreated",
        session: view,
      });
      return true;
    }

    case "selectAutoLoopBridgeSession": {
      const sessionId = msg.sessionId as string;
      if (!sessionId) break;
      const view = getBridgeSessionView(sessionId);
      if (view) {
        instance.panel.webview.postMessage({
          type: "autoLoopBridgeSessionUpdated",
          session: view,
        });
      }
      // Notify webview to switch active bridge session
      instance.panel.webview.postMessage({
        type: "autoLoopBridgeActiveChanged",
        sessionId,
      });
      return true;
    }

    case "selectAutoLoopSynthesis": {
      const sessionId = msg.sessionId as string;
      const synthesisId = msg.synthesisId as string;
      if (!sessionId || !synthesisId) break;
      selectBridgeSynthesis(sessionId, synthesisId);
      const view = getBridgeSessionView(sessionId);
      if (view) {
        instance.panel.webview.postMessage({
          type: "autoLoopBridgeSessionUpdated",
          session: view,
        });
      }
      return true;
    }

    case "setAutoLoopPmModel": {
      const sessionId = msg.sessionId as string;
      const modelId = msg.modelId as string;
      const synthesisId = typeof msg.synthesisId === "string" ? msg.synthesisId : undefined;
      if (!sessionId || !modelId) break;
      setBridgeSessionModel(sessionId, modelId, synthesisId);
      const mView = getBridgeSessionView(sessionId);
      if (mView) {
        instance.panel.webview.postMessage({ type: "autoLoopBridgeSessionUpdated", session: mView });
      }
      return true;
    }

    case "sendAutoLoopPmChat": {
      const sessionId = msg.sessionId as string;
      const synthesisId = msg.synthesisId as string;
      const text = msg.text as string;
      const modelId = typeof msg.modelId === "string" ? msg.modelId : "";
      if (!sessionId || !synthesisId || !text) {
        instance.ctx.log(
          `[AutoLoopHandler] pmChat: missing params sessionId=${!!sessionId} synthesisId=${!!synthesisId} text=${!!text}`,
        );
        break;
      }

      if (modelId) {
        const changed = setBridgeSessionModel(sessionId, modelId, synthesisId);
        instance.ctx.log(
          `[AutoLoopHandler] pmChat model sync: session=${sessionId.slice(0, 8)} model=${modelId} changed=${changed}`,
        );
      }

      instance.ctx.log(
        `[AutoLoopHandler] pmChat: session=${sessionId.slice(0, 8)} synthesis=${synthesisId.slice(0, 8)} textLen=${text.length} model=${modelId || "(unchanged)"}`,
      );

      let suggestion;
      let pmError: string | null = null;
      try {
        suggestion = await sendBridgePmChat(
          sessionId,
          synthesisId,
          text,
        );
      } catch (err) {
        pmError = `PM call failed: ${err}`;
        instance.ctx.log(`[AutoLoopHandler] pmChat ERROR: ${err}`);
      }

      if (!suggestion && !pmError) {
        const bs = getBridgeSession(sessionId);
        const budget = bs?.getState().tokenBudget;
        pmError = budget && budget.consumedTurns >= budget.maxSuggestionTurns
          ? "Turn budget exhausted (" + budget.consumedTurns + "/" + budget.maxSuggestionTurns + " turns used). Start a new session to continue."
          : "PM did not return a suggestion";
      }

      instance.ctx.log(
        `[AutoLoopHandler] pmChat result: hasSuggestion=${!!suggestion}, id=${suggestion?.id ?? 'none'}, error=${pmError ?? 'none'}`,
      );

      if (suggestion) {
        instance.panel.webview.postMessage({
          type: "autoLoopPmSuggestion",
          sessionId,
          suggestion: {
            id: suggestion.id,
            recommendation: suggestion.recommendation,
            reasoning: suggestion.reasoning,
            risk: suggestion.risk,
            suggestedWorkerFeedback: suggestion.suggestedWorkerFeedback,
          },
        });
      }

      // Always send session update � even on error
      const view = getBridgeSessionView(sessionId);
      if (view) {
        instance.panel.webview.postMessage({
          type: "autoLoopBridgeSessionUpdated",
          session: view,
        });
      }

      // Send error after session update so user sees the reason
      if (pmError) {
        instance.panel.webview.postMessage({
          type: "autoLoopError",
          sessionId,
          message: pmError,
        });
      }
      return true;
    }

    case "promotePmSuggestionToWorkerFeedback": {
      const sessionId = msg.sessionId as string;
      const suggestionId = msg.suggestionId as string;
      if (!sessionId || !suggestionId) break;

      const ok = promoteBridgeSuggestion(sessionId, suggestionId);
      if (ok) {
        const view = getBridgeSessionView(sessionId);
        if (view) {
          instance.panel.webview.postMessage({
            type: "autoLoopFeedbackDraftUpdated",
            sessionId,
            text: view.workerFeedbackDraft,
          });
        }
      }
      return true;
    }

    case "updateAutoLoopWorkerFeedbackDraft": {
      const sessionId = msg.sessionId as string;
      const text = msg.text as string;
      if (!sessionId) break;
      updateBridgeFeedbackDraft(sessionId, text ?? "");
      return true;
    }

    case "dispatchAutoLoopWorkerFeedback": {
      const sessionId = msg.sessionId as string;
      if (!sessionId) break;

      instance.ctx.log(
        `[AutoLoopHandler] dispatchFeedback: session=${sessionId.slice(0, 8)}`,
      );

      // Get the bridge session to find the connected loop
      const bridgeForDispatch = getBridgeSession(sessionId);
      if (!bridgeForDispatch) {
        instance.ctx.log(`[AutoLoopHandler] dispatchFeedback: bridge not found`);
        break;
      }
      const bridgeLoopId = bridgeForDispatch.getState().workerLoopSessionId;
      const targetLoopId = resolveFeedbackTargetLoopSessionId(bridgeLoopId);

      if (!targetLoopId) {
        instance.ctx.log(
          `[AutoLoopHandler] dispatchFeedback BLOCKED: no pending loop found for bridge loop ${bridgeLoopId.slice(0, 8)}`,
        );
        instance.panel.webview.postMessage({
          type: "autoLoopError",
          sessionId,
          message: "Loop is not waiting for feedback. The worker may still be processing or the loop is disconnected.",
        });
        return true;
      }

      // Check if the loop is actually waiting for feedback
      if (!loopHasPendingFeedback(targetLoopId)) {
        instance.ctx.log(
          `[AutoLoopHandler] dispatchFeedback BLOCKED: loop ${targetLoopId.slice(0, 8)} not awaiting feedback`,
        );
        instance.panel.webview.postMessage({
          type: "autoLoopError",
          sessionId,
          message: "Loop is not waiting for feedback. The worker may still be processing or the loop is disconnected.",
        });
        return true;
      }

      const dispatched = dispatchBridgeFeedback(sessionId);
      instance.ctx.log(
        `[AutoLoopHandler] dispatchFeedback result: dispatched=${dispatched}`,
      );
      if (dispatched) {
        // Route feedback to the actual loop engine
        loopSendFeedback(targetLoopId, dispatched);
        instance.ctx.log(
          `[AutoLoopHandler] Feedback routed to loop ${targetLoopId.slice(0, 8)} (bridge=${bridgeLoopId.slice(0, 8)})`,
        );
        instance.panel.webview.postMessage({
          type: "autoLoopFeedbackDispatched",
          sessionId,
          dispatchedAt: Date.now(),
        });
      }
      return true;
    }

    case "closeAutoLoopBridgeSession": {
      const sessionId = msg.sessionId as string;
      if (!sessionId) break;
      closeBridgeSession(sessionId);
      instance.ctx.log(`[AutoLoopHandler] Session closed: ${sessionId}`);
      return true;
    }

    case "reconnectAutoLoopWorker": {
      const sessionId = msg.sessionId as string;
      if (!sessionId) break;
      const bridge = getBridgeSession(sessionId);
      if (!bridge) {
        instance.ctx.log(`[AutoLoopHandler] reconnect: bridge not found`);
        break;
      }
      const oldLoopId = bridge.getState().workerLoopSessionId;
      const result = await reconnectLoopFromBridge(sessionId, oldLoopId, instance.ctx.log);
      if (!result.launched) {
        instance.ctx.log(`[AutoLoopHandler] ${result.error}`);
      }
      const updatedView = getBridgeSessionView(sessionId);
      if (updatedView) {
        instance.panel.webview.postMessage({
          type: "autoLoopBridgeSessionUpdated",
          session: updatedView,
        });
      }
      return true;
    }

    default:
      return false;
  }

  return true;
}