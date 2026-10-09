import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { basename as pathBasename, join, relative } from "path";
import { getLoopsDir } from "./brain-paths.mjs";

const CACHE_FILE = "test-advice.json";
const CACHE_TTL_MS = 30 * 60 * 1000;
const TELEMETRY_FILE = "test-advice-telemetry.json";
const MAX_DRAFT_CHARS = 1600;

export function readTestAdviceCache(cwd, files) {
  try {
    const cachePath = join(getLoopsDir(cwd), CACHE_FILE);
    if (!existsSync(cachePath)) return new Map();

    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const results = new Map();
    for (const file of files) {
      const key = pathBasename(file);
      const relativeKey = relative(cwd, file).replace(/\\/g, "/").toLowerCase();
      const entry = cache[relativeKey] ?? cache[key];
      if (!entry) continue;
      if (Date.now() - (entry.timestamp || 0) > CACHE_TTL_MS) continue;
      if (entry.diffFingerprint) {
        const currentFingerprint = computeDiffFingerprint(cwd, file);
        if (currentFingerprint && currentFingerprint !== entry.diffFingerprint) {
          continue;
        }
      }
      results.set(key, entry);
    }
    return results;
  } catch {
    return new Map();
  }
}

export function formatTestAdvice(entry, cwd) {
  if (!entry || entry.needsTests === false) {
    return "";
  }
  const lines = [];
  const nextAction = deriveNextAction(entry);
  if (nextAction) {
    lines.push(`Next best action: ${nextAction.text}`);
  }
  lines.push(`Why blocked now: ${deriveBlockedReason(entry)}`);
  const unlockCondition = deriveUnlockCondition(entry);
  if (unlockCondition) {
    lines.push(`What unlocks next: ${unlockCondition}`);
  }
  const bandMeaning = deriveBandMeaning(entry);
  if (bandMeaning) {
    lines.push(`Band meaning: ${bandMeaning}`);
  }
  if (entry.reason) {
    lines.push(`🧠 TEST INTEL: ${entry.reason}`);
  }
  if (Array.isArray(entry.acceptanceCriteria) && entry.acceptanceCriteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const criterion of entry.acceptanceCriteria.slice(0, 5)) {
      lines.push(`- ${criterion}`);
    }
  }
  if (entry.suggestedTestPath) {
    lines.push(`Suggested test path: ${entry.suggestedTestPath}`);
  }
  if (entry.autopilotDraftPath) {
    lines.push(`Autopilot draft ready: ${entry.autopilotDraftPath}`);
  }
  if (entry.autopilotRunCommand && nextAction?.kind === "manual") {
    lines.push(`Suggested run command: ${entry.autopilotRunCommand}`);
  }
  if (
    entry.autopilotShadowCommand &&
    nextAction?.kind !== "shadow" &&
    nextAction?.kind !== "apply"
  ) {
    lines.push(`Autopilot shadow command: ${entry.autopilotShadowCommand}`);
  }
  if (entry.autopilotApplyCommand && nextAction?.kind !== "apply") {
    lines.push(`Autopilot apply command: ${entry.autopilotApplyCommand}`);
  }
  if (entry.recommendationBand) {
    lines.push(`Recommendation band: ${entry.recommendationBand}`);
  }
  if (entry.validation?.policyLabel && entry.validation?.requiredSuccesses) {
    lines.push(
      `Confidence policy: ${entry.validation.policyLabel} (requires ${entry.validation.requiredSuccesses} clean shadow run(s))`,
    );
  }
  if (entry.validation?.notes?.length) {
    lines.push(`Validation notes: ${entry.validation.notes.join('; ')}`);
  }
  const telemetry = readTelemetrySummary(cwd, entry);
  if (telemetry && telemetry.totalRuns > 0) {
    lines.push(
      `Telemetry: ${telemetry.totalRuns} runs, ${telemetry.recentSuccesses} recent ok, ${telemetry.recentFailures} recent failed`,
    );
  }
  if (entry.draftTest) {
    lines.push("Starter draft test:");
    lines.push(String(entry.draftTest).slice(0, MAX_DRAFT_CHARS));
  }
  return lines.join("\n");
}

function deriveNextAction(entry) {
  if (entry.autopilotApplyCommand) {
    return {
      kind: "apply",
      text: `promote the verified draft into the real repo by running: ${entry.autopilotApplyCommand}`,
    };
  }
  if (entry.autopilotShadowCommand) {
    return {
      kind: "shadow",
      text: `validate the draft in isolation without touching the repo by running: ${entry.autopilotShadowCommand}`,
    };
  }
  if (entry.suggestedTestPath && entry.autopilotRunCommand) {
    return {
      kind: "manual",
      text: `create or update ${entry.suggestedTestPath}, then run: ${entry.autopilotRunCommand}`,
    };
  }
  if (entry.suggestedTestPath) {
    return {
      kind: "manual",
      text: `create or update ${entry.suggestedTestPath}`,
    };
  }
  return null;
}

function deriveBlockedReason(entry) {
  if (entry.recommendationBand === "draft-only") {
    return "the current draft or validation state is not safe enough to trust autopilot yet";
  }
  if (entry.recommendationBand === "advisory") {
    return "the change still lacks verified test evidence for this target pattern";
  }
  if (entry.recommendationBand === "autopilot-safe") {
    return "the repo still does not contain the verified test update for this change";
  }
  return "the change still needs an explicit test update before the gate can clear";
}

function deriveUnlockCondition(entry) {
  const policyLabel = entry.validation?.policyLabel;
  const requiredSuccesses = entry.validation?.requiredSuccesses;
  if (entry.recommendationBand === "draft-only") {
    return "a syntax-valid draft plus a target-aware run command that can be trusted";
  }
  if (
    entry.recommendationBand === "advisory" &&
    policyLabel &&
    requiredSuccesses
  ) {
    return `${requiredSuccesses} clean shadow run(s) for ${policyLabel}`;
  }
  if (entry.recommendationBand === "autopilot-safe") {
    return "apply the verified draft, rerun the gate, and let the repo contain the test update";
  }
  return null;
}

function deriveBandMeaning(entry) {
  if (entry.recommendationBand === "draft-only") {
    return "the idea may be useful, but the current draft is not trustworthy enough for autopilot";
  }
  if (entry.recommendationBand === "advisory") {
    return "guidance is available, but autopilot still needs more evidence before it can change the repo";
  }
  if (entry.recommendationBand === "autopilot-safe") {
    return "enough evidence exists for autopilot to update the repo safely";
  }
  return null;
}

function readTelemetrySummary(cwd, entry) {
  try {
    const targetPath = normalizePath(
      entry?.autopilotTargetPath || entry?.suggestedTestPath || "",
    );
    if (!targetPath) {
      return null;
    }
    const telemetryPath = join(getLoopsDir(cwd), TELEMETRY_FILE);
    if (!existsSync(telemetryPath)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(telemetryPath, "utf8"));
    if (!Array.isArray(parsed)) {
      return null;
    }
    const targetDir = targetPath.includes("/")
      ? targetPath.slice(0, targetPath.lastIndexOf("/"))
      : "";
    const matching = parsed.filter((item) => {
      const candidate = normalizePath(item?.targetPath || "");
      return candidate === targetPath || dirname(candidate) === targetDir;
    });
    const recent = matching
      .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0))
      .slice(0, 6);
    return {
      totalRuns: matching.length,
      recentSuccesses: recent.filter((item) => item.status === "success").length,
      recentFailures: recent.filter((item) => item.status === "failure").length,
    };
  } catch {
    return null;
  }
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function computeDiffFingerprint(cwd, file) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--unified=0", "--", file],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!diff) {
      return null;
    }
    return createHash("sha1").update(diff).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}