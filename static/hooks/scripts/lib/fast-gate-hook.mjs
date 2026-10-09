/**
 * fast-gate-hook.mjs — T3: Hook-side fast gate for pre-synthesis enforcement.
 * Reads test contract, checks coverage, lint, and tracks convergence.
 * Modes: "report" (warn only) | "enforce" (block on failure).
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md — T3 spec
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";
import { getLoopsDir } from "./brain-paths.mjs";

/** Strip UTF-8 BOM — PowerShell writes BOM by default, crashes JSON.parse. */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const CONTRACT_FILE = "test-contract.json";
const CONVERGENCE_FILE = "fast-gate-convergence.json";
const CONVERGENCE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ——— Contract ———

/** Read cached test contract. Returns null if missing, stale, or hash mismatch. */
function readContract(cwd) {
  try {
    const fp = join(getLoopsDir(cwd), CONTRACT_FILE);
    if (!existsSync(fp)) return null;
    const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    if (Date.now() - (data.cachedAt || 0) > CONVERGENCE_TTL_MS) return null;
    // Validate packageHash — same policy as extension-side T0 contract
    if (data.packageHash) {
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const currentHash = createHash("sha256")
          .update(readFileSync(pkgPath))
          .digest("hex")
          .slice(0, 16);
        if (data.packageHash !== currentHash) return null;
      }
    }
    return data;
  } catch {
    return null;
  }
}

// ——— Coverage Parsing ———

const COVERAGE_PATHS = [
  "coverage/lcov.info",
  "coverage/lcov/lcov.info",
  "coverage/coverage-final.json",
];

/** Parse LCOV content → { file, branchPct, uncoveredCount, uncoveredBranches }[] */
function parseLcov(content) {
  const results = [];
  let current = null;
  let branchHit = 0;
  let branchTotal = 0;
  let uncoveredBranches = [];

  for (const line of content.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3).trim();
      branchHit = 0;
      branchTotal = 0;
      uncoveredBranches = [];
    } else if (line.startsWith("BRDA:")) {
      // BRDA:lineNumber,blockNumber,branchNumber,hitCount
      const parts = line.slice(5).split(",");
      if (parts.length >= 4) {
        const lineNum = parseInt(parts[0], 10);
        const blockNum = parseInt(parts[1], 10);
        const branchNum = parseInt(parts[2], 10);
        const hits = parts[3].trim();
        if (hits === "0" || hits === "-") {
          uncoveredBranches.push({
            line: lineNum,
            block: blockNum,
            branch: branchNum,
          });
        }
      }
    } else if (line.startsWith("BRF:")) {
      branchTotal = parseInt(line.slice(4), 10) || 0;
    } else if (line.startsWith("BRH:")) {
      branchHit = parseInt(line.slice(4), 10) || 0;
    } else if (line === "end_of_record" && current) {
      const pct =
        branchTotal > 0 ? Math.round((branchHit / branchTotal) * 100) : 100;
      results.push({
        file: current,
        branchPct: pct,
        uncoveredCount: branchTotal - branchHit,
        uncoveredBranches,
      });
      current = null;
    }
  }
  return results;
}

/** Find and parse coverage report. Returns { pct, details[], generatedAt } | null */
function readCoverage(cwd) {
  for (const p of COVERAGE_PATHS) {
    const fp = join(cwd, p);
    if (!existsSync(fp)) continue;

    try {
      const covStat = statSync(fp);
      const generatedAt = covStat.mtimeMs;
      const content = readFileSync(fp, "utf8");
      if (p.endsWith(".json")) {
        // Istanbul JSON format
        const data = JSON.parse(content);
        const files = Object.keys(data);
        let totalBranches = 0;
        let coveredBranches = 0;
        const details = [];

        for (const file of files) {
          const entry = data[file];
          if (!entry.branchMap) continue;
          const ids = Object.keys(entry.b || {});
          const uncoveredBranches = [];
          for (const id of ids) {
            const counts = entry.b[id] || [];
            totalBranches += counts.length;
            coveredBranches += counts.filter((c) => c > 0).length;
            // Extract uncovered branch locations from branchMap
            const bm = entry.branchMap[id];
            if (bm?.loc) {
              counts.forEach((c, idx) => {
                if (c === 0) {
                  uncoveredBranches.push({
                    line: bm.loc.start.line,
                    block: parseInt(id, 10),
                    branch: idx,
                  });
                }
              });
            }
          }
          const fileBranches = ids.reduce(
            (s, id) => s + (entry.b[id]?.length || 0),
            0,
          );
          const fileCovered = ids.reduce(
            (s, id) => s + (entry.b[id]?.filter((c) => c > 0).length || 0),
            0,
          );
          details.push({
            file: relative(cwd, file).replace(/\\/g, "/"),
            branchPct:
              fileBranches > 0
                ? Math.round((fileCovered / fileBranches) * 100)
                : 100,
            uncoveredCount: fileBranches - fileCovered,
            uncoveredBranches,
          });
        }

        const pct =
          totalBranches > 0
            ? Math.round((coveredBranches / totalBranches) * 100)
            : 100;
        return { pct, details, generatedAt };
      } else {
        // LCOV format — parseLcov now returns uncoveredBranches per file
        const details = parseLcov(content);
        let totalB = 0;
        let covB = 0;
        for (const d of details) {
          const total =
            d.uncoveredCount > 0
              ? Math.round(d.uncoveredCount / (1 - d.branchPct / 100)) || 0
              : 0;
          totalB += total;
          covB += total - d.uncoveredCount;
        }
        const pct = totalB > 0 ? Math.round((covB / totalB) * 100) : 100;
        return { pct, details, generatedAt };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ——— Lint ———

/** Run lint command, return { pass, output, errorCount } */
function runLint(cwd, lintCommand) {
  if (!lintCommand) return { pass: true, output: "", errorCount: 0 };

  try {
    const parts = lintCommand.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    // Robust executable resolution for Windows (.cmd suffix for npm/npx/yarn)
    const PKG_MANAGERS = ["npm", "npx", "yarn", "pnpm"];
    const needsCmd = PKG_MANAGERS.includes(cmd) && process.platform === "win32";
    const executable = needsCmd ? `${cmd}.cmd` : cmd;

    execFileSync(executable, args, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    });
    return { pass: true, output: "", errorCount: 0 };
  } catch (err) {
    const output =
      (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    const errorCount = (output.match(/\berror\b/gi) || []).length;
    return { pass: false, output: output.substring(0, 1500), errorCount };
  }
}

// ——— Convergence ———

function loadConvergence(cwd) {
  try {
    const fp = join(getLoopsDir(cwd), CONVERGENCE_FILE);
    if (!existsSync(fp)) return null;
    const state = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    // TTL check
    if (Date.now() - new Date(state.startedAt).getTime() > CONVERGENCE_TTL_MS) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function saveConvergence(cwd, state) {
  const dir = getLoopsDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CONVERGENCE_FILE), JSON.stringify(state, null, 2));
}

function updateConvergence(cwd, checks, maxIterations) {
  const prev = loadConvergence(cwd);
  const failedNames = checks
    .filter((c) => !c.pass && c.blocking)
    .map((c) => c.name);
  const prevFailedNames = prev?.failedChecks || [];

  const improved = prevFailedNames.filter((n) => !failedNames.includes(n));
  const stalled = failedNames.filter((n) => prevFailedNames.includes(n));
  const netStalled =
    prev && failedNames.length >= prevFailedNames.length && improved.length > 0;

  const state = {
    iteration: (prev?.iteration || 0) + 1,
    failedChecks: failedNames,
    improvedChecks: improved,
    stalledChecks: netStalled
      ? [...new Set([...stalled, "net-fail-count-not-decreasing"])]
      : stalled,
    startedAt: prev?.startedAt || new Date().toISOString(),
    lintStrikes: prev?.lintStrikes || 0,
  };

  saveConvergence(cwd, state);

  return {
    converged: state.iteration >= maxIterations && failedNames.length > 0,
    state,
  };
}

/** Reset convergence after successful synthesis/commit. */
export function resetFastGateConvergence(cwd) {
  const fp = join(getLoopsDir(cwd), CONVERGENCE_FILE);
  try {
    if (existsSync(fp)) writeFileSync(fp, "{}");
  } catch {}
}

// ——— Main Gate ———

/**
 * Run the fast gate.
 * @param {string} cwd - Workspace root
 * @param {{ enabled: boolean, mode: string, branchThreshold: number, maxConvergenceIterations: number, lintEscalationStrikes: number, requireCoverage?: boolean }} config
 * @param {{ editedFiles?: string[] }} [opts] - Optional context from audit-gate
 * @returns {{ pass: boolean, blocking: boolean, report: string, checks: Array<{ name: string, pass: boolean, blocking: boolean, message: string }> }}
 */
export function runFastGateHook(cwd, config, opts = {}) {
  if (!config?.enabled) {
    return { pass: true, blocking: false, report: "", checks: [] };
  }

  const contract = readContract(cwd);
  const isEnforce = config.mode === "enforce";
  const checks = [];

  // ── Coverage check ──
  const coverage = readCoverage(cwd);
  if (coverage) {
    // Freshness validation: coverage must be newer than latest edited source
    if (opts.editedFiles?.length > 0 && coverage.generatedAt) {
      let latestSourceMtime = 0;
      for (const f of opts.editedFiles) {
        try {
          const fp = join(cwd, f);
          if (existsSync(fp)) {
            latestSourceMtime = Math.max(
              latestSourceMtime,
              statSync(fp).mtimeMs,
            );
          }
        } catch {}
      }
      if (latestSourceMtime > 0 && latestSourceMtime > coverage.generatedAt) {
        checks.push({
          name: "coverage-stale",
          pass: false,
          blocking: isEnforce,
          message: `Coverage report is stale — generated before latest source changes. Re-run tests to update coverage.`,
        });
      }
    }

    const threshold = config.branchThreshold ?? 70;
    const pass = coverage.pct >= threshold;
    checks.push({
      name: "branch-coverage",
      pass,
      blocking: isEnforce && !pass,
      message: pass
        ? `Branch coverage: ${coverage.pct}% (≥${threshold}%)`
        : `Branch coverage: ${coverage.pct}% (<${threshold}%) — ${coverage.details.filter((d) => d.branchPct < threshold).length} archivos bajo umbral`,
    });

    // Report worst files with granular branch-uncovered IDs
    const worst = coverage.details
      .filter((d) => d.branchPct < threshold)
      .sort((a, b) => a.branchPct - b.branchPct)
      .slice(0, 5);
    if (worst.length > 0) {
      const detailLines = worst.flatMap((w) => {
        const fileHeader = `  ${w.file}: ${w.branchPct}%`;
        if (w.uncoveredBranches?.length > 0) {
          const branchIds = w.uncoveredBranches
            .slice(0, 5)
            .map((b) => `    branch-uncovered:${w.file}:L${b.line}`)
            .join("\n");
          return [fileHeader, branchIds];
        }
        return [fileHeader];
      });
      checks.push({
        name: "branch-coverage-detail",
        pass: false,
        blocking: false,
        message: detailLines.join("\n"),
      });
    }
  } else if (config.requireCoverage && contract?.testCommand) {
    // Missing coverage policy: project has tests but no coverage report
    checks.push({
      name: "coverage-missing",
      pass: false,
      blocking: isEnforce,
      message: `No coverage report found. Project has testCommand (${contract.testCommand}) but no coverage output. Run tests with --coverage.`,
    });
  }

  // ── Lint check ──
  const lintCmd = contract?.lintCommand;
  if (lintCmd) {
    const lintResult = runLint(cwd, lintCmd);
    const convergence = loadConvergence(cwd);
    let lintStrikes = convergence?.lintStrikes || 0;

    if (!lintResult.pass) {
      lintStrikes++;
      const escalated = lintStrikes >= (config.lintEscalationStrikes || 3);
      checks.push({
        name: "lint",
        pass: false,
        blocking: isEnforce && escalated,
        message: escalated
          ? `Lint: ${lintStrikes} fallos consecutivos → ESCALADO a blocking\n${lintResult.output}`
          : `Lint: fallo (strike ${lintStrikes}/${config.lintEscalationStrikes || 3})\n${lintResult.output}`,
      });
    } else {
      lintStrikes = 0;
      checks.push({
        name: "lint",
        pass: true,
        blocking: false,
        message: "Lint: OK",
      });
    }

    // Persist lint strikes
    const conv = loadConvergence(cwd) || {
      startedAt: new Date().toISOString(),
      iteration: 0,
      failedChecks: [],
      improvedChecks: [],
      stalledChecks: [],
    };
    conv.lintStrikes = lintStrikes;
    saveConvergence(cwd, conv);
  }

  // ── Convergence tracking ──
  const maxIter = config.maxConvergenceIterations || 3;
  const failedChecks = checks.filter((c) => !c.pass && c.blocking);
  let converged = false;

  if (failedChecks.length > 0) {
    const result = updateConvergence(cwd, checks, maxIter);
    converged = result.converged;

    if (converged) {
      checks.push({
        name: "convergence-limit",
        pass: false,
        blocking: true,
        message: `Convergencia agotada: ${result.state.iteration} iteraciones. Stalled: ${result.state.stalledChecks.join(", ") || "ninguno"}`,
      });
    }
  }

  // ── Build report ──
  const allPass = checks.every((c) => c.pass);
  const hasBlocking = checks.some((c) => !c.pass && c.blocking);

  const reportLines = checks.map((c) => {
    const icon = c.pass ? "✅" : c.blocking ? "⛔" : "⚠️";
    return `${icon} ${c.message}`;
  });

  const modeTag = isEnforce ? "🔒 ENFORCE" : "📊 REPORT";
  const report =
    reportLines.length > 0
      ? `\n─── Fast Gate (${modeTag}) ───\n${reportLines.join("\n")}\n${"─".repeat(30)}`
      : "";

  return {
    pass: allPass || !hasBlocking,
    blocking: hasBlocking,
    report,
    checks,
  };
}
