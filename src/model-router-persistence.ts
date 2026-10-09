import * as vscode from "vscode";
import { AdaptiveLatencyTracker } from "./adaptive-latency";
import {
  ModelProfile,
  RoutingDecision,
  TaskClassification,
  TaskResult,
} from "./model-router-types";

export interface PerformanceContext {
  profiles: Map<string, ModelProfile>;
  performanceLog: TaskResult[];
  maxHistoryEntries: number;
  latencyTracker?: AdaptiveLatencyTracker;
  log: (msg: string) => void;
}

export function recordResult(
  ctx: PerformanceContext,
  decision: RoutingDecision,
  startTime: number,
  responseText: string,
): void {
  const responseTimeMs = Date.now() - startTime;
  const qualityScore = evaluateQuality(decision.task, responseText);
  const success = qualityScore >= 0.5;

  const result: TaskResult = {
    taskType: decision.task.type,
    complexity: decision.task.complexity,
    modelId: decision.selectedModel.id,
    modelFamily: decision.selectedModel.family,
    timestamp: Date.now(),
    success,
    qualityScore,
    responseTimeMs,
    responseLength: responseText.length,
    hadCodeBlocks: /```[\s\S]*?```/.test(responseText),
    escalated: decision.wasEscalated,
  };

  const profile = ctx.profiles.get(decision.selectedModel.id);
  if (profile) {
    profile.performanceHistory.push(result);

    if (profile.performanceHistory.length > ctx.maxHistoryEntries) {
      profile.performanceHistory = profile.performanceHistory.slice(
        -ctx.maxHistoryEntries,
      );
    }

    const typeHistory = profile.performanceHistory.filter(
      (h) => h.taskType === result.taskType,
    );
    profile.successRate[result.taskType] =
      typeHistory.filter((h) => h.success).length / typeHistory.length;

    const allQualities = profile.performanceHistory.map((h) => h.qualityScore);
    profile.avgResponseQuality =
      allQualities.reduce((a, b) => a + b, 0) / allQualities.length;
  }

  ctx.performanceLog.push(result);
  if (ctx.performanceLog.length > ctx.maxHistoryEntries * 2) {
    ctx.performanceLog.splice(0, ctx.performanceLog.length - ctx.maxHistoryEntries);
  }

  if (ctx.latencyTracker) {
    const predicted = ctx.latencyTracker.getExpectedHierarchical(
      decision.selectedModel.id,
      decision.task.type,
    );
    ctx.latencyTracker.record(decision.selectedModel.id, responseTimeMs);
    ctx.latencyTracker.record(
      `${decision.selectedModel.id}:${decision.task.type}`,
      responseTimeMs,
    );
    ctx.log(
      `[ModelRouter] Latency: actual=${responseTimeMs}ms, predicted=${predicted.ms.toFixed(0)}ms (confident=${predicted.confident})`,
    );
  }

  ctx.log(
    `[ModelRouter] Result: ${decision.selectedModel.id} → quality=${qualityScore.toFixed(2)}, success=${success}, time=${responseTimeMs}ms`,
  );
}

export async function savePerformanceData(
  extensionContext: vscode.ExtensionContext,
  profiles: Map<string, ModelProfile>,
  performanceLog: TaskResult[],
  log: (msg: string) => void,
): Promise<void> {
  try {
    const data = {
      profiles: Object.fromEntries(
        [...profiles.entries()].map(([id, profile]) => [
          id,
          {
            id: profile.id,
            family: profile.family,
            vendor: profile.vendor,
            tier: profile.tier,
            successRate: profile.successRate,
            avgResponseQuality: profile.avgResponseQuality,
            historyCount: profile.performanceHistory.length,
          },
        ]),
      ),
      recentResults: performanceLog.slice(-100),
      lastUpdated: new Date().toISOString(),
    };
    await extensionContext.globalState.update("modelRouter.performanceData", data);
  } catch (err) {
    log(`[ModelRouter] Failed to save: ${err}`);
  }
}

export function loadPerformanceData(
  extensionContext: vscode.ExtensionContext,
  profiles: Map<string, ModelProfile>,
  log: (msg: string) => void,
): TaskResult[] {
  try {
    const data = extensionContext.globalState.get<{
      profiles: Record<string, Partial<ModelProfile>>;
      recentResults: TaskResult[];
      lastUpdated: string;
    }>("modelRouter.performanceData");

    if (!data) {
      log("[ModelRouter] No previous performance data");
      return [];
    }

    const performanceLog = data.recentResults || [];
    for (const [id, saved] of Object.entries(data.profiles)) {
      if (!saved.successRate && !saved.avgResponseQuality) continue;
      profiles.set(id, {
        id,
        family: saved.family || "",
        vendor: saved.vendor || "",
        maxInputTokens: 0,
        tier: saved.tier || "standard",
        capabilities: [],
        performanceHistory: performanceLog.filter((r) => r.modelId === id),
        successRate: saved.successRate || {},
        avgResponseQuality: saved.avgResponseQuality || 0.5,
      });
    }

    log(
      `[ModelRouter] Loaded ${performanceLog.length} results, ${Object.keys(data.profiles).length} profiles (last: ${data.lastUpdated})`,
    );
    return performanceLog;
  } catch (err) {
    log(`[ModelRouter] Failed to load: ${err}`);
    return [];
  }
}

export function buildStatus(
  availableModelsCount: number,
  performanceLogCount: number,
  profiles: Map<string, ModelProfile>,
): string {
  const lines: string[] = [];
  lines.push("## 🎯 Model Router Status\n");
  lines.push(`**Available models**: ${availableModelsCount}`);
  lines.push(`**Performance log**: ${performanceLogCount} entries\n`);

  if (profiles.size === 0) {
    lines.push("_No models profiled yet. Send a request to start learning._");
    return lines.join("\n");
  }

  lines.push("### Model Profiles\n");
  lines.push("| Model | Tier | Avg Quality | Task History |");
  lines.push("|-------|------|-------------|--------------|");

  for (const [, profile] of profiles) {
    const historyCount = profile.performanceHistory.length;
    const taskBreakdown = Object.entries(profile.successRate)
      .map(([task, rate]) => `${task}: ${(rate * 100).toFixed(0)}%`)
      .join(", ");

    lines.push(
      `| ${profile.family || profile.id} | ${profile.tier} | ${(profile.avgResponseQuality * 100).toFixed(0)}% | ${historyCount} (${taskBreakdown || "no data"}) |`,
    );
  }

  return lines.join("\n");
}

function evaluateQuality(task: TaskClassification, response: string): number {
  let score = 0.5;

  if (response.length < 20) {
    score -= 0.3;
  } else if (response.length > 100) {
    score += 0.1;
  }

  if (task.requiresCodeUnderstanding) {
    if (/```[\s\S]*?```/.test(response)) {
      score += 0.2;
    } else if (task.type === "code-generation") {
      score -= 0.2;
    }
  }

  if (/i (?:can't|cannot|don't|unable)/i.test(response)) {
    score -= 0.2;
  }

  if (/^#{1,3}\s/m.test(response) || /^[-*]\s/m.test(response)) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}
