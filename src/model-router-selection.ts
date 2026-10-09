import * as vscode from "vscode";
import {
  MIN_TIER_FOR_COMPLEXITY,
  ModelProfile,
  ModelTier,
  RoutingDecision,
  TaskClassification,
  TIER_MAP,
  TIER_PRIORITY,
} from "./model-router-types";

interface ModelCandidate {
  model: vscode.LanguageModelChat;
  profile: ModelProfile;
}

export interface SelectModelParams {
  availableModels: vscode.LanguageModelChat[];
  profiles: Map<string, ModelProfile>;
  task: TaskClassification;
  fallbackModel: vscode.LanguageModelChat;
  overrideMinTier?: ModelTier;
  minSamples: number;
  successThreshold: number;
  log: (msg: string) => void;
}

export interface NextTierParams {
  currentModel: vscode.LanguageModelChat;
  failedModels: Set<string>;
  maxTier: ModelTier | undefined;
  availableModels: vscode.LanguageModelChat[];
  profiles: Map<string, ModelProfile>;
}

export function detectTier(
  model: vscode.LanguageModelChat,
  log: (msg: string) => void,
): ModelTier {
  if (TIER_MAP[model.family]) {
    return TIER_MAP[model.family];
  }

  const familyLower = model.family.toLowerCase();
  for (const [pattern, tier] of Object.entries(TIER_MAP)) {
    if (familyLower.includes(pattern.toLowerCase())) {
      return tier;
    }
  }

  if (model.vendor === "copilot") {
    return "standard";
  }

  log(
    `[ModelRouter] Unknown family "${model.family}" — defaulting to standard`,
  );
  return "standard";
}

export function inferCapabilities(tier: ModelTier): string[] {
  switch (tier) {
    case "ultra":
      return [
        "code",
        "reasoning",
        "creative",
        "architecture",
        "debugging",
        "security",
        "expert",
      ];
    case "premium":
      return [
        "code",
        "reasoning",
        "creative",
        "architecture",
        "debugging",
        "security",
      ];
    case "standard":
      return ["code", "reasoning", "creative", "debugging"];
    case "cheap":
      return ["code", "simple-qa", "documentation"];
    case "free":
      return ["simple-qa", "formatting"];
  }
}

export function selectModel(params: SelectModelParams): RoutingDecision {
  const {
    availableModels,
    profiles,
    task,
    fallbackModel,
    overrideMinTier,
    minSamples,
    successThreshold,
    log,
  } = params;

  if (availableModels.length === 0) {
    log("[ModelRouter] No discovered models — using fallback");
    return {
      selectedModel: fallbackModel,
      task,
      reason: "No models discovered — using user's selected model",
      wasEscalated: false,
    };
  }

  const minTier = overrideMinTier ?? MIN_TIER_FOR_COMPLEXITY[task.complexity];
  const minPriority = TIER_PRIORITY[minTier];
  const eligible = getEligibleModels(availableModels, profiles, minPriority);

  if (eligible.length === 0) {
    log(`[ModelRouter] No eligible models for tier>=${minTier} — using fallback`);
    return {
      selectedModel: fallbackModel,
      task,
      reason: `No models at tier>=${minTier} — using fallback`,
      wasEscalated: false,
    };
  }

  for (const candidate of eligible) {
    const historyKey = task.type;
    const successRate = candidate.profile.successRate[historyKey];
    const historyCount = candidate.profile.performanceHistory.filter(
      (h) => h.taskType === historyKey,
    ).length;

    if (
      historyCount >= minSamples &&
      successRate !== undefined &&
      successRate < successThreshold
    ) {
      log(
        `[ModelRouter] Skipping ${candidate.profile.id} for ${historyKey}: ${(successRate * 100).toFixed(0)}% success — escalating`,
      );
      continue;
    }

    const wasEscalated = TIER_PRIORITY[candidate.profile.tier] > minPriority;
    log(
      `[ModelRouter] Selected: ${candidate.profile.id} (${candidate.profile.tier}) for ${task.type}/${task.complexity}${wasEscalated ? " [ESCALATED]" : ""}`,
    );
    return {
      selectedModel: candidate.model,
      task,
      reason: `${candidate.profile.tier} model for ${task.complexity} ${task.type}${wasEscalated ? " (escalated)" : ""}`,
      wasEscalated,
    };
  }

  const best = eligible[eligible.length - 1];
  log(`[ModelRouter] All poor history — using best: ${best.profile.id}`);
  return {
    selectedModel: best.model,
    task,
    reason: "All models had poor history — using highest tier",
    wasEscalated: true,
  };
}

export function prioritizeTools(
  tools: vscode.LanguageModelChatTool[],
  max: number,
): vscode.LanguageModelChatTool[] {
  const priority: [string, number][] = [
    ["projectBrain_", 0],
    ["mcp_rag-docs_", 1],
    ["copilot_", 2],
    ["mcp_github_", 3],
    ["mcp_gitkraken_", 4],
    ["mcp_console-ninja_", 5],
  ];

  const scored = tools.map((tool) => {
    const rank = priority.find(([prefix]) => tool.name.startsWith(prefix));
    return { tool, score: rank ? rank[1] : 6 };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((entry) => entry.tool);
}

export function findNextTierModel(
  params: NextTierParams,
): vscode.LanguageModelChat | null {
  const {
    currentModel,
    failedModels,
    maxTier,
    availableModels,
    profiles,
  } = params;
  const currentProfile = profiles.get(currentModel.id);
  if (!currentProfile) return null;

  const currentPriority = TIER_PRIORITY[currentProfile.tier];
  const maxPriority = maxTier ? TIER_PRIORITY[maxTier] : TIER_PRIORITY.ultra;
  const candidates = availableModels
    .map((model) => ({ model, profile: profiles.get(model.id) }))
    .filter((entry): entry is ModelCandidate => {
      if (!entry.profile) return false;
      if (failedModels.has(entry.model.id)) return false;
      const priority = TIER_PRIORITY[entry.profile.tier];
      return priority >= currentPriority && priority <= maxPriority;
    })
    .sort((a, b) => {
      const aPriority = TIER_PRIORITY[a.profile.tier];
      const bPriority = TIER_PRIORITY[b.profile.tier];
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.profile.avgResponseQuality - a.profile.avgResponseQuality;
    });

  for (const candidate of candidates) {
    if (candidate.model.id !== currentModel.id) {
      return candidate.model;
    }
  }
  return null;
}

function getEligibleModels(
  availableModels: vscode.LanguageModelChat[],
  profiles: Map<string, ModelProfile>,
  minPriority: number,
): ModelCandidate[] {
  return availableModels
    .map((model) => ({ model, profile: profiles.get(model.id) }))
    .filter((entry): entry is ModelCandidate => {
      return entry.profile != null && TIER_PRIORITY[entry.profile.tier] >= minPriority;
    })
    .sort((a, b) => {
      const tierDiff = TIER_PRIORITY[a.profile.tier] - TIER_PRIORITY[b.profile.tier];
      if (tierDiff !== 0) return tierDiff;
      return b.profile.avgResponseQuality - a.profile.avgResponseQuality;
    });
}
