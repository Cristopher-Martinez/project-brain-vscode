/**
 * T5-EL — Persistence Module
 *
 * Handles reading/writing mutation artifacts and baseline files.
 * Pure I/O — no business logic.
 */

import { createHash } from "crypto";
import type {
  AutoBaselineResult,
  HistoryLoadResult,
  MutationBaseline,
  MutationRun,
  T5ELDeps,
} from "./test-gate-mutation-el-types";
import {
  toModuleScoreMap,
  toMutantDetails,
} from "./test-gate-mutation-el-types";
import type { T5Result } from "./test-gate-mutation-types";

// ——— Artifact Persistence ———————————————————————————————————

/** Build a MutationRun artifact from engine result + metadata */
export function buildArtifact(
  engineResult: T5Result,
  commit: string,
  branch?: string,
): MutationRun {
  return {
    commit,
    timestamp: new Date().toISOString(),
    branch,
    rawScore: engineResult.rawGlobalScore ?? 0,
    adjustedScore: engineResult.globalScore ?? 0,
    moduleScores: toModuleScoreMap(engineResult.moduleScores),
    totalMutants: engineResult.totalMutants,
    killed: engineResult.killed,
    survived: engineResult.survived,
    timeout: engineResult.timeout,
    equivalent: engineResult.equivalentExcluded,
    invalid: engineResult.invalid,
    criticalSurvivors: toMutantDetails(engineResult.criticalSurvivors),
    capped: engineResult.capped,
    mutantsSkippedDueToCap: engineResult.mutantsSkippedDueToCap,
  };
}

/** Save mutation run artifact to history dir */
export async function saveArtifact(
  artifact: MutationRun,
  historyDir: string,
  deps: T5ELDeps,
): Promise<void> {
  const fileName = `${artifact.commit}.json`;
  const filePath = `${historyDir}/${fileName}`;
  const content = JSON.stringify(artifact, null, 2);
  await deps.writeFile(filePath, content);
  deps.log(`[T5-EL] Artifact saved: ${filePath}`);
}

/** Load all mutation run artifacts, sorted by timestamp (newest first) */
export async function loadHistory(
  historyDir: string,
  deps: T5ELDeps,
): Promise<HistoryLoadResult> {
  const files = await deps.listDir(historyDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const runs: MutationRun[] = [];
  let invalidCount = 0;

  for (const file of jsonFiles) {
    const content = await deps.readFile(`${historyDir}/${file}`);
    if (!content) {
      continue;
    }
    try {
      const run = JSON.parse(content) as MutationRun;
      if (!isValidArtifact(run)) {
        deps.log(`[T5-EL] Warning: invalid artifact ${file}, skipping`);
        invalidCount++;
        continue;
      }
      runs.push(run);
    } catch {
      deps.log(`[T5-EL] Warning: corrupt artifact ${file}, skipping`);
      invalidCount++;
    }
  }

  // Sort newest first
  runs.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const totalFiles = jsonFiles.length;
  const integrity =
    totalFiles > 0 && invalidCount / totalFiles > 0.2
      ? ("degraded" as const)
      : ("healthy" as const);
  return { runs, totalFiles, invalidCount, integrity };
}

/** Load the N most recent artifacts */
export async function loadRecentHistory(
  historyDir: string,
  deps: T5ELDeps,
  count: number,
): Promise<HistoryLoadResult> {
  const result = await loadHistory(historyDir, deps);
  return { ...result, runs: result.runs.slice(0, count) };
}

// ——— Baseline Persistence ———————————————————————————————————

/** Load baseline from disk (returns null if not found or tampered) */
export async function loadBaseline(
  baselinePath: string,
  deps: T5ELDeps,
): Promise<MutationBaseline | null> {
  const content = await deps.readFile(baselinePath);
  if (!content) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as MutationBaseline & {
      _checksum?: string;
    };
    // FIX 11: Verify checksum if present
    if (parsed._checksum) {
      const expected = parsed._checksum;
      const clone = { ...parsed };
      delete (clone as Record<string, unknown>)["_checksum"];
      const actual = computeBaselineChecksum(clone);
      if (actual !== expected) {
        deps.log(
          `[T5-EL] WARNING: Baseline checksum mismatch — possible tampering, ignoring`,
        );
        return null;
      }
    }
    return parsed;
  } catch {
    deps.log(`[T5-EL] Warning: corrupt baseline file, ignoring`);
    return null;
  }
}

/** Save baseline to disk with integrity checksum */
export async function saveBaseline(
  baseline: MutationBaseline,
  baselinePath: string,
  deps: T5ELDeps,
): Promise<void> {
  const checksum = computeBaselineChecksum(baseline);
  const withChecksum = { ...baseline, _checksum: checksum };
  const content = JSON.stringify(withChecksum, null, 2);
  await deps.writeFile(baselinePath, content);
  deps.log(
    `[T5-EL] Baseline saved: score=${baseline.baselineScore}, critical=${baseline.baselineCritical}`,
  );
}

/** Create baseline from current run if none exists and score is below threshold */
export async function autoCreateBaseline(
  artifact: MutationRun,
  globalMinScore: number,
  baselinePath: string,
  deps: T5ELDeps,
): Promise<AutoBaselineResult> {
  const existing = await loadBaseline(baselinePath, deps);
  if (existing) {
    return { baseline: existing, baselineLockActivated: false };
  }

  if (artifact.rawScore < globalMinScore) {
    const baseline: MutationBaseline = {
      baselineScore: artifact.rawScore,
      baselineCritical: artifact.criticalSurvivors.length,
      baselineMutantIds: artifact.criticalSurvivors.map((s) => s.mutantId),
      createdAt: new Date().toISOString(),
      commit: artifact.commit,
    };
    await saveBaseline(baseline, baselinePath, deps);
    deps.log(`[T5-EL] Auto-created baseline: score=${baseline.baselineScore}`);
    return { baseline, baselineLockActivated: true };
  }

  return { baseline: null, baselineLockActivated: false };
}

/** Prune old history entries beyond maxEntries (newest kept) */
export async function pruneHistory(
  historyDir: string,
  maxEntries: number,
  deps: T5ELDeps,
): Promise<number> {
  const { runs: all } = await loadHistory(historyDir, deps);
  if (all.length <= maxEntries) {
    return 0;
  }

  const toDelete = all.slice(maxEntries);
  let deleted = 0;
  for (const run of toDelete) {
    await deps.deleteFile(`${historyDir}/${run.commit}.json`);
    deleted++;
  }
  deps.log(`[T5-EL] Pruned ${deleted} old history entries`);
  return deleted;
}

// ——— Integrity Helpers ——————————————————————————————————————

/** FIX 9: Validate that a loaded artifact has all required fields */
export function isValidArtifact(run: unknown): run is MutationRun {
  if (!run || typeof run !== "object") {
    return false;
  }
  const r = run as Record<string, unknown>;
  return (
    typeof r.commit === "string" &&
    r.commit.length > 0 &&
    typeof r.timestamp === "string" &&
    r.timestamp.length > 0 &&
    typeof r.rawScore === "number" &&
    isFinite(r.rawScore) &&
    typeof r.adjustedScore === "number" &&
    isFinite(r.adjustedScore) &&
    typeof r.totalMutants === "number" &&
    r.totalMutants >= 0 &&
    typeof r.killed === "number" &&
    typeof r.survived === "number" &&
    Array.isArray(r.criticalSurvivors)
  );
}

/** FIX 11: Compute SHA-256 checksum of baseline data (excluding _checksum field) */
export function computeBaselineChecksum(baseline: MutationBaseline): string {
  const canonical = JSON.stringify(baseline, Object.keys(baseline).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
