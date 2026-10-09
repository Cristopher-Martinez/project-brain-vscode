import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";
import { readLoopConfig } from "./loop-config";
import { readLoopHistory } from "./loop-history";

export type HydrateLoopMode = "summary" | "full" | "history-only";

export interface HydrateLoopContextInput {
  sessionId: string;
  sourceSessionId?: string;
  mode?: HydrateLoopMode;
}

function getRepoRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function resolveTargetSessionId(
  repoRoot: string,
  sessionId: string,
  explicitSourceSessionId?: string,
): string {
  if (explicitSourceSessionId) return explicitSourceSessionId;
  const currentConfig = readLoopConfig(sessionId, repoRoot);
  return currentConfig?.sourceSessionId ?? sessionId;
}

function relativeLoopFile(sessionId: string, name: string): string {
  return `.project-brain/loops/${sessionId}/${name}`;
}

function truncate(text: string | undefined, limit: number): string {
  if (!text) return "";
  return text.length > limit ? `${text.substring(0, limit)}...` : text;
}

function formatIterationCompact(
  index: number,
  prompt?: string,
  synthesis?: string,
  feedback?: string,
): string {
  const lines = [`- Ronda ${index}`];
  if (prompt) lines.push(`  prompt: ${truncate(prompt, 160)}`);
  if (synthesis) lines.push(`  synthesis: ${truncate(synthesis, 220)}`);
  if (feedback) lines.push(`  feedback: ${truncate(feedback, 180)}`);
  return lines.join("\n");
}

function formatSummary(
  targetSessionId: string,
  currentSessionId: string,
  sourceSessionId: string | undefined,
  mode: HydrateLoopMode,
  repoRoot: string,
): string {
  const targetConfig = readLoopConfig(targetSessionId, repoRoot);
  const targetHistory = readLoopHistory(targetSessionId, repoRoot);
  const currentConfig = readLoopConfig(currentSessionId, repoRoot);

  const lines: string[] = [];
  lines.push(`hydrateLoopContext mode=${mode}`);
  lines.push(`currentSessionId: ${currentSessionId}`);
  if (sourceSessionId) lines.push(`sourceSessionId: ${sourceSessionId}`);
  lines.push(`targetSessionId: ${targetSessionId}`);
  lines.push(
    `targetHistoryPath: ${relativeLoopFile(targetSessionId, "history.json")}`,
  );
  lines.push(
    `targetConfigPath: ${relativeLoopFile(targetSessionId, "loop.config.json")}`,
  );
  if (currentSessionId !== targetSessionId) {
    lines.push(
      `currentConfigPath: ${relativeLoopFile(currentSessionId, "loop.config.json")}`,
    );
  }

  const effectiveGoal =
    targetHistory?.goal ||
    targetConfig?.goal ||
    currentConfig?.goal ||
    "(sin goal)";
  lines.push(`goal: ${truncate(effectiveGoal, 250)}`);
  lines.push(`totalIterations: ${targetHistory?.totalIterations ?? 0}`);
  if (targetConfig?.maxCycles !== undefined) {
    lines.push(`maxCycles: ${targetConfig.maxCycles}`);
  }

  const iterations = targetHistory?.iterations ?? [];
  const last = iterations[iterations.length - 1];
  if (last?.synthesis)
    lines.push(`lastSynthesis: ${truncate(last.synthesis, 300)}`);
  if (last?.feedback)
    lines.push(`lastFeedback: ${truncate(last.feedback, 220)}`);

  if (mode === "summary") {
    lines.push("recentIterations:");
    for (const iteration of iterations.slice(-5)) {
      lines.push(
        formatIterationCompact(
          iteration.index,
          iteration.prompt,
          iteration.synthesis,
          iteration.feedback,
        ),
      );
    }
    lines.push(
      "instruction: Usa targetHistoryPath para leer el historial ORIGINAL. Si currentSessionId != targetSessionId, NO uses el history del loop actual salvo que quieras inspeccionar la reconexión misma.",
    );
    return lines.join("\n");
  }

  if (mode === "history-only") {
    lines.push("iterations:");
    for (const iteration of iterations) {
      lines.push(
        formatIterationCompact(
          iteration.index,
          iteration.prompt,
          iteration.synthesis,
          iteration.feedback,
        ),
      );
    }
    return lines.join("\n");
  }

  lines.push("iterations:");
  for (const iteration of iterations) {
    lines.push(`- Ronda ${iteration.index}`);
    lines.push(`  startedAt: ${iteration.startedAt}`);
    if (iteration.completedAt)
      lines.push(`  completedAt: ${iteration.completedAt}`);
    if (iteration.prompt)
      lines.push(`  prompt: ${truncate(iteration.prompt, 400)}`);
    if (iteration.synthesis)
      lines.push(`  synthesis: ${truncate(iteration.synthesis, 500)}`);
    if (iteration.feedback)
      lines.push(`  feedback: ${truncate(iteration.feedback, 400)}`);
  }
  return lines.join("\n");
}

export function hydrateLoopContext(input: HydrateLoopContextInput): string {
  const repoRoot = getRepoRoot();
  const targetSessionId = resolveTargetSessionId(
    repoRoot,
    input.sessionId,
    input.sourceSessionId,
  );
  const mode = input.mode ?? "summary";
  const sourceSessionId =
    input.sourceSessionId ||
    (targetSessionId !== input.sessionId ? targetSessionId : undefined);

  return formatSummary(
    targetSessionId,
    input.sessionId,
    sourceSessionId,
    mode,
    repoRoot,
  );
}

export function getLoopHistoryAbsolutePath(sessionId: string): string {
  return `${getLoopDir(getRepoRoot(), sessionId)}\\history.json`;
}
