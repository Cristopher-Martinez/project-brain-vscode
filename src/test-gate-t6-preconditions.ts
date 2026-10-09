/**
 * T6-0 — Preconditions Gate
 *
 * Validates that T6 can safely execute.
 * Required: FinalT5Result present, mutation-history exists,
 * baseline valid or null, historyIntegrity ≠ 'degraded'.
 */

import type {
  FinalT5Result,
  T6Deps,
  T6PreconditionResult,
} from "./test-gate-t6-types";

/**
 * T6-0: Check all preconditions before T6 can execute.
 * If any fail → T6_ready = false with descriptive failure messages.
 */
export async function checkPreconditions(
  input: FinalT5Result | null | undefined,
  historyDir: string,
  baselinePath: string,
  deps: T6Deps,
): Promise<T6PreconditionResult> {
  const failures: string[] = [];

  // 1. FinalT5Result must be present
  if (!input) {
    failures.push("FinalT5Result is missing — T5-EL did not produce output");
    return { ready: false, failures };
  }

  // 2. mutation-history directory must exist
  const historyFiles = await deps.listDir(historyDir);
  if (!historyFiles) {
    failures.push(`Mutation history directory not found: ${historyDir}`);
  }

  // 3. Baseline must be valid or null (never corrupted)
  const baselineRaw = await deps.readFile(baselinePath);
  if (baselineRaw !== null) {
    try {
      const parsed = JSON.parse(baselineRaw) as Record<string, unknown>;
      if (typeof parsed.baselineScore !== "number") {
        failures.push(
          "Baseline file exists but is malformed (no baselineScore)",
        );
      }
    } catch {
      failures.push("Baseline file exists but contains invalid JSON");
    }
  }
  // null baseline is acceptable — first run

  // 4. historyIntegrity must not be 'degraded'
  if (input.historyIntegrity === "degraded") {
    failures.push(
      "History integrity is degraded — too many corrupt artifacts detected",
    );
  }

  return {
    ready: failures.length === 0,
    failures,
  };
}
