// ─── Swarm Model Selection & Prompt Builders ──────────────────────────
// Model selection logic and system prompt construction for swarm workers.

import * as vscode from "vscode";
import type { ModelRouter } from "./model-router";
import type { DelegateTaskKind, ModelProfile } from "./model-router-types";
import { TIER_PRIORITY } from "./model-router-types";
import { SPECIALIST_PERSONA } from "./slave-protocol";
import type { SwarmTask } from "./swarm-types";

/** Result of model selection for a swarm worker. */
export interface ModelSelectionResult {
  model: vscode.LanguageModelChat;
  tierLabel: string;
}

/** Filter out virtual selectors (e.g., "auto") that don't have real endpoints. */
function isRealModel(m: vscode.LanguageModelChat): boolean {
  return m.id !== "auto" && !m.id.endsWith("-auto");
}

/**
 * Select the best model for a swarm task.
 * Handles: specific modelId requests, tier ceiling enforcement,
 * ModelRouter auto-selection, and fallback logic.
 */
export async function selectModel(
  task: SwarmTask,
  fallbackModel: vscode.LanguageModelChat,
  modelRouter: ModelRouter,
  log: (msg: string) => void,
): Promise<ModelSelectionResult> {
  let model: vscode.LanguageModelChat = fallbackModel;
  let tierLabel = "unknown";

  // Ensure fallback itself is a real model
  if (!isRealModel(fallbackModel)) {
    const allModels = await vscode.lm.selectChatModels();
    const realFallback = allModels.find(isRealModel);
    if (realFallback) {
      model = realFallback;
      log(
        `[SwarmWorker ${task.id}] Fallback "auto" replaced with: ${realFallback.id}`,
      );
    }
  }

  try {
    // If a specific modelId was requested, use it directly
    if (task.modelId) {
      const exactModels = await vscode.lm.selectChatModels();
      const exact = exactModels.find((m) => m.id === task.modelId);
      if (exact && isRealModel(exact)) {
        model = exact;
        const profiles: Map<string, ModelProfile> = modelRouter.getProfiles();
        tierLabel = profiles.get(exact.id)?.tier ?? task.maxTier ?? "unknown";
        log(
          `[SwarmWorker ${task.id}] Using requested model: ${exact.id} (${tierLabel})`,
        );
      } else {
        log(
          `[SwarmWorker ${task.id}] Requested model "${task.modelId}" not found, falling back`,
        );
      }
    }

    // Fallback to ModelRouter auto-selection if no specific model was set or found
    if (!task.modelId || model === fallbackModel) {
      if (modelRouter.getAvailableModels().length === 0) {
        await modelRouter.discoverModels();
      }

      const taskClassification = modelRouter.classifyTask(
        task.prompt,
        undefined,
      );
      const selection = modelRouter.selectModel(
        taskClassification,
        fallbackModel,
      );
      const profiles: Map<string, ModelProfile> = modelRouter.getProfiles();

      // Enforce tier ceiling
      if (task.maxTier) {
        const result = applyTierCeiling(
          task,
          selection.selectedModel,
          profiles,
          modelRouter,
          log,
        );
        model = result.model;
        tierLabel = result.tierLabel;
      } else {
        model = selection.selectedModel;
        tierLabel = profiles.get(model.id)?.tier ?? "unknown";
      }
    }
  } catch (err) {
    log(
      `[SwarmWorker ${task.id}] Model selection failed, using fallback: ${err}`,
    );
    model = fallbackModel;
  }

  return { model, tierLabel };
}

/** Apply tier ceiling to model selection — find a model within the tier limit. */
function applyTierCeiling(
  task: SwarmTask,
  selectedModel: vscode.LanguageModelChat,
  profiles: Map<string, ModelProfile>,
  modelRouter: ModelRouter,
  log: (msg: string) => void,
): ModelSelectionResult {
  const maxPriority = TIER_PRIORITY[task.maxTier!] ?? 0;
  const modelProfile = profiles.get(selectedModel.id);
  const selectedPriority = TIER_PRIORITY[modelProfile?.tier ?? "ultra"] ?? 4;

  if (selectedPriority > maxPriority) {
    const models = modelRouter.getAvailableModels();
    const capped = models
      .filter((m) => {
        const p = profiles.get(m.id);
        return p && (TIER_PRIORITY[p.tier] ?? 4) <= maxPriority;
      })
      .sort((a, b) => {
        const pa = profiles.get(a.id);
        const pb = profiles.get(b.id);
        return (
          (TIER_PRIORITY[pb?.tier ?? "free"] ?? 0) -
          (TIER_PRIORITY[pa?.tier ?? "free"] ?? 0)
        );
      });

    if (capped.length > 0) {
      return {
        model: capped[0],
        tierLabel: profiles.get(capped[0].id)?.tier ?? task.maxTier!,
      };
    }
    log(
      `[SwarmWorker ${task.id}] No model within tier ceiling "${task.maxTier}", using selected`,
    );
  }

  return {
    model: selectedModel,
    tierLabel: modelProfile?.tier ?? "unknown",
  };
}

// ─── Workspace Block Builder ───────────────────────────────────────────

/** Build workspace context block for swarm worker system prompts. */
export function buildWorkspaceBlock(): string {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  if (!wsPath) return "";

  return [
    "",
    "## WORKSPACE",
    `Project root: ${wsPath}`,
    "",
    "## HOW TO READ SOURCE CODE",
    "Use these virtual tools — they work directly, no shell, no ENOENT:",
    "- `swarm_read_file` — read file contents (filePath relative to project root)",
    "- `swarm_list_dir` — list directory contents",
    "- `swarm_grep` — search for text patterns across files",
    "",
    "Do NOT use `mcp_agent-orchest_copilot_execute_command` for reading files — it fails with ENOENT.",
    "Do NOT try to call `read_file`, `grep_search`, `list_dir`, or `semantic_search` — they don't exist.",
    "",
    "For project memory/docs: use `projectBrain_toolbox` with searchMemory or getContext.",
  ].join("\n");
}

// ─── System Prompt Builder ─────────────────────────────────────────────

/**
 * Build a system prompt for a worker based on task kind.
 * Uses the existing SPECIALIST_PERSONA from slave-protocol.
 */
export function buildWorkerSystemPrompt(
  taskKind: DelegateTaskKind,
  workerId: string,
  hasMailbox: boolean = false,
): string {
  const persona = SPECIALIST_PERSONA[taskKind] ?? SPECIALIST_PERSONA["raw"];

  const base = [
    persona,
    "",
    `You are Worker ${workerId} in a swarm orchestration system.`,
    "You have access to tools. Use them when needed to complete your task.",
    "",
    "RULES:",
    "1. Focus ONLY on your assigned task — do not deviate",
    "2. Use tools efficiently — don't call the same tool twice with the same input",
    "3. Be concise in your final output — the orchestrator aggregates results",
    "4. If you encounter errors, work around them — do not give up",
    "5. Output your result directly — no meta-commentary about the process",
  ];

  if (hasMailbox) {
    base.push(
      "",
      "TEAM COLLABORATION (MANDATORY):",
      "You are working alongside other agents. Use `swarm_mailbox_post` to communicate:",
      '- POST EARLY: After your first 2 tool calls, post a brief update (type="finding") sharing your initial direction and any early insights.',
      '- POST FINDINGS: Whenever you discover something significant, post it immediately (type="finding") — don\'t wait until the end.',
      '- ASK QUESTIONS: If you need input from another worker, post with type="question" and specify the target worker in the "to" field.',
      "- RESPOND: When you receive messages from other workers (injected between rounds), READ THEM and RESPOND via mailbox:",
      '  - Questions → answer with type="finding"',
      '  - Challenges → address with type="consensus" or type="challenge"',
      '  - Findings → acknowledge or build upon with type="consensus"',
      "- The mailbox is the ONLY way workers communicate. If you don't post, others can't benefit from your work.",
    );
  }

  return base.join("\n");
}
