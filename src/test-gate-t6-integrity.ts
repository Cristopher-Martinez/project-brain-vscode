/**
 * T6-9 — Integrity Cross-Check
 *
 * Before final render:
 * - Verify baseline checksum
 * - Verify no recent corrupt artifacts
 * - Verify no dirty files
 * - If degraded → show warning banner
 *
 * UI must not crash under degraded state.
 */

import {
  isValidArtifact,
  loadBaseline,
} from "./test-gate-mutation-el-persistence";
import type { FinalT5Result } from "./test-gate-mutation-el-types";
import type { T6Deps, T6IntegrityResult } from "./test-gate-t6-types";

/**
 * T6-9: Cross-check integrity before final T6 render.
 * Returns warnings and degradation state — never throws.
 */
export async function crossCheckIntegrity(
  input: FinalT5Result,
  historyDir: string,
  baselinePath: string,
  deps: T6Deps,
): Promise<T6IntegrityResult> {
  const warnings: string[] = [];

  // 1. Verify baseline checksum
  const baselineValid = await checkBaselineChecksum(baselinePath, deps);
  if (!baselineValid) {
    warnings.push("Baseline checksum verification failed — possible tampering");
  }

  // 2. Count corrupt artifacts in history
  const corruptArtifacts = await countCorruptArtifacts(historyDir, deps);
  if (corruptArtifacts > 0) {
    warnings.push(
      `${corruptArtifacts} corrupt artifact(s) found in mutation history`,
    );
  }

  // 3. Check for dirty files (hash verification from engine)
  const dirtyFiles = !input.hashVerified;
  if (dirtyFiles) {
    warnings.push("File hash verification failed — possible dirty state");
  }

  // 4. Derive overall state
  const overallState = deriveOverallState(
    baselineValid,
    corruptArtifacts,
    dirtyFiles,
    input,
  );

  return {
    baselineValid,
    corruptArtifacts,
    dirtyFiles,
    overallState,
    warnings,
  };
}

async function checkBaselineChecksum(
  baselinePath: string,
  deps: T6Deps,
): Promise<boolean> {
  const elDeps = {
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    listDir: deps.listDir,
    getCommitHash: async () => "",
    getBranch: async () => "",
    getT4PassStreak: async () => 0,
    restoreFile: async () => false,
    deleteFile: async () => {},
    log: deps.log,
  };

  const baseline = await loadBaseline(baselinePath, elDeps);
  // loadBaseline returns null if checksum is invalid (FIX 11)
  // If baseline file doesn't exist, that's OK (null = no baseline)
  const raw = await deps.readFile(baselinePath);
  if (raw === null) {
    return true;
  } // no baseline = valid
  return baseline !== null;
}

async function countCorruptArtifacts(
  historyDir: string,
  deps: T6Deps,
): Promise<number> {
  let corruptCount = 0;

  try {
    const files = await deps.listDir(historyDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const filePath = `${historyDir}/${file}`;
      const raw = await deps.readFile(filePath);
      if (raw === null) {
        corruptCount++;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isValidArtifact(parsed)) {
          corruptCount++;
        }
      } catch {
        corruptCount++;
      }
    }
  } catch {
    // Directory doesn't exist — not corrupt, just empty
  }

  return corruptCount;
}

function deriveOverallState(
  baselineValid: boolean,
  corruptArtifacts: number,
  dirtyFiles: boolean,
  input: FinalT5Result,
): "healthy" | "degraded" {
  if (input.historyIntegrity === "degraded") {
    return "degraded";
  }
  if (!baselineValid) {
    return "degraded";
  }
  if (corruptArtifacts > 0) {
    return "degraded";
  }
  if (dirtyFiles) {
    return "degraded";
  }
  return "healthy";
}
