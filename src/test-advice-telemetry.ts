import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getLoopsDir } from "./brain-paths";

interface TestAdviceTelemetryEntry {
  targetPath: string;
  runCommand: string;
  status: "success" | "failure";
  timestamp: number;
}

interface TestAdviceTelemetrySummary {
  totalRuns: number;
  recentSuccesses: number;
  recentFailures: number;
}

const TELEMETRY_FILE = "test-advice-telemetry.json";
const MAX_RECENT_ENTRIES = 6;

export function readTelemetrySummary(
  wsRoot: string,
  targetPath: string,
): TestAdviceTelemetrySummary {
  const entries = readTelemetryEntries(wsRoot);
  const normalizedTarget = normalizePath(targetPath);
  const targetDir = dirname(normalizedTarget);
  const matching = entries.filter(
    (entry) =>
      normalizePath(entry.targetPath) === normalizedTarget ||
      dirname(normalizePath(entry.targetPath)) === targetDir,
  );
  const recent = matching
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_RECENT_ENTRIES);

  return {
    totalRuns: matching.length,
    recentSuccesses: recent.filter((entry) => entry.status === "success").length,
    recentFailures: recent.filter((entry) => entry.status === "failure").length,
  };
}

function readTelemetryEntries(wsRoot: string): TestAdviceTelemetryEntry[] {
  try {
    const telemetryPath = join(getLoopsDir(wsRoot), TELEMETRY_FILE);
    if (!existsSync(telemetryPath)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(telemetryPath, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isTelemetryEntry)
      : [];
  } catch {
    return [];
  }
}

function isTelemetryEntry(value: unknown): value is TestAdviceTelemetryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.targetPath === "string" &&
    typeof entry.runCommand === "string" &&
    (entry.status === "success" || entry.status === "failure") &&
    typeof entry.timestamp === "number"
  );
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}