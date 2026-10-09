/** Brain HQ — Loop message handlers. */

import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  pushActivityToWebview,
  startActivityWatcher,
  stopActivityWatcher,
} from "./brain-hq-activity-bridge";
import { handleEndLoopBranchIsolation } from "./brain-hq-branch-lifecycle";
import {
  handleToggleAuditBypass,
  handleToggleCommitBypass,
} from "./brain-hq-bypass-handler";
import {
  checkAndNotifyNewMessages,
  pushMailboxToWebview,
  startMailboxWatcher,
  stopMailboxWatcher,
} from "./brain-hq-mailbox-bridge";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { readCommitState, writeCommitState } from "./commit-session-ops";
import { readLoopConfig, updateLoopConfig } from "./loop-config";
import {
  getAllLoopStates,
  getLoopState,
  loopReconnect,
  loopReset,
  loopSendFeedback,
  loopSetCommitBypass,
  loopSpawn,
  markLoopDisconnected,
  setLoopMaxCycles,
  setLoopSessionOpen,
} from "./loop-engine";
import { appendFeedbackImages } from "./loop-feedback-images";
import { deleteHibernatedLoop, listHibernatedLoops } from "./loop-hibernate";
import { deleteFinalizedLoop, listFinalizedLoops, saveFinalized } from "./loop-finalize";
import { cleanupFeedbackImages } from "./loop-image-parts";
import { executeMigration } from "./loop-migration";
import { clearPersistedSession } from "./loop-persistence";
import { detectInterruptedLoops } from "./loop-recovery";

/** Handle all loop-related messages from the webview. Returns true if handled. */
export async function handleLoopMessage(
  msg: any,
  instance: BrainHqInstance,
): Promise<boolean> {
  switch (msg.type) {
    case "requestAllLoopStates": {
      // In-memory (live) loops
      const allLoops = getAllLoopStates();
      const wsRootAll = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      for (const [sid, state] of allLoops) {
        instance.panel.webview.postMessage({ type: "loopUpdate", data: state });
        if (wsRootAll) {
          pushMailboxToWebview(wsRootAll, sid, instance);
          startMailboxWatcher(wsRootAll, sid, instance);
          pushActivityToWebview(wsRootAll, sid, instance);
          startActivityWatcher(wsRootAll, sid, instance);
        }
      }
      // Interrupted loops (persisted but not live)
      try {
        const interrupted = detectInterruptedLoops();
        if (interrupted.length > 0) {
          instance.panel.webview.postMessage({
            type: "interruptedLoops",
            data: interrupted,
          });
        }
      } catch {
        /* non-fatal — if persistence is uninitialized, skip */
      }
      return true;
    }

    case "resumeLoopSession": {
      const rlSessionId = msg.sessionId as string;
      if (!rlSessionId) {
        instance.ctx.log("[BrainHQ] resumeLoopSession — no sessionId");
        return true;
      }
      try {
        const reconnectResult = loopReconnect(rlSessionId);
        if (!reconnectResult.ok) {
          instance.ctx.log(
            `[BrainHQ] resumeLoopSession — reconnect failed for ${rlSessionId}`,
          );
          vscode.window.showErrorMessage(
            `No se pudo restaurar el loop ${rlSessionId.substring(0, 8)}.`,
          );
          return true;
        }
        setLoopSessionOpen(rlSessionId, true);
        instance.ctx.log(
          `[BrainHQ] Loop session resumed from HQ: ${rlSessionId}`,
        );
        // Notify webview with restored state
        instance.panel.webview.postMessage({
          type: "loopUpdate",
          data: getLoopState(rlSessionId),
        });
        // Refresh interrupted list (this session is now live, so excluded)
        try {
          const updated = detectInterruptedLoops();
          instance.panel.webview.postMessage({
            type: "interruptedLoops",
            data: updated,
          });
        } catch {
          /* non-fatal */
        }
        // Launch chat for user to continue the loop
        await vscode.commands.executeCommand(
          "projectBrain.launchLoopSession",
          rlSessionId,
          reconnectResult.goal ?? "Loop reanudado",
        );
      } catch (err) {
        instance.ctx.log(`[BrainHQ] resumeLoopSession error: ${err}`);
        vscode.window.showErrorMessage(
          `No se pudo reanudar el loop: ${err instanceof Error ? err.message : err}`,
        );
      }
      return true;
    }

    case "requestHibernatedLoops": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        const hibernated = listHibernatedLoops(wsRoot).map((h) => ({
          sessionId: h.sessionId,
          goal: h.goal || "(sin objetivo)",
          currentRound: h.currentRound ?? 0,
          branchName: h.branchName,
          hibernatedAt: h.hibernatedAt,
          summary: h.summary || "",
        }));
        instance.panel.webview.postMessage({
          type: "hibernatedLoops",
          data: hibernated,
        });
      }
      return true;
    }

    case "requestFinalizedLoops": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        const finalized = listFinalizedLoops(wsRoot).map((f) => ({
          sessionId: f.sessionId,
          goal: f.goal || "(sin objetivo)",
          totalRounds: f.totalRounds ?? 0,
          branchName: f.branchName,
          finalizedAt: f.finalizedAt,
          summary: f.summary || "",
        }));
        instance.panel.webview.postMessage({
          type: "finalizedLoops",
          data: finalized,
        });
      }
      return true;
    }

    case "finalizeLoopSession": {
      const fSessionId = msg.sessionId as string;
      if (!fSessionId) {
        instance.ctx.log("[BrainHQ] finalizeLoopSession — no sessionId");
        return true;
      }
      const fState = getLoopState(fSessionId);
      const fWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (fWsRoot && fState.sessionId) {
        saveFinalized(fWsRoot, {
          sessionId: fSessionId,
          goal: fState.goal || "(sin objetivo)",
          totalRounds: fState.currentLoopIterations ?? 0,
          branchName: fState.branchIsolation?.branchName,
          finalizedAt: Date.now(),
          summary: fState.pendingSynthesis || fState.iterations?.at(-1)?.synthesis || fState.goal || "",
        });
        const updated = listFinalizedLoops(fWsRoot).map((f) => ({
          sessionId: f.sessionId,
          goal: f.goal || "(sin objetivo)",
          totalRounds: f.totalRounds ?? 0,
          branchName: f.branchName,
          finalizedAt: f.finalizedAt,
          summary: f.summary || "",
        }));
        instance.panel.webview.postMessage({
          type: "finalizedLoops",
          data: updated,
        });
      }
      return true;
    }

    case "deleteFinalizedLoop": {
      const dfSessionId = msg.sessionId as string;
      if (!dfSessionId) {
        instance.ctx.log("[BrainHQ] deleteFinalizedLoop — no sessionId");
        return true;
      }
      const dfWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (dfWsRoot) {
        deleteFinalizedLoop(dfWsRoot, dfSessionId);
        const updated = listFinalizedLoops(dfWsRoot).map((f) => ({
          sessionId: f.sessionId,
          goal: f.goal || "(sin objetivo)",
          totalRounds: f.totalRounds ?? 0,
          branchName: f.branchName,
          finalizedAt: f.finalizedAt,
          summary: f.summary || "",
        }));
        instance.panel.webview.postMessage({
          type: "finalizedLoops",
          data: updated,
        });
      }
      return true;
    }

    case "archiveHibernatedLoop": {
      const ahSessionId = msg.sessionId as string;
      if (!ahSessionId) {
        instance.ctx.log("[BrainHQ] archiveHibernatedLoop — no sessionId");
        return true;
      }
      const ahWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (ahWsRoot) {
        // Find the hibernated loop data
        const hLoop = listHibernatedLoops(ahWsRoot).find(
          (h) => h.sessionId === ahSessionId,
        );
        if (hLoop) {
          saveFinalized(ahWsRoot, {
            sessionId: hLoop.sessionId,
            goal: hLoop.goal || "(sin objetivo)",
            totalRounds: hLoop.currentRound ?? 0,
            branchName: hLoop.branchName,
            finalizedAt: Date.now(),
            summary: hLoop.summary || hLoop.goal || "",
          });
          deleteHibernatedLoop(ahWsRoot, ahSessionId);
          instance.ctx.log(
            `[BrainHQ] Hibernated loop archived to finalized: ${ahSessionId.substring(0, 8)}`,
          );
          // Refresh both lists
          const updatedH = listHibernatedLoops(ahWsRoot).map((h) => ({
            sessionId: h.sessionId,
            goal: h.goal || "(sin objetivo)",
            currentRound: h.currentRound ?? 0,
            branchName: h.branchName,
            hibernatedAt: h.hibernatedAt,
            summary: h.summary || "",
          }));
          instance.panel.webview.postMessage({
            type: "hibernatedLoops",
            data: updatedH,
          });
          const updatedF = listFinalizedLoops(ahWsRoot).map((f) => ({
            sessionId: f.sessionId,
            goal: f.goal || "(sin objetivo)",
            totalRounds: f.totalRounds ?? 0,
            branchName: f.branchName,
            finalizedAt: f.finalizedAt,
            summary: f.summary || "",
          }));
          instance.panel.webview.postMessage({
            type: "finalizedLoops",
            data: updatedF,
          });
        }
      }
      return true;
    }

    case "discardInterruptedLoop": {
      const diSessionId = msg.sessionId as string;
      if (!diSessionId) {
        instance.ctx.log("[BrainHQ] discardInterruptedLoop — no sessionId");
        return true;
      }
      clearPersistedSession(diSessionId);
      loopReset(diSessionId);
      cleanupFeedbackImages(diSessionId, (m) => instance.ctx.log(m));
      instance.ctx.log(`[BrainHQ] Interrupted loop discarded: ${diSessionId}`);
      // Refresh interrupted loops list
      try {
        const updated = detectInterruptedLoops();
        instance.panel.webview.postMessage({
          type: "interruptedLoops",
          data: updated,
        });
      } catch {
        /* non-fatal */
      }
      return true;
    }

    case "endLoopSession": {
      const elSessionId = msg.sessionId as string;
      if (!elSessionId) {
        instance.ctx.log("[BrainHQ] endLoopSession — no sessionId, ignoring");
        return true;
      }
      // Snapshot state BEFORE reset for finalization
      const elState = getLoopState(elSessionId);
      const hadBranch = await handleEndLoopBranchIsolation(
        elSessionId,
        (m) => instance.ctx.log(m),
        (m) => instance.panel.webview.postMessage(m),
      );
      const elWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // Save to finalized archive
      if (elWsRoot && elState.sessionId) {
        saveFinalized(elWsRoot, {
          sessionId: elSessionId,
          goal: elState.goal || "(sin objetivo)",
          totalRounds: elState.currentLoopIterations ?? 0,
          branchName: elState.branchIsolation?.branchName,
          finalizedAt: Date.now(),
          summary: elState.pendingSynthesis || elState.iterations?.at(-1)?.synthesis || elState.goal || "",
        });
      }
      setLoopSessionOpen(elSessionId, false);
      loopReset(elSessionId);
      cleanupFeedbackImages(elSessionId, (m) => instance.ctx.log(m));
      if (elWsRoot) stopMailboxWatcher(elWsRoot, elSessionId);
      if (elWsRoot) stopActivityWatcher(elWsRoot, elSessionId);
      instance.ctx.log(
        `[BrainHQ] Loop session ${elSessionId} ended by user from HQ`,
      );
      instance.panel.webview.postMessage({
        type: "loopUpdate",
        data: { ...getLoopState(elSessionId), state: "completed" },
      });
      // Refresh finalized list
      if (elWsRoot) {
        const updated = listFinalizedLoops(elWsRoot).map((f) => ({
          sessionId: f.sessionId,
          goal: f.goal || "(sin objetivo)",
          totalRounds: f.totalRounds ?? 0,
          branchName: f.branchName,
          finalizedAt: f.finalizedAt,
          summary: f.summary || "",
        }));
        instance.panel.webview.postMessage({
          type: "finalizedLoops",
          data: updated,
        });
      }
      vscode.window.showInformationMessage(
        hadBranch
          ? "🔓 Loop finalizado — branch pendiente de merge/discard en Brain HQ."
          : "🔓 Loop finalizado — el agente puede cerrar la sesión.",
      );
      return true;
    }

    case "createLoopSession": {
      const loopGoal = msg.goal as string;
      if (!loopGoal) {
        instance.ctx.log(
          "[BrainHQ] Cannot create loop session: no goal provided",
        );
        return true;
      }
      const clSessionId = crypto.randomUUID();
      setLoopSessionOpen(clSessionId, true);
      loopSpawn(clSessionId, loopGoal);

      // Set commitBypass — default is ON (gate off), user can activate gate
      const defaultBypass = vscode.workspace
        .getConfiguration("projectBrain")
        .get<boolean>("defaultCommitBypass", true);
      const shouldBypass = msg.commitBypass ?? defaultBypass;
      {
        const folders = vscode.workspace.workspaceFolders;
        const cwd = folders?.[0]?.uri.fsPath ?? process.cwd();
        const initial = readCommitState(cwd, clSessionId) ?? {
          editedSinceCommit: [],
          lastCommitTs: 0,
          lastSuggestionTs: null,
          commitCount: 0,
          suppressUntilFeedback: false,
        };
        initial.commitBypass = shouldBypass;
        writeCommitState(cwd, clSessionId, initial);
        loopSetCommitBypass(clSessionId, shouldBypass);
      }

      instance.ctx.log(
        `[BrainHQ] Loop session created: id=${clSessionId} goal="${loopGoal.substring(0, 60)}"`,
      );
      try {
        await vscode.commands.executeCommand(
          "projectBrain.launchLoopSession",
          clSessionId,
          loopGoal,
          msg.useBranchIsolation ?? false,
          msg.baseBranch,
        );
      } catch (err) {
        instance.ctx.log(`[BrainHQ] Loop launch failed: ${err}`);
        instance.panel.webview.postMessage({
          type: "loopUpdate",
          data: {
            ...getLoopState(clSessionId),
            state: "completed",
            goal: `❌ Error al lanzar: ${err instanceof Error ? err.message : err}`,
          },
        });
        return true;
      }
      // Watchdog: if agent hasn't connected after 20s, notify webview
      setTimeout(() => {
        const current = getLoopState(clSessionId);
        if (current.state === "spawning") {
          instance.ctx.log(
            `[BrainHQ] Loop spawn timeout — agent did not connect: ${clSessionId}`,
          );
          instance.panel.webview.postMessage({
            type: "loopSpawnTimeout",
            sessionId: clSessionId,
          });
        }
      }, 20_000);

      // Start watchers for the new session
      const clWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (clWsRoot) {
        startMailboxWatcher(clWsRoot, clSessionId, instance);
        startActivityWatcher(clWsRoot, clSessionId, instance);
      }

      return true;
    }

    case "requestLoopState": {
      const rlsSessionId = msg.sessionId as string;
      if (rlsSessionId) {
        instance.panel.webview.postMessage({
          type: "loopUpdate",
          data: getLoopState(rlsSessionId),
        });
      } else {
        instance.ctx.log("[BrainHQ] requestLoopState — no sessionId");
      }
      return true;
    }

    case "loopFeedback": {
      const lfSessionId = msg.sessionId as string;
      const loopFb = msg.feedback as string;
      const loopImages = (msg.images as string[] | undefined) || [];
      if (lfSessionId && (loopFb || loopImages.length > 0)) {
        // Guard: reject feedback to disconnected loops
        const lfState = getLoopState(lfSessionId);
        if (lfState.state === "disconnected") {
          instance.ctx.log(
            `[BrainHQ] loopFeedback REJECTED — loop ${lfSessionId.substring(0, 8)} is disconnected`,
          );
          instance.panel.webview.postMessage({
            type: "loopUpdate",
            data: lfState,
          });
          return true;
        }
        const augmented = appendFeedbackImages(
          loopFb || "",
          loopImages,
          lfSessionId,
          instance.ctx.log.bind(instance.ctx),
        );
        loopSendFeedback(
          lfSessionId,
          augmented,
          loopImages.length > 0 ? loopImages.length : undefined,
        );
        instance.ctx.log(
          `[BrainHQ] Loop feedback sent for session ${lfSessionId} (${loopImages.length} imgs): ${(loopFb || "").substring(0, 80)}...`,
        );
      } else {
        instance.ctx.log(
          `[BrainHQ] loopFeedback — missing sessionId or feedback`,
        );
      }
      return true;
    }

    case "loopMigrate": {
      const migrateSessionId = msg.sessionId as string;
      const migrateFeedback = msg.feedback as string;
      if (migrateSessionId && migrateFeedback) {
        instance.ctx.log(
          `[BrainHQ] Loop migration requested for ${migrateSessionId}`,
        );
        executeMigration(migrateSessionId, migrateFeedback).then((ok) => {
          if (!ok) {
            instance.ctx.log(
              `[BrainHQ] Migration failed for ${migrateSessionId}`,
            );
          }
        });
      } else {
        instance.ctx.log(
          `[BrainHQ] loopMigrate — missing sessionId or feedback`,
        );
      }
      return true;
    }

    case "setLoopMaxCycles": {
      const mcSessionId = msg.sessionId as string;
      const mcMaxCycles = msg.maxCycles as number;
      if (mcSessionId && typeof mcMaxCycles === "number" && mcMaxCycles > 0) {
        setLoopMaxCycles(mcSessionId, mcMaxCycles);
        instance.ctx.log(
          `[BrainHQ] maxCycles set to ${mcMaxCycles} for ${mcSessionId}`,
        );
      }
      return true;
    }

    case "addIterations": {
      const aiSessionId = msg.sessionId as string;
      const amount = msg.amount as number;
      if (aiSessionId && typeof amount === "number" && amount > 0) {
        const state = getLoopState(aiSessionId);
        // Config file is the single source of truth for maxCycles
        const config = readLoopConfig(aiSessionId);
        const globalDefault = vscode.workspace
          .getConfiguration("projectBrain")
          .get<number>("loop.maxCycles", 15);
        const currentMax =
          config?.maxCycles ?? state?.maxCycles ?? globalDefault;
        const newMax = currentMax + amount;
        setLoopMaxCycles(aiSessionId, newMax);
        instance.ctx.log(
          `[BrainHQ] addIterations +${amount} → maxCycles=${newMax} for ${aiSessionId}`,
        );
      }
      return true;
    }

    case "setMaxCycles": {
      const smSessionId = msg.sessionId as string;
      const smMaxCycles = msg.maxCycles as number;
      if (smSessionId && typeof smMaxCycles === "number" && smMaxCycles > 0) {
        setLoopMaxCycles(smSessionId, smMaxCycles);
        instance.ctx.log(
          `[BrainHQ] setMaxCycles=${smMaxCycles} for ${smSessionId}`,
        );
      }
      return true;
    }

    case "setLoopMaxCyclesDefault": {
      const newDefault = msg.maxCycles as number;
      if (
        typeof newDefault === "number" &&
        newDefault >= 3 &&
        newDefault <= 100
      ) {
        await vscode.workspace
          .getConfiguration("projectBrain")
          .update(
            "loop.maxCycles",
            newDefault,
            vscode.ConfigurationTarget.Global,
          );
        instance.ctx.log(
          `[BrainHQ] loop.maxCycles default updated to ${newDefault}`,
        );
        await instance.panel.webview.postMessage({
          type: "loopMaxCyclesDefaultUpdate",
          maxCycles: newDefault,
        });
      }
      return true;
    }

    case "toggleCommitBypass":
      return handleToggleCommitBypass(msg, instance);

    case "toggleAuditBypass":
      return handleToggleAuditBypass(msg, instance);

    case "requestMailbox": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot && msg.sessionId) {
        pushMailboxToWebview(wsRoot, msg.sessionId, instance);
        startMailboxWatcher(wsRoot, msg.sessionId, instance);
      }
      return true;
    }

    case "requestActivityFeed": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot && msg.sessionId) {
        pushActivityToWebview(wsRoot, msg.sessionId, instance);
        startActivityWatcher(wsRoot, msg.sessionId, instance);
      }
      return true;
    }

    case "sendLoopMailboxMessage": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot && msg.sessionId && msg.content) {
        const { sendUserMessage } = await import("./loop-control");
        sendUserMessage(wsRoot, msg.sessionId, msg.content);
        pushMailboxToWebview(wsRoot, msg.sessionId, instance);
        checkAndNotifyNewMessages(wsRoot, msg.sessionId);
      }
      return true;
    }

    case "resolveMailboxMessage": {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot && msg.sessionId && msg.messageId) {
        const { resolveMessage } = await import("./loop-mailbox");
        resolveMessage(wsRoot, msg.messageId);
        pushMailboxToWebview(wsRoot, msg.sessionId, instance);
      }
      return true;
    }

    case "markLoopDisconnected": {
      const mdSessionId = msg.sessionId as string;
      if (!mdSessionId) return true;
      markLoopDisconnected(mdSessionId);
      instance.panel.webview.postMessage({
        type: "loopUpdate",
        data: getLoopState(mdSessionId),
      });
      instance.ctx.log(
        `[BrainHQ] Loop manually marked disconnected: ${mdSessionId.substring(0, 8)}`,
      );
      return true;
    }

    case "resumeDisconnectedLoop": {
      const rdSessionId = msg.sessionId as string;
      if (!rdSessionId) return true;
      const rdState = getLoopState(rdSessionId);
      const rdGoal = rdState.goal ?? rdSessionId;
      const lastSynthesis =
        rdState.iterations?.[rdState.iterations.length - 1]?.synthesis;
      // Remove disconnected loop from state
      loopReset(rdSessionId);
      instance.panel.webview.postMessage({
        type: "loopUpdate",
        data: {
          sessionId: rdSessionId,
          state: "idle" as const,
          iterations: [],
          updatedAt: Date.now(),
          awaitingFeedback: false,
        },
      });
      // Spawn new loop with reconnect context
      const newSessionId = crypto.randomUUID();
      const originalHistoryPath = `.project-brain/loops/${rdSessionId}/history.json`;
      const reconnectGoal =
        `[RECONEXIÓN] Objetivo original: ${rdGoal}` +
        `\nPRIMERA ACCIÓN OBLIGATORIA: llama hydrateLoopContext({ sessionId: \"${newSessionId}\", mode: \"summary\" }) antes de responder.` +
        `\nRuta exacta del historial del loop original: ${originalHistoryPath}` +
        `\nIMPORTANTE: Lee ESE archivo para ver todas las iteraciones previas. ` +
        `No uses el history.json del loop nuevo de reconexión.` +
        `${lastSynthesis ? `\nÚltima síntesis: ${lastSynthesis.substring(0, 300)}` : ""}`;
      setLoopSessionOpen(newSessionId, true);
      loopSpawn(newSessionId, reconnectGoal);
      updateLoopConfig(newSessionId, { sourceSessionId: rdSessionId });
      instance.ctx.log(
        `[BrainHQ] Reconnect loop spawned: ${newSessionId.substring(0, 8)} from disconnected ${rdSessionId.substring(0, 8)}`,
      );
      try {
        await vscode.commands.executeCommand(
          "projectBrain.launchLoopSession",
          newSessionId,
          reconnectGoal,
          false,
        );
      } catch (err) {
        instance.ctx.log(`[BrainHQ] Reconnect launch failed: ${err}`);
      }
      return true;
    }

    default:
      return false;
  }
}
