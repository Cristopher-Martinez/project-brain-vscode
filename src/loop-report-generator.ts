/**
 * Loop Report Generator — Auto-generates executive summary + markdown report
 * when a loop session finalizes with branch isolation.
 *
 * Creates a report file in .project-brain/memory/reports/ with:
 * - Goal, branch info, timestamps
 * - Iteration log (synthesis + feedback per round)
 * - Git diff stats
 * - Executive summary (first 280 chars of combined syntheses)
 */

import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";
import { getForkDiffPreview } from "./fork-merge";
import { updateBranchMeta } from "./fork-queries";
import type { ForkIsolationInfo } from "./fork-types";
import type { LoopUiState } from "./loop-engine";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LoopReport {
  summary: string;
  reportPath: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").substring(0, 19);
}

/** Build executive summary from loop iterations. Max 280 chars. */
function buildSummary(loopState: LoopUiState): string {
  const parts: string[] = [];

  // Use goal as base
  if (loopState.goal) {
    parts.push(loopState.goal);
  }

  // Add last synthesis (most complete)
  const lastIteration = loopState.iterations[loopState.iterations.length - 1];
  if (lastIteration?.synthesis) {
    const cleaned = lastIteration.synthesis
      .replace(/[#*_`]/g, "")
      .replace(/\n+/g, " ")
      .trim();
    parts.push(cleaned);
  }

  const raw = parts.join(" — ");
  if (raw.length <= 280) return raw;
  return raw.substring(0, 277) + "...";
}

// ─── Report Generator ──────────────────────────────────────────────────────

/**
 * Generate a loop session report and save it to .project-brain/memory/reports/.
 * Updates the branch metadata with summary and reportPath.
 */
export async function generateLoopReport(
  repoRoot: string,
  sessionId: string,
  loopState: LoopUiState,
  isolation: ForkIsolationInfo,
): Promise<LoopReport | null> {
  try {
    // 1. Build summary
    const summary = buildSummary(loopState);

    // 2. Get diff stats
    let diffStats = "(no diff available)";
    try {
      diffStats = await getForkDiffPreview(sessionId);
    } catch {
      log(`[LoopReport] Could not get diff for ${sessionId}`);
    }

    // 3. Build report markdown
    const reportMd = buildReportMarkdown(
      sessionId,
      loopState,
      isolation,
      diffStats,
      summary,
    );

    // 4. Ensure reports directory exists
    const reportsDir = path.join(repoRoot, "docs", "memory", "reports");
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // 5. Write report file
    const timestamp = new Date()
      .toISOString()
      .replace(/[T:]/g, "-")
      .substring(0, 16);
    const safeGoal = (loopState.goal || "loop")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 30)
      .replace(/-$/, "");
    const fileName = `${timestamp}_${safeGoal}.md`;
    const filePath = path.join(reportsDir, fileName);

    fs.writeFileSync(filePath, reportMd, "utf-8");

    // 6. Relative path for storage
    const reportPath = path.relative(repoRoot, filePath).replace(/\\/g, "/");

    // 7. Update branch metadata
    updateBranchMeta(sessionId, { summary, reportPath });

    log(
      `[LoopReport] Generated report: ${reportPath} (summary: ${summary.substring(0, 60)}...)`,
    );

    return { summary, reportPath };
  } catch (err) {
    log(`[LoopReport] Failed to generate report: ${err}`);
    return null;
  }
}

// ─── Markdown Builder ───────────────────────────────────────────────────────

function buildReportMarkdown(
  sessionId: string,
  loopState: LoopUiState,
  isolation: ForkIsolationInfo,
  diffStats: string,
  summary: string,
): string {
  const duration = loopState.startedAt
    ? formatDuration(Date.now() - loopState.startedAt)
    : "unknown";

  const lines: string[] = [
    `# Loop Report — ${loopState.goal || sessionId}`,
    "",
    `> ${summary}`,
    "",
    "## Info",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| **Session** | \`${sessionId.substring(0, 8)}\` |`,
    `| **Branch** | \`${isolation.branchName}\` |`,
    `| **Base** | \`${isolation.originalBranch}\` |`,
    `| **Started** | ${loopState.startedAt ? formatTimestamp(loopState.startedAt) : "—"} |`,
    `| **Duration** | ${duration} |`,
    `| **Iterations** | ${loopState.iterations.length} |`,
    "",
  ];

  // Iterations log
  if (loopState.iterations.length > 0) {
    lines.push("## Iterations", "");
    for (const iter of loopState.iterations) {
      lines.push(`### Round ${iter.index}`, "");
      if (iter.synthesis) {
        lines.push("**Synthesis:**", "", iter.synthesis, "");
      }
      if (iter.feedback) {
        lines.push(`**Feedback:** ${iter.feedback}`, "");
      }
      if (iter.completedAt && iter.startedAt) {
        lines.push(
          `*Duration: ${formatDuration(iter.completedAt - iter.startedAt)}*`,
          "",
        );
      }
    }
  }

  // Diff stats
  lines.push("## Changes", "", "```", diffStats, "```", "");

  // Footer
  lines.push(
    "---",
    `*Generated automatically by Project Brain on ${formatTimestamp(Date.now())}*`,
    "",
  );

  return lines.join("\n");
}
