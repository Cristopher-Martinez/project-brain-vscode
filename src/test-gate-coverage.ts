/**
 * test-gate-coverage.ts — Coverage report parsing + invariant mapping (T2).
 *
 * Parses LCOV and Istanbul JSON coverage reports, extracts uncovered branches,
 * and maps them to invariant IDs for actionable GateCheck results.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md (T2)
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { log, logWarn } from './logger';
import type {
  FileCoverageSummary,
  GateCheck,
  InvariantRecord,
  UncoveredBranch,
} from './test-pipeline-types';

const MAX_BRANCH_CHECKS = 20;

/** Parse LCOV format into per-file coverage summaries. */
export function parseLcov(lcovContent: string): FileCoverageSummary[] {
  const files: FileCoverageSummary[] = [];
  let current: FileCoverageSummary | null = null;
  let branchTotal = 0;
  let branchHit = 0;

  for (const line of lcovContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SF:')) {
      current = { file: trimmed.slice(3), branchPct: 100, linePct: 100, uncoveredBranches: [] };
      branchTotal = 0;
      branchHit = 0;
    } else if (trimmed.startsWith('BRDA:') && current) {
      // BRDA:line,block,branch,hits
      const parts = trimmed.slice(5).split(',');
      if (parts.length >= 4) {
        const lineNum = parseInt(parts[0], 10);
        const branchIdx = parts[2];
        const hits = parts[3] === '-' ? 0 : parseInt(parts[3], 10);
        branchTotal++;
        if (hits > 0) { branchHit++; }
        if (hits === 0) {
          current.uncoveredBranches.push({
            file: current.file,
            line: lineNum,
            branch: `branch-${branchIdx}`,
            hits: 0,
          });
        }
      }
    } else if (trimmed.startsWith('BRF:')) {
      branchTotal = parseInt(trimmed.slice(4), 10) || branchTotal;
    } else if (trimmed.startsWith('BRH:')) {
      branchHit = parseInt(trimmed.slice(4), 10) || branchHit;
    } else if (trimmed.startsWith('LF:') && current) {
      // total lines — we'll compute pct at end_of_record
    } else if (trimmed.startsWith('LH:') && current) {
      // hit lines
    } else if (trimmed === 'end_of_record' && current) {
      current.branchPct = branchTotal > 0 ? Math.round((branchHit / branchTotal) * 100) : 100;
      files.push(current);
      current = null;
    }
  }
  return files;
}

/** Parse Istanbul JSON format (from jest/vitest --coverage --json). */
export function parseIstanbulJson(
  jsonContent: string,
  wsRoot: string
): FileCoverageSummary[] {
  const files: FileCoverageSummary[] = [];
  try {
    const report = JSON.parse(jsonContent) as Record<string, IstanbulFileCoverage>;
    for (const [filePath, fileCov] of Object.entries(report)) {
      const relPath = relative(wsRoot, filePath).replace(/\\/g, '/');
      const uncovered: UncoveredBranch[] = [];
      let branchTotal = 0;
      let branchHit = 0;

      if (fileCov.branchMap && fileCov.b) {
        for (const [branchId, locs] of Object.entries(fileCov.branchMap)) {
          const counts = fileCov.b[branchId] || [];
          for (let i = 0; i < counts.length; i++) {
            branchTotal++;
            if (counts[i] > 0) { branchHit++; }
            else {
              const loc = locs.locations?.[i] || locs.loc;
              uncovered.push({
                file: relPath,
                line: loc?.start?.line || 0,
                branch: `${locs.type || 'branch'}-${branchId}[${i}]`,
                hits: 0,
              });
            }
          }
        }
      }

      files.push({
        file: relPath,
        branchPct: branchTotal > 0 ? Math.round((branchHit / branchTotal) * 100) : 100,
        linePct: 100, // simplified — line coverage is secondary
        uncoveredBranches: uncovered,
      });
    }
  } catch (e) {
    logWarn(`[FastGate] Failed to parse Istanbul JSON: ${e}`);
  }
  return files;
}

/** Istanbul JSON internal types. */
interface IstanbulFileCoverage {
  branchMap: Record<string, {
    type?: string;
    loc?: { start: { line: number } };
    locations?: Array<{ start: { line: number } }>;
  }>;
  b: Record<string, number[]>;
}

/** Detect and parse coverage report from common locations. */
export function findAndParseCoverage(wsRoot: string): FileCoverageSummary[] {
  const lcovPaths = [
    'coverage/lcov.info',
    'coverage/lcov/lcov.info',
  ];
  for (const p of lcovPaths) {
    const full = join(wsRoot, p);
    if (existsSync(full)) {
      log(`[FastGate] Parsing LCOV: ${p}`);
      return parseLcov(readFileSync(full, 'utf-8'));
    }
  }

  const istanbulPaths = [
    'coverage/coverage-final.json',
    'coverage/coverage-summary.json',
  ];
  for (const p of istanbulPaths) {
    const full = join(wsRoot, p);
    if (existsSync(full)) {
      log(`[FastGate] Parsing Istanbul JSON: ${p}`);
      return parseIstanbulJson(readFileSync(full, 'utf-8'), wsRoot);
    }
  }

  logWarn('[FastGate] No coverage report found');
  return [];
}

/** Map uncovered branches to invariant IDs from INVARIANTS.md records. */
export function mapBranchesToInvariants(
  branches: UncoveredBranch[],
  invariants: InvariantRecord[]
): GateCheck[] {
  const checks: GateCheck[] = [];
  // Sort: branches in invariant-covered files first, then by line
  const sorted = [...branches].sort((a, b) => {
    const aMatch = invariants.some(inv =>
      inv.files.some(f => a.file.includes(f) || f.includes(a.file)));
    const bMatch = invariants.some(inv =>
      inv.files.some(f => b.file.includes(f) || f.includes(b.file)));
    if (aMatch !== bMatch) { return aMatch ? -1 : 1; }
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
  const limited = sorted.slice(0, MAX_BRANCH_CHECKS);

  for (const branch of limited) {
    const normalFile = branch.file.replace(/\\/g, '/');
    const matchedInvariant = invariants.find(inv =>
      inv.files.some(f => {
        const normF = f.replace(/\\/g, '/');
        return normalFile.includes(normF) || normF.includes(normalFile);
      })
    );
    const checkName = `branch-uncovered:${normalFile}:L${branch.line}`;

    checks.push({
      name: checkName,
      passed: false,
      blocking: false,
      explanation: `Branch no cubierta: ${branch.file}:L${branch.line} (${branch.branch})`,
      location: {
        file: branch.file,
        line: branch.line,
        branch: branch.branch,
      },
      invariantId: matchedInvariant?.id,
      suggestion: matchedInvariant
        ? `Agregar test para ${branch.branch} — vinculado a invariante "${matchedInvariant.id}"`
        : `Agregar test para ${branch.branch}`,
    });
  }

  return checks;
}

/** Calculate aggregate branch coverage percentage. */
export function calculateAggregateCoverage(
  summaries: FileCoverageSummary[]
): number {
  if (summaries.length === 0) { return 100; }
  let totalBranches = 0;
  let coveredBranches = 0;
  for (const s of summaries) {
    const total = s.uncoveredBranches.length > 0
      ? Math.round(s.uncoveredBranches.length / (1 - s.branchPct / 100)) || 0
      : 0;
    totalBranches += total;
    coveredBranches += total - s.uncoveredBranches.length;
  }
  if (totalBranches === 0) { return 100; }
  return Math.round((coveredBranches / totalBranches) * 100);
}
