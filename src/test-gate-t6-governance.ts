/**
 * T6-5/6/7 — Governance Control Layer
 *
 * T6-5: Editable governance settings with impact preview
 * T6-6: Retroactive simulation (reinterpret last artifact, no new mutations)
 * T6-7: Append-only configuration audit trail
 *
 * All changes must: show description, show impact, simulate outcome,
 * require confirmation, append to config history.
 */

import { applyPolicy } from "./test-gate-mutation-el-policy";
import type {
  MutationBaseline,
  MutationRun,
  T5ELConfig,
} from "./test-gate-mutation-el-types";
import type {
  T6ConfigAuditEntry,
  T6Deps,
  T6GovernanceChangePreview,
  T6GovernanceConfig,
} from "./test-gate-t6-types";

// ——— T6-5: Current Governance State ————————————————————————

/**
 * Extract current governance config from T5EL config.
 * Maps T5EL field names to T6 governance field names.
 */
export function extractGovernanceConfig(
  elConfig: T5ELConfig,
  t5MaxMutantsPerFile: number,
  t5MaxTotalMutants: number,
  t5MutationTimeout: number,
): T6GovernanceConfig {
  return {
    policyMode: elConfig.mode,
    globalMinScore: elConfig.globalMinScore,
    coreMinScore: elConfig.coreMinScore,
    maxMutantsPerFile: t5MaxMutantsPerFile,
    maxTotalMutants: t5MaxTotalMutants,
    mutationTimeout: t5MutationTimeout,
  };
}

// ——— T6-6: Retroactive Simulation ——————————————————————————

/**
 * Simulate what would happen to the last artifact under a new config.
 * MUST NOT execute new mutations — only reinterprets existing data.
 */
export function simulateConfigChange(
  lastArtifact: MutationRun,
  baseline: MutationBaseline | null,
  currentConfig: T6GovernanceConfig,
  newConfig: T6GovernanceConfig,
  modifiedFiles: string[],
): T6GovernanceChangePreview {
  const currentElConfig = toElConfig(currentConfig);
  const newElConfig = toElConfig(newConfig);

  const previousDecision = applyPolicy(
    lastArtifact,
    currentConfig.policyMode,
    baseline,
    "mature",
    currentElConfig,
    modifiedFiles,
  );

  const newDecision = applyPolicy(
    lastArtifact,
    newConfig.policyMode,
    baseline,
    "mature",
    newElConfig,
    modifiedFiles,
  );

  const warning = buildChangeWarning(
    previousDecision.blocking,
    newDecision.blocking,
    currentConfig,
    newConfig,
  );

  return {
    previousDecision: previousDecision.blocking,
    newDecision: newDecision.blocking,
    warning,
  };
}

function buildChangeWarning(
  wasBlocking: boolean,
  willBlock: boolean,
  oldConfig: T6GovernanceConfig,
  newConfig: T6GovernanceConfig,
): string | undefined {
  const warnings: string[] = [];

  if (!wasBlocking && willBlock) {
    warnings.push("This change would have BLOCKED the last commit");
  }
  if (wasBlocking && !willBlock) {
    warnings.push(
      "This change would have ALLOWED the last commit (previously blocked)",
    );
  }
  if (newConfig.globalMinScore > oldConfig.globalMinScore) {
    warnings.push(
      `Raising minimum score from ${oldConfig.globalMinScore} to ${newConfig.globalMinScore} — ` +
        "this makes the gate stricter",
    );
  }
  if (
    newConfig.policyMode === "enforce" &&
    oldConfig.policyMode !== "enforce"
  ) {
    warnings.push(
      "Switching to enforce mode — commits will be blocked on threshold violations",
    );
  }

  return warnings.length > 0 ? warnings.join(". ") : undefined;
}

/**
 * Convert T6GovernanceConfig to T5ELConfig shape for policy simulation.
 * Only governance-relevant fields are set; others use sensible defaults.
 */
function toElConfig(gov: T6GovernanceConfig): T5ELConfig {
  return {
    mode: gov.policyMode,
    historyDir: ".mutation-history",
    baselinePath: ".mutation-baseline.json",
    globalMinScore: gov.globalMinScore,
    coreMinScore: gov.coreMinScore,
    maturityWindowSize: 5,
    maturityMinAvgScore: 70,
    maturityMinT4Streak: 5,
    maxHistoryEntries: 100,
    minMutationVolume: 30,
  };
}

// ——— T6-7: Configuration Audit Trail ———————————————————————

/**
 * Build an audit entry for a governance config change.
 */
export function buildAuditEntry(
  previousConfig: T6GovernanceConfig,
  newConfig: T6GovernanceConfig,
  simulatedImpact: T6GovernanceChangePreview,
  user?: string,
): T6ConfigAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    previousConfig,
    newConfig,
    simulatedImpact,
    user,
  };
}

/**
 * Persist a governance config change to the audit trail.
 * Append-only — never overwrites previous entries.
 */
export async function persistAuditEntry(
  entry: T6ConfigAuditEntry,
  configHistoryDir: string,
  deps: T6Deps,
): Promise<void> {
  await deps.ensureDir(configHistoryDir);

  const filename = `${entry.timestamp.replace(/[:.]/g, "-")}.json`;
  const filePath = `${configHistoryDir}/${filename}`;
  const content = JSON.stringify(entry, null, 2);

  await deps.writeFile(filePath, content);
  deps.log(`[T6] Config audit entry saved: ${filename}`);
}

/**
 * Persist the new governance config as the active config.
 */
export async function persistGovernanceConfig(
  config: T6GovernanceConfig,
  configPath: string,
  deps: T6Deps,
): Promise<void> {
  const content = JSON.stringify(config, null, 2);
  await deps.writeFile(configPath, content);
  deps.log(`[T6] Governance config updated: ${configPath}`);
}

/**
 * Load current governance config from disk.
 * Returns null if no config file exists (first run).
 */
export async function loadGovernanceConfig(
  configPath: string,
  deps: T6Deps,
): Promise<T6GovernanceConfig | null> {
  const raw = await deps.readFile(configPath);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as T6GovernanceConfig;
    if (!isValidGovernanceConfig(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    deps.log(`[T6] Warning: governance config at ${configPath} is invalid`);
    return null;
  }
}

function isValidGovernanceConfig(obj: unknown): obj is T6GovernanceConfig {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const o = obj as Record<string, unknown>;
  return (
    typeof o.policyMode === "string" &&
    typeof o.globalMinScore === "number" &&
    typeof o.coreMinScore === "number" &&
    typeof o.maxMutantsPerFile === "number" &&
    typeof o.maxTotalMutants === "number" &&
    typeof o.mutationTimeout === "number"
  );
}

/**
 * Human-readable descriptions for each governance field.
 * Used by T6-5 UI to explain what each setting does.
 */
export const GOVERNANCE_FIELD_DESCRIPTIONS: Record<
  keyof T6GovernanceConfig,
  string
> = {
  policyMode:
    "Controls how the mutation gate reacts. " +
    "'report' only warns, 'enforce' blocks commits, " +
    "'baseline-lock' prevents regression, 'adaptive' adjusts based on maturity.",
  globalMinScore:
    "Minimum mutation score (%) required globally. " +
    "Below this threshold, the gate blocks the commit in enforce mode.",
  coreMinScore:
    "Minimum mutation score (%) for core modules. " +
    "Core modules are critical paths that require higher test coverage.",
  maxMutantsPerFile:
    "Maximum number of mutations generated per file. " +
    "Higher values increase detection but slow down the gate.",
  maxTotalMutants:
    "Maximum total mutations per run across all files. " +
    "Acts as a safety cap to prevent excessive execution time.",
  mutationTimeout:
    "Maximum time (ms) to wait for each mutation test. " +
    "Mutations exceeding this are marked as timeout kills.",
};
