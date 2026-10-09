/**
 * test-gate-fast.ts — Fast Gate runner with convergence engine (T2).
 *
 * Runs tests, coverage, lint, TSC — produces GateResult with precise locations.
 * Maps branch coverage to invariant IDs. Enforces convergence in ≤3 iterations.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md (T2)
 */

import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getLoopsDir } from "./brain-paths";
import { readInvariantsDoc } from "./invariants-manager";
import { log, logWarn } from "./logger";
import {
  calculateAggregateCoverage,
  findAndParseCoverage,
  mapBranchesToInvariants,
} from "./test-gate-coverage";
import type {
  ConvergenceState,
  FastGateConfig,
  GateCheck,
  GateResult,
  ProjectTestContract,
} from "./test-pipeline-types";

const DEFAULT_CONFIG: FastGateConfig = {
  branchThreshold: 70,
  decisionThreshold: 60,
  timeout: 60_000,
  maxIterations: 3,
};

const CONVERGENCE_FILE = "fast-gate-convergence.json";
const LINT_WARNING_ESCALATION = 3;

/** Run the fast gate and return structured results. */
export async function runFastGate(
  wsRoot: string,
  contract: ProjectTestContract,
  config?: Partial<FastGateConfig>,
): Promise<GateResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const checks: GateCheck[] = [];
  const convergence = loadConvergence(wsRoot);

  // Check convergence limit
  if (convergence && convergence.iteration >= cfg.maxIterations) {
    log(
      `[FastGate] Convergence limit reached (${cfg.maxIterations} iterations)`,
    );
    return buildConvergedResult(convergence, startTime);
  }

  // Run all checks with timeout
  const results = await Promise.allSettled([
    contract.test
      ? runShellCheck(wsRoot, contract.test, "tests", cfg.timeout)
      : null,
    runTscCheck(wsRoot, cfg.timeout),
    contract.lint
      ? runShellCheck(wsRoot, contract.lint, "lint", cfg.timeout)
      : null,
  ]);

  // Process test results
  const testResult = results[0];
  if (testResult.status === "fulfilled" && testResult.value) {
    checks.push(testResult.value);
  }

  // Process TSC results
  const tscResult = results[1];
  if (tscResult.status === "fulfilled" && tscResult.value) {
    checks.push(tscResult.value);
  }

  // Process lint results
  const lintResult = results[2];
  if (lintResult.status === "fulfilled" && lintResult.value) {
    checks.push(lintResult.value);
    checkLintEscalation(lintResult.value, convergence, checks);
  }

  // Coverage analysis (runs after tests to have fresh reports)
  const coverageChecks = analyzeCoverage(wsRoot, cfg);
  checks.push(...coverageChecks);

  const passed = checks.filter((c) => c.blocking).every((c) => c.passed);
  const result: GateResult = {
    level: 1,
    passed,
    checks,
    duration: Date.now() - startTime,
    timestamp: Date.now(),
  };

  // Update convergence state
  updateConvergence(wsRoot, convergence, result, cfg.maxIterations);

  return result;
}

/** Run a shell command and produce a GateCheck. */
async function runShellCheck(
  wsRoot: string,
  command: string,
  name: string,
  timeout: number,
): Promise<GateCheck> {
  return new Promise((resolve) => {
    const [cmd, ...args] = parseCommand(command);
    const proc = execFile(
      cmd,
      args,
      {
        cwd: wsRoot,
        timeout,
        maxBuffer: 1024 * 1024,
        shell: true,
      },
      (error, stdout, stderr) => {
        const output = (stdout || "") + (stderr || "");
        const passed = !error;
        const location = passed ? undefined : extractFirstErrorLocation(output);

        resolve({
          name,
          passed,
          blocking: true,
          explanation: passed
            ? `${name} passed`
            : `${name} failed: ${extractFirstLine(output)}`,
          location,
          suggestion: passed
            ? undefined
            : `Fix ${name} errors before committing`,
        });
      },
    );

    proc.on("error", (err) => {
      resolve({
        name,
        passed: false,
        blocking: true,
        explanation: `${name}: command failed — ${err.message}`,
      });
    });
  });
}

/** Run TypeScript compiler check. */
async function runTscCheck(
  wsRoot: string,
  timeout: number,
): Promise<GateCheck> {
  return new Promise((resolve) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    execFile(
      npxCmd,
      ["tsc", "--noEmit"],
      {
        cwd: wsRoot,
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = (stdout || "") + (stderr || "");
        const errorCount = (output.match(/error TS\d+/g) || []).length;
        const location = extractTscErrorLocation(output);

        resolve({
          name: "tsc",
          passed: !error,
          blocking: true,
          value: errorCount,
          explanation: error
            ? `TSC: ${errorCount} error(s). ${extractFirstLine(output)}`
            : "TSC: 0 errors",
          location,
          suggestion: error
            ? "Fix TypeScript errors before committing"
            : undefined,
        });
      },
    );
  });
}

/** Analyze coverage reports and map to invariants. */
function analyzeCoverage(wsRoot: string, cfg: FastGateConfig): GateCheck[] {
  const checks: GateCheck[] = [];
  const summaries = findAndParseCoverage(wsRoot);

  if (summaries.length === 0) {
    checks.push({
      name: "branch-coverage",
      passed: true,
      blocking: false,
      explanation: "No coverage report found — skipped",
    });
    return checks;
  }

  const aggregatePct = calculateAggregateCoverage(summaries);

  // Overall branch coverage check
  checks.push({
    name: "branch-coverage",
    passed: aggregatePct >= cfg.branchThreshold,
    blocking: true,
    value: aggregatePct,
    threshold: cfg.branchThreshold,
    explanation:
      aggregatePct >= cfg.branchThreshold
        ? `Branch coverage ${aggregatePct}% >= ${cfg.branchThreshold}%`
        : `Branch coverage ${aggregatePct}% < ${cfg.branchThreshold}%`,
    suggestion:
      aggregatePct < cfg.branchThreshold
        ? `Add tests to cover at least ${cfg.branchThreshold - aggregatePct}% more branches`
        : undefined,
  });

  // Map uncovered branches to invariants
  const allUncovered = summaries.flatMap((s) => s.uncoveredBranches);
  if (allUncovered.length > 0) {
    const invariants = readInvariantsDoc(wsRoot);
    const branchChecks = mapBranchesToInvariants(allUncovered, invariants);
    checks.push(...branchChecks);
  }

  return checks;
}

/** Check if lint warnings should escalate to errors. */
function checkLintEscalation(
  lintCheck: GateCheck,
  convergence: ConvergenceState | null,
  checks: GateCheck[],
): void {
  if (lintCheck.passed || !convergence) {
    return;
  }

  // Count how many iterations had lint warnings
  const lintFailCount = convergence.previousChecks.filter(
    (c) => c.name === "lint" && !c.passed,
  ).length;

  if (lintFailCount >= LINT_WARNING_ESCALATION) {
    checks.push({
      name: "lint-escalation",
      passed: false,
      blocking: true,
      explanation: `Lint warnings persisted ${lintFailCount}x — escalated to blocking`,
      suggestion: "Lint warnings became errors after 3 consecutive gate runs",
    });
  }
}

// ——— Convergence Engine ————————————————————————————————————————

function loadConvergence(wsRoot: string): ConvergenceState | null {
  const path = join(getLoopsDir(wsRoot), CONVERGENCE_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as ConvergenceState;
    // Expire after 1 hour
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    if (elapsed > 3_600_000) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function updateConvergence(
  wsRoot: string,
  prev: ConvergenceState | null,
  result: GateResult,
  maxIterations: number,
): void {
  const failedChecks = result.checks.filter((c) => !c.passed && c.blocking);
  const prevFailedNames =
    prev?.previousChecks
      .filter((c) => !c.passed && c.blocking)
      .map((c) => c.name) || [];

  const improved = prevFailedNames.filter(
    (name) => !failedChecks.some((c) => c.name === name),
  );
  const stalled = failedChecks
    .filter((c) => prevFailedNames.includes(c.name))
    .map((c) => c.name);
  // Net fail detection: if total fails didn't decrease, mark as stalled too
  const netStalled =
    prev &&
    failedChecks.length >= prevFailedNames.length &&
    improved.length > 0;

  const state: ConvergenceState = {
    sessionId: prev?.sessionId || crypto.randomUUID(),
    iteration: (prev?.iteration || 0) + 1,
    previousChecks: result.checks,
    improvedChecks: improved,
    stalledChecks: netStalled
      ? [...new Set([...stalled, "net-fail-count-not-decreasing"])]
      : stalled,
    startedAt: prev?.startedAt || new Date().toISOString(),
  };

  const dir = getLoopsDir(wsRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(getLoopsDir(wsRoot), CONVERGENCE_FILE),
    JSON.stringify(state, null, 2),
  );

  if (state.iteration >= maxIterations && !result.passed) {
    logWarn(
      `[FastGate] Convergence limit: ${maxIterations} iterations without passing`,
    );
    logWarn(`[FastGate] Stalled checks: ${stalled.join(", ") || "none"}`);
  }
}

function buildConvergedResult(
  convergence: ConvergenceState,
  startTime: number,
): GateResult {
  return {
    level: 1,
    passed: false,
    checks: [
      {
        name: "convergence-limit",
        passed: false,
        blocking: true,
        explanation: `Gate ran ${convergence.iteration}x without passing. Stalled: ${convergence.stalledChecks.join(", ")}`,
        suggestion:
          "Review stalled checks or use --no-verify with justification",
      },
      ...convergence.previousChecks.filter((c) => !c.passed),
    ],
    duration: Date.now() - startTime,
    timestamp: Date.now(),
  };
}

/** Reset convergence state (e.g., after successful commit). */
export function resetConvergence(wsRoot: string): void {
  const path = join(getLoopsDir(wsRoot), CONVERGENCE_FILE);
  if (existsSync(path)) {
    writeFileSync(path, "{}");
    log("[FastGate] Convergence state reset");
  }
}

// ——— Helpers ———————————————————————————————————————————————————

function parseCommand(command: string): string[] {
  const parts = command.match(/"[^"]+"|'[^']+'|\S+/g) || [command];
  return parts.map((p) => p.replace(/^['"]|['"]$/g, ""));
}

function extractFirstLine(output: string): string {
  const lines = output
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  return lines[0]?.substring(0, 200) || "No output";
}

function extractFirstErrorLocation(
  output: string,
): GateCheck["location"] | undefined {
  // Match patterns like: file.ts(10,5): error or file.ts:10:5:
  const match = output.match(/([^\s:(]+\.[a-z]+)[:(](\d+)/i);
  if (match) {
    return { file: match[1], line: parseInt(match[2], 10) };
  }
  return undefined;
}

function extractTscErrorLocation(
  output: string,
): GateCheck["location"] | undefined {
  // TSC error format: src/file.ts(10,5): error TS1234:
  const match = output.match(/([^\s(]+\.ts)\((\d+),\d+\):/);
  if (match) {
    return { file: match[1], line: parseInt(match[2], 10) };
  }
  return undefined;
}
