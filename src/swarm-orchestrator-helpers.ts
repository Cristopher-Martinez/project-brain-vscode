// ============================================================
// SOURCE MAP — swarm-orchestrator-helpers.ts
// Helper functions extracted from swarm-orchestrator.ts:
// fork setup/cleanup, context building, report formatting
// ============================================================

import {
  autoCommitFork,
  cloneFork,
  disposeFork,
  generateForkId,
  getForkPath,
  hasChangesInFork,
  selectCloneStrategy,
} from "./fork-core";
import type { SwarmResult, SwarmTask } from "./swarm-worker";

// ─── Types ─────────────────────────────────────────────────────────────

/** Fork info tracked per swarm worker */
export interface SwarmForkInfo {
  branch: string;
  forkPath: string;
}

/** Result of fork branch processing after swarm execution */
export interface ForkBranchResult {
  taskId: string;
  branch: string;
  forkPath: string;
  hasChanges: boolean;
}

// ─── Fork Context ──────────────────────────────────────────────────────

/**
 * Build a system prompt fragment explaining fork isolation to a worker.
 * Replaces the legacy WorktreeManager setup.
 */
export function buildForkContext(
  branch: string,
  forkPath: string,
  repoRoot: string,
): string {
  return [
    "",
    "---",
    "## 🔀 Fork Isolation Context",
    "",
    "You are working in an **isolated fork** of the repository.",
    `- **Branch**: \`${branch}\``,
    `- **Fork path**: \`${forkPath}\``,
    `- **Source repo**: \`${repoRoot}\``,
    "",
    "All changes are isolated — commit freely without affecting the main branch.",
    "---",
    "",
  ].join("\n");
}

// ─── Fork Setup ────────────────────────────────────────────────────────

/**
 * Create fork clones for each swarm task.
 * Injects fork context into each task's system prompt.
 */
export async function setupSwarmForks(
  tasks: SwarmTask[],
  repoRoot: string,
  log: (msg: string) => void,
  onProgress?: (phase: string, detail: string) => void,
): Promise<Map<string, SwarmForkInfo>> {
  const forkMap = new Map<string, SwarmForkInfo>();
  const strategy = selectCloneStrategy(repoRoot);

  log(
    `[Swarm] Creating forks for ${tasks.length} workers (strategy: ${strategy})...`,
  );
  onProgress?.("swarm", "Creating git forks...");

  for (const task of tasks) {
    try {
      const forkId = generateForkId(`swarm-${task.id}`);
      const forkPath = getForkPath(repoRoot, forkId);
      const branch = `swarm/${Date.now().toString(36)}/${task.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      await cloneFork(repoRoot, forkPath, strategy, branch);
      forkMap.set(task.id, { branch, forkPath });
      const forkCtx = buildForkContext(branch, forkPath, repoRoot);
      task.systemPrompt = (task.systemPrompt ?? "") + forkCtx;
    } catch (err) {
      log(
        `[Swarm] Fork creation failed for ${task.id}: ${err} — running without isolation`,
      );
    }
  }

  return forkMap;
}

// ─── Fork Cleanup ──────────────────────────────────────────────────────

/**
 * Cleanup forks after swarm execution:
 * auto-commit pending changes, collect branch results, dispose clones.
 */
export async function cleanupSwarmForks(
  forkMap: Map<string, SwarmForkInfo>,
  log: (msg: string) => void,
): Promise<ForkBranchResult[]> {
  const forkBranches: ForkBranchResult[] = [];

  log(`[Swarm] Fork cleanup: processing ${forkMap.size} forks...`);
  for (const [taskId, info] of forkMap) {
    const hasChanges = await hasChangesInFork(info.forkPath);
    log(
      `[Swarm] Fork ${taskId} (branch=${info.branch}): ${hasChanges ? "HAS CHANGES → auto-committing" : "no changes"}`,
    );
    if (hasChanges) {
      await autoCommitFork(
        info.forkPath,
        `swarm(${taskId}): auto-commit by worker`,
      );
    }
    forkBranches.push({
      taskId,
      branch: info.branch,
      forkPath: info.forkPath,
      hasChanges,
    });
  }

  log(`[Swarm] Disposing fork directories...`);
  for (const [, info] of forkMap) {
    try {
      await disposeFork(info.forkPath, { force: true });
    } catch (err) {
      log(`[Swarm] Fork dispose failed: ${err}`);
    }
  }

  log(
    `[Swarm] Fork cleanup complete: ${forkBranches.filter((b) => b.hasChanges).length}/${forkBranches.length} had changes`,
  );
  return forkBranches;
}

// ─── Report Formatting ────────────────────────────────────────────────

export interface FormatSummaryParams {
  goal: string;
  results: SwarmResult[];
  durationMs: number;
  forkBranches?: ForkBranchResult[];
}

/**
 * Format a human-readable markdown summary of swarm results.
 * Extracted from SwarmOrchestrator.formatSummary().
 */
export function formatSwarmSummary(params: FormatSummaryParams): string {
  const { goal, results, durationMs, forkBranches } = params;
  const lines: string[] = [
    `## Swarm Report: ${goal}`,
    "",
    `| Worker | Model | Tier | Rounds | Tools | Tokens (in/out) | Duration | Status |`,
    `|--------|-------|------|--------|-------|-----------------|----------|--------|`,
  ];

  for (const r of results) {
    const status = r.success ? "✅" : `❌ ${r.error?.substring(0, 30) ?? ""}`;
    const tokens = `${((r.estimatedInputTokens ?? 0) / 1000).toFixed(1)}K/${((r.estimatedOutputTokens ?? 0) / 1000).toFixed(1)}K`;
    lines.push(
      `| ${r.taskId} | ${r.model} | ${r.tier} | ${r.rounds} | ${r.toolCalls.length} | ${tokens} | ${r.durationMs}ms | ${status} |`,
    );
  }

  const totalIn = results.reduce(
    (s, r) => s + (r.estimatedInputTokens ?? 0),
    0,
  );
  const totalOut = results.reduce(
    (s, r) => s + (r.estimatedOutputTokens ?? 0),
    0,
  );
  lines.push("");
  lines.push(
    `**Total**: ${durationMs}ms | **Success**: ${results.filter((r) => r.success).length}/${results.length} | **Tokens**: ${(totalIn / 1000).toFixed(1)}K in / ${(totalOut / 1000).toFixed(1)}K out (~${((totalIn + totalOut) / 1000).toFixed(1)}K total)`,
  );

  // Fork branches section
  if (forkBranches && forkBranches.length > 0) {
    lines.push("");
    lines.push("### Git Branches (fork isolation)");
    lines.push("");
    lines.push("Branches created per worker (auto-committed):");
    lines.push("");

    for (const b of forkBranches) {
      lines.push(
        `- \`${b.branch}\` (worker: ${b.taskId}) — ${b.hasChanges ? "changes" : "no changes"}`,
      );
    }

    lines.push("");
    lines.push(
      "To merge: `git merge <branch>` | To review: `git diff <base>..<branch>`",
    );
  }

  lines.push("");
  lines.push("### Results");
  lines.push("");

  for (const r of results) {
    if (r.text) {
      lines.push(`#### Worker ${r.taskId}`);
      lines.push("");
      lines.push(r.text.trim());
      lines.push("");
    }
  }

  return lines.join("\n");
}
