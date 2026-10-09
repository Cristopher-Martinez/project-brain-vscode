import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { HQContext } from "./brain-hq";
import { handleAutoLoopMessage } from "./brain-hq-auto-loop-handler";
import { handleBridgeSettingsMessage } from "./brain-hq-bridge-settings-handler";
import { handleVaultMessage } from "./brain-hq-vault-handler";
import { handleBranchMessage } from "./brain-hq-branch-handler";
import { handleGatewayMessage } from "./brain-hq-gateway-handler";
import { handleLearningMessage } from "./brain-hq-learning-handler";
import { handleLoopMessage } from "./brain-hq-loop-handler";
import { handleModelMessage } from "./brain-hq-model-handler";
import type { McpGateway } from "./mcp-gateway";
import { McpSmokeLoop } from "./mcp-smoke-loop";
import {
  queueOrchTask,
  setOrchConfig,
  setSessionOpen,
  type OrchAgentConfig,
} from "./orchestration-config";
import {
  getAllOrchStates,
  getOrchState,
  orchApproveAllPlans,
  orchApprovePlan,
  orchRejectAllPlans,
  orchRejectPlan,
  orchSendFeedback,
} from "./orchestration-state";
import { getSwarmState } from "./swarm-state";

export interface BrainHqInstance {
  ctx: HQContext;
  panel: vscode.WebviewPanel;
  mcpSmokeLoop: McpSmokeLoop;
  gateway?: McpGateway | null;
  refresh(): Promise<void>;
  sendInitialData(): Promise<void>;
  sendMemoryFiles(): Promise<void>;
  sendSessionHistory(): Promise<void>;
  sendConversationHistory(): Promise<void>;
  searchConversationHistory(
    query: string,
    mode: "search" | "temporal",
  ): Promise<void>;
  setActiveTab(tab: string): void;
  setMcpSmokeStopRequestedByUser(val: boolean): void;
  /** Tab to navigate to on first webviewReady (consumed once). */
  consumePendingTab(): string | undefined;
}

export async function handleBrainHqMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<void> {
  switch (msg.type) {
    case "webviewReady":
      await instance.sendInitialData();
      {
        const pendingTab = instance.consumePendingTab();
        if (pendingTab) {
          instance.panel.webview.postMessage({
            type: "navigateToTab",
            tab: pendingTab,
          });
        }
      }
      break;

    case "webviewError":
      instance.ctx.log(`[BrainHQ] ⚠️ WEBVIEW ERROR: ${msg.error}`);
      break;

    case "refresh":
      await instance.refresh();
      break;

    case "switchTab":
      instance.setActiveTab(msg.tab || "dashboard");
      break;

    case "runCommand":
      if (msg.commandId) {
        await vscode.commands.executeCommand(
          msg.commandId,
          ...(msg.args ?? []),
        );
      }
      break;

    case "openFile": {
      const filePath = msg.filePath as string;
      if (!filePath) break;
      // Resolve relative paths against workspace root
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
            filePath,
          );
      if (fs.existsSync(resolvedPath)) {
        const doc = await vscode.workspace.openTextDocument(resolvedPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
      break;
    }

    case "getMemoryFiles":
      await instance.sendMemoryFiles();
      break;
    case "getSessionHistory":
      await instance.sendSessionHistory();
      break;
    case "getConversationHistory":
      await instance.sendConversationHistory();
      break;
    case "searchConversationHistory":
      await instance.searchConversationHistory(
        msg.query ?? "",
        msg.mode ?? "search",
      );
      break;

    case "requestSwarmState":
      instance.panel.webview.postMessage({
        type: "swarmUpdate",
        data: getSwarmState(),
      });
      break;

    case "requestTabConfig": {
      const saasClient = instance.ctx.getSaasClient?.();
      if (saasClient) {
        try {
          const tabs = await saasClient.fetchTabConfig();
          instance.panel.webview.postMessage({ type: "tabConfig", tabs });
        } catch {
          /* silent — tabs default to visible */
        }
      }
      break;
    }

    case "checkExtensionUpdate": {
      const saasClient = instance.ctx.getSaasClient?.();
      if (!saasClient) {
        instance.panel.webview.postMessage({
          type: "extensionUpdateResult",
          available: false,
          error: "Not connected to server",
        });
        break;
      }
      try {
        const result = await saasClient.checkExtensionUpdate();
        const currentVersion =
          vscode.extensions.getExtension("crismart.project-brain")
            ?.packageJSON?.version ?? "0.0.0";
        const hasUpdate =
          result.available && result.version !== currentVersion;
        instance.panel.webview.postMessage({
          type: "extensionUpdateResult",
          available: hasUpdate,
          currentVersion,
          latestVersion: result.version,
          publishedAt: result.publishedAt,
          changelog: result.changelog,
          size: result.size,
        });
      } catch (e) {
        instance.panel.webview.postMessage({
          type: "extensionUpdateResult",
          available: false,
          error: String(e),
        });
      }
      break;
    }

    case "installExtensionUpdate": {
      const saasClient = instance.ctx.getSaasClient?.();
      if (!saasClient) break;
      instance.panel.webview.postMessage({
        type: "extensionUpdateProgress",
        status: "downloading",
      });
      try {
        const vsixBuffer = await saasClient.downloadExtensionVsix();
        if (!vsixBuffer) {
          instance.panel.webview.postMessage({
            type: "extensionUpdateProgress",
            status: "error",
            error: "Download failed",
          });
          break;
        }
        instance.panel.webview.postMessage({
          type: "extensionUpdateProgress",
          status: "installing",
        });
        // Write VSIX to OS temp dir (cross-platform)
        const os = await import("os");
        const tmpDir = path.join(os.tmpdir(), "project-brain-updates");
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        const vsixPath = path.join(tmpDir, "project-brain-update.vsix");
        fs.writeFileSync(vsixPath, vsixBuffer);
        // Install via VS Code API
        let installSucceeded = false;
        try {
          await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            vscode.Uri.file(vsixPath),
          );
          installSucceeded = true;
        } catch (installErr) {
          // "ScanningExtension" error is expected when the extension replaces itself —
          // the VSIX is extracted but can't be scanned until VS Code reloads.
          const errMsg = String(installErr);
          if (errMsg.includes("ScanningExtension") || errMsg.includes("Cannot read extension")) {
            installSucceeded = true; // Files are installed, just need reload
          } else {
            throw installErr;
          }
        }
        if (installSucceeded) {
          instance.panel.webview.postMessage({
            type: "extensionUpdateProgress",
            status: "done",
          });
          const action = await vscode.window.showInformationMessage(
            "🏴‍☠️ Extension updated! Reload VS Code to apply changes.",
            "Reload Now",
            "Later",
          );
          if (action === "Reload Now") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }
        // Cleanup
        try {
          fs.unlinkSync(vsixPath);
        } catch { /* best effort */ }
      } catch (e) {
        instance.panel.webview.postMessage({
          type: "extensionUpdateProgress",
          status: "error",
          error: String(e),
        });
      }
      break;
    }

    case "startMcpSmokeLoop":
      instance.setMcpSmokeStopRequestedByUser(false);
      instance.mcpSmokeLoop.start();
      instance.panel.webview.postMessage({
        type: "mcpSmokeLoopUpdate",
        data: instance.mcpSmokeLoop.getState(),
      });
      break;

    case "stopMcpSmokeLoop":
      instance.setMcpSmokeStopRequestedByUser(true);
      instance.mcpSmokeLoop.stop();
      break;

    case "getAgentCatalog": {
      const agents = instance.ctx.agentRegistry?.getAgents() ?? [];
      instance.panel.webview.postMessage({
        type: "agentCatalog",
        data: agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          source: a.source,
          defaultTier: a.defaultTier,
          icon: a.icon,
          tools: a.tools,
        })),
      });
      break;
    }

    case "getAvailableModels":
    case "toggleModel":
    case "enableAllModels":
      await handleModelMessage(msg, instance);
      break;

    case "createOrchSession": {
      if (!instance.ctx.agentRegistry || !instance.ctx.modelRouter) {
        instance.ctx.log(
          "[BrainHQ] Cannot create session: missing registry or modelRouter",
        );
        break;
      }
      const goal = msg.goal as string;
      const mode = (msg.mode as string) || "parallel";
      const orchestratorModelId =
        (msg.orchestratorModelId as string) || undefined;
      const teamSlots = msg.team as Array<{
        agentId: string;
        modelId: string;
        tier: string;
      }>;
      const teamConfig: OrchAgentConfig[] = [];
      for (const slot of teamSlots) {
        const agent = instance.ctx.agentRegistry.getAgent(slot.agentId);
        if (!agent) continue;
        teamConfig.push({
          agent,
          modelId: slot.modelId,
          tier: slot.tier as any,
        });
      }
      if (teamConfig.length === 0) {
        instance.ctx.log("[BrainHQ] No valid agents selected");
        break;
      }
      // Generate sessionId for this orchestration
      const sessionId = crypto.randomUUID();
      // Save config to shared state (HQ writes, Chat reads)
      setOrchConfig(sessionId, {
        goal,
        team: teamConfig,
        mode: mode as any,
        orchestratorModelId,
        useMailbox: msg.useMailbox ?? false,
        requiresPlanApproval: msg.requiresPlanApproval ?? false,
        autoApproveLowRisk: msg.autoApproveLowRisk ?? false,
        enhancePrompt: msg.enhancePrompt ?? true,
        useBranchIsolation: msg.useBranchIsolation ?? false,
        preparedAt: Date.now(),
      });
      // Lock session open — mechanical delimiter
      setSessionOpen(sessionId, true);
      instance.ctx.log(
        `[BrainHQ] Orch config saved: ${teamConfig.length} agents, goal="${goal.substring(0, 60)}"`,
      );
      // Fire command to spawn new Copilot Chat session with config
      await vscode.commands.executeCommand(
        "projectBrain.launchOrchSession",
        sessionId,
      );
      break;
    }

    case "addOrchTask": {
      // In the new architecture, tasks are dispatched via Chat (toolbox).
      // HQ can send a notification to the active Chat session.
      const orchTaskSessionId = msg.sessionId as string;
      const prompt = msg.prompt as string;
      if (prompt && orchTaskSessionId) {
        const qSize = queueOrchTask(orchTaskSessionId, prompt);
        instance.ctx.log(`[BrainHQ] Task queued: "${prompt.substring(0, 60)}"`);
        vscode.window.showInformationMessage(
          `🎯 Task queued (#${qSize}): "${prompt.substring(0, 50)}..."`,
        );
      }
      break;
    }

    case "endOrchSession": {
      // User clicked "End Session" in HQ — unlock the mechanical gate
      const endSessionId = msg.sessionId as string;
      if (!endSessionId) break;
      setSessionOpen(endSessionId, false);
      instance.ctx.log("[BrainHQ] Session gate UNLOCKED");
      instance.panel.webview.postMessage({
        type: "orchUpdate",
        data: getOrchState(endSessionId),
      });
      vscode.window.showInformationMessage(
        "🔓 Orchestration session unlocked.",
      );
      break;
    }

    case "requestOrchState": {
      const reqSessionId = (msg.sessionId as string) || "";
      instance.panel.webview.postMessage({
        type: "orchUpdate",
        data: getOrchState(reqSessionId),
      });
      break;
    }

    case "requestAllOrchStates": {
      const allOrch = getAllOrchStates();
      for (const [, state] of allOrch) {
        instance.panel.webview.postMessage({ type: "orchUpdate", data: state });
      }
      break;
    }

    // ─── Loop messages (delegated) ─────────────────────────────────
    // LoopUiState now includes currentLoopIterations for accurate migration display
    case "requestAllLoopStates":
    case "requestHibernatedLoops":
    case "requestFinalizedLoops":
    case "finalizeLoopSession":
    case "deleteFinalizedLoop":
    case "archiveHibernatedLoop":
    case "endLoopSession":
    case "createLoopSession":
    case "requestLoopState":
    case "loopFeedback":
    case "toggleCommitBypass":
    case "toggleAuditBypass":
    case "resumeLoopSession":
    case "discardInterruptedLoop":
    case "requestMailbox":
    case "requestActivityFeed":
    case "sendLoopMailboxMessage":
    case "resolveMailboxMessage":
    case "markLoopDisconnected":
    case "resumeDisconnectedLoop":
    case "loopMigrate":
    case "addIterations":
    case "setMaxCycles":
    case "setLoopMaxCycles":
    case "setLoopMaxCyclesDefault": {
      await handleLoopMessage(msg, instance);
      break;
    }

    case "orchFeedback": {
      const fbSessionId = msg.sessionId as string;
      const feedback = msg.feedback as string;
      if (feedback && fbSessionId) {
        orchSendFeedback(fbSessionId, feedback);
        instance.ctx.log(
          `[BrainHQ] Feedback sent to orchestration agent: ${feedback.substring(0, 80)}...`,
        );
      }
      break;
    }

    case "approvePlan": {
      const apSessionId = msg.sessionId as string;
      const taskId = msg.taskId as string;
      if (taskId && apSessionId) {
        orchApprovePlan(apSessionId, taskId);
        instance.ctx.log(`[BrainHQ] Plan approved: ${taskId}`);
      }
      break;
    }

    case "rejectPlan": {
      const rpSessionId = msg.sessionId as string;
      const taskId = msg.taskId as string;
      const reason = (msg.reason as string) || undefined;
      if (taskId && rpSessionId) {
        orchRejectPlan(rpSessionId, taskId, reason);
        instance.ctx.log(
          `[BrainHQ] Plan rejected: ${taskId}${reason ? ` (${reason})` : ""}`,
        );
      }
      break;
    }

    case "approveAllPlans": {
      const aaSessionId = msg.sessionId as string;
      if (aaSessionId) orchApproveAllPlans(aaSessionId);
      instance.ctx.log("[BrainHQ] All plans approved");
      break;
    }

    case "rejectAllPlans": {
      const raSessionId = msg.sessionId as string;
      const reason = (msg.reason as string) || undefined;
      if (raSessionId) orchRejectAllPlans(raSessionId, reason);
      instance.ctx.log(
        `[BrainHQ] All plans rejected${reason ? ` (${reason})` : ""}`,
      );
      break;
    }

    case "toggleGateway":
    case "requestGatewayState":
    case "createGatewayToken":
    case "revokeGatewayToken":
    case "requestGatewayTokens":
    case "requestGatewayLog":
    case "copyConnectionSnippet": {
      await handleGatewayMessage(msg, instance);
      break;
    }
    // ─── Self-Learning messages (delegated) ──────────────────────
    case "sl:getRepos":
    case "sl:addRepo":
    case "sl:removeRepo":
    case "sl:startPipeline":
    case "sl:retryClone":
    case "sl:vectorizeRepo":
    case "sl:analyzeRepo":
    case "sl:analyzeSingleAgent":
    case "sl:getConfig":
    case "sl:saveConfig":
    case "sl:checkProvider":
    case "sl:cancelOperation":
    case "sl:openAnalysis":
    case "sl:openTemplate":
    case "sl:getAnalysisStatus": {
      await handleLearningMessage(msg, instance);
      break;
    }
    // ─── Auto Loop Bridge (delegated) ────────────────────────────────
    case "requestAutoLoopBridgeState":
    case "createAutoLoopBridgeSession":
    case "selectAutoLoopBridgeSession":
    case "selectAutoLoopSynthesis":
    case "sendAutoLoopPmChat":
    case "promotePmSuggestionToWorkerFeedback":
    case "updateAutoLoopWorkerFeedbackDraft":
    case "dispatchAutoLoopWorkerFeedback":
    case "closeAutoLoopBridgeSession":
    case "reconnectAutoLoopWorker": {
      await handleAutoLoopMessage(msg, instance);
      break;
    }

    // ─── Vault (credential storage) ─────────────────────────────────
    case "vault:getEntries":
    case "vault:init":
    case "vault:upsert":
    case "vault:remove":
    case "vault:ensureGitignore":
    case "vault:openFile": {
      await handleVaultMessage(msg, instance);
      break;
    }

    // ─── Bridge Settings (Phase F) ───────────────────────────────────
    case "requestBridgeProviders":
    case "requestBridgeModels":
    case "setBridgeDefaultProvider":
    case "validateBridgeProvider":
    case "saveBridgeApiKey":
    case "requestBridgeModelCatalog":
    case "saveBridgeEnabledModels": {
      const _post = (m: unknown) => instance.panel.webview.postMessage(m);
      await handleBridgeSettingsMessage(msg, _post);
      break;
    }

    // ─── Context Enricher ────────────────────────────────────────────
    case "enrichGoal":
    case "enrichFeedback":
    case "setEnrichMode": {
      const { handleEnricherMessage } = await import("./brain-hq-enricher-handler");
      await handleEnricherMessage(msg, instance);
      break;
    }

    // ─── Branch Isolation / Merge Gate (delegated) ───────────────────
    default: {
      // Delegate to branch handler for merge gate messages
      await handleBranchMessage(msg, instance);
      break;
    }
  }
}
