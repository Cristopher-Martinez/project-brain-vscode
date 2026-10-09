/**
 * T5 — Mutation Testing Engine
 *
 * Behavioral verification gate: determines if tests detect incorrect behavior.
 * Implements the T5_MUTATION_POLICY.md specification.
 *
 * Design: AST-based mutation, deterministic, sequential, hash-verified rollback.
 * No parallelism in Phase 1 — correctness first, optimization later.
 */

import {
    type Mutant,
    type MutantResult,
    type ModuleScore,
    type MutationOperator,
    type T5Config,
    type T5Deps,
    type T5Result,
    TIER1_OPERATORS,
    TIER2_OPERATORS,
    DEFAULT_T5_CONFIG,
} from './test-gate-mutation-types';

import {
    buildMutatedText,
    executeMutant,
    calculateScore,
    getComplexityPenalty,
    round2,
    countByStatus,
} from './test-gate-mutation-execution';

// ——— Precondition Check ————————————————————————————————————

export interface T5Preconditions {
    readonly t4Passed: boolean;
    readonly hpdScore: number;
}

function checkPreconditions(
    pre: T5Preconditions,
): { ok: boolean; reason?: string } {
    if (!pre.t4Passed) {
        return { ok: false, reason: 'T4-ADS not passed' };
    }
    if (pre.hpdScore < 65) {
        return { ok: false, reason: `HPD score ${pre.hpdScore} < 65` };
    }
    return { ok: true };
}

// ——— Operator Selection ————————————————————————————————————

function getOperators(config: T5Config): MutationOperator[] {
    const ops: MutationOperator[] = [];
    if (config.tiers.includes('Tier1')) {
        ops.push(...TIER1_OPERATORS);
    }
    if (config.tiers.includes('Tier2')) {
        ops.push(...TIER2_OPERATORS);
    }
    return ops;
}

// ——— AST-based Mutant Generation ———————————————————————————

function generateMutantsForFile(
    content: string,
    filePath: string,
    operators: MutationOperator[],
    maxPerFile: number,
    deps: T5Deps,
): Mutant[] {
    const astNodes = deps.parseMutableNodes(content, filePath);
    const lines = content.split('\n');
    const mutants: Mutant[] = [];

    // Operator lookup: original → MutationOperator[]
    const opMap = new Map<string, MutationOperator[]>();
    for (const op of operators) {
        const existing = opMap.get(op.original) || [];
        existing.push(op);
        opMap.set(op.original, existing);
    }

    for (const node of astNodes) {
        if (mutants.length >= maxPerFile) { break; }

        // Skip nodes in log blocks, strings, or type annotations
        if (node.isInLogBlock || node.isInString || node.isInType) {
            continue;
        }

        const matchingOps = opMap.get(node.operatorOrValue) || [];

        for (const op of matchingOps) {
            if (mutants.length >= maxPerFile) { break; }

            const lineContent = lines[node.line - 1] || '';
            const mutatedText = buildMutatedText(content, node, op);

            mutants.push({
                id: `${filePath}:L${node.line}:${op.original}→${op.mutated}`,
                file: filePath,
                line: node.line,
                column: node.column,
                pos: node.pos,
                end: node.end,
                originalText: content.substring(node.pos, node.end),
                mutatedText,
                lineContent: lineContent.trim(),
                operator: op,
                functionName: node.functionName,
                isExported: node.isExported,
                hasInvariant: false,
                astNodeKind: node.kind,
            });
        }
    }

    return mutants;
}

// ——— Skip/Abort Result Builder —————————————————————————————

function buildSkipResult(mode: 'enforce' | 'report'): T5Result {
    return {
        name: 'mutation-testing',
        passed: true,
        blocking: false,
        skipped: true,
        skipReason: 'no_mutable_nodes_found',
        globalScore: null,
        rawGlobalScore: null,
        moduleScores: [],
        totalMutants: 0,
        killed: 0,
        survived: 0,
        timeout: 0,
        equivalentExcluded: 0,
        invalid: 0,
        capped: false,
        mutantsSkippedDueToCap: 0,
        criticalSurvivors: [],
        highSurvivors: [],
        complexityAdjusted: false,
        executionTimeMs: 0,
        filesAnalyzed: 0,
        ready_for_T6: true,
        mode,
        mutantReports: [],
        hashVerified: true,
    };
}

// ——— Main Runner ———————————————————————————————————————————

export async function runT5MutationGate(
    preconditions: T5Preconditions,
    deps: T5Deps,
    config: T5Config = DEFAULT_T5_CONFIG,
): Promise<T5Result> {
    const startTime = Date.now();

    const preCheck = checkPreconditions(preconditions);
    if (!preCheck.ok) {
        deps.log(`[T5] ABORT: ${preCheck.reason}`);
        return {
            ...buildSkipResult(config.mode),
            skipReason: preCheck.reason,
            passed: false,
            blocking: true,
            skipped: false,
        };
    }

    const coreModules = deps.getCoreModules();
    const modifiedFiles = deps.getModifiedFiles();
    const invariantFiles = deps.getInvariantFiles();
    const eligibleFiles = coreModules.filter(f => modifiedFiles.includes(f));

    if (eligibleFiles.length === 0) {
        deps.log('[T5] SKIP: no core modules modified in diff');
        return buildSkipResult(config.mode);
    }

    eligibleFiles.sort();

    const operators = getOperators(config);
    const allMutants: Mutant[] = [];

    for (const file of eligibleFiles) {
        const content = await deps.readFile(file);
        const fileMutants = generateMutantsForFile(
            content, file, operators, config.maxMutantsPerFile, deps,
        );
        const hasInvariant = invariantFiles.includes(file);
        const tagged = fileMutants.map(m => ({ ...m, hasInvariant }));
        allMutants.push(...tagged);
    }

    // Hard cap with transparent reporting
    const capped = allMutants.length > config.maxTotalMutantsPerRun;
    const mutantsSkippedDueToCap = capped
        ? allMutants.length - config.maxTotalMutantsPerRun : 0;
    const cappedMutants = allMutants.slice(0, config.maxTotalMutantsPerRun);

    if (capped) {
        deps.log(`[T5] HARD CAP: ${allMutants.length} → ${config.maxTotalMutantsPerRun} (${mutantsSkippedDueToCap} skipped)`);
    }

    if (cappedMutants.length === 0) {
        deps.log('[T5] SKIP: no mutable nodes found');
        return buildSkipResult(config.mode);
    }

    deps.log(`[T5] Running ${cappedMutants.length} mutants [mode=${config.mode}]`);

    const results: MutantResult[] = [];
    let allHashesMatch = true;

    for (const mutant of cappedMutants) {
        const { result, hashMatch } = await executeMutant(
            mutant, deps, config.mutationTimeoutMs,
        );
        results.push(result);
        if (!hashMatch) { allHashesMatch = false; }
        deps.log(`[T5] ${result.status.toUpperCase()}: ${mutant.id}`);
    }

    if (!allHashesMatch) {
        deps.log('[T5] CRITICAL: hash mismatch — repo may be corrupted');
        return {
            ...buildSkipResult(config.mode),
            passed: false, blocking: true, skipped: false,
            hashVerified: false, mutantReports: results,
            totalMutants: cappedMutants.length,
        };
    }

    // Module scores
    const moduleScores = await buildModuleScores(
        eligibleFiles, results, deps, config,
    );

    // Global score
    const globalKilled = countByStatus(results, 'killed');
    const globalSurvived = countByStatus(results, 'survived');
    const globalScorable = globalKilled + globalSurvived;
    const rawGlobal = globalScorable > 0
        ? (globalKilled / globalScorable) * 100 : 100;
    const avgComplexity = moduleScores.length > 0
        ? moduleScores.reduce((s, m) => s + m.complexity, 0) / moduleScores.length
        : 0;
    const globalPenalty = config.complexityPenaltyEnabled
        ? getComplexityPenalty(avgComplexity) : 0;
    const adjustedGlobal = rawGlobal * (1 - globalPenalty);

    // Critical + high survivors
    const criticalSurvivors = results.filter(r =>
        r.status === 'survived' &&
        r.mutant.operator.tier === 'Tier1' &&
        coreModules.includes(r.mutant.file),
    );
    const highSurvivors = results.filter(r =>
        r.status === 'survived' &&
        r.mutant.operator.tier === 'Tier2' &&
        coreModules.includes(r.mutant.file),
    );

    // Determine pass/fail
    const globalPass = adjustedGlobal >= config.globalMinScore;
    const allModulesPass = moduleScores.every(
        m => m.adjustedScore >= config.coreModuleMinScore,
    );
    const noCritical = criticalSurvivors.length === 0;
    let passed = globalPass && allModulesPass && noCritical;

    if (config.mode === 'report') {
        deps.log(`[T5] MODE=report: would ${passed ? 'PASS' : 'BLOCK'}`);
        passed = true;
    }

    deps.log(`[T5] Global: raw=${rawGlobal.toFixed(1)}% adj=${adjustedGlobal.toFixed(1)}%`);
    deps.log(`[T5] Critical: ${criticalSurvivors.length} | Result: ${passed ? 'PASS' : 'BLOCK'}`);

    return {
        name: 'mutation-testing', passed,
        blocking: !passed, skipped: false,
        globalScore: round2(adjustedGlobal),
        rawGlobalScore: round2(rawGlobal),
        moduleScores,
        totalMutants: cappedMutants.length,
        killed: globalKilled,
        survived: globalSurvived,
        timeout: countByStatus(results, 'timeout'),
        equivalentExcluded: countByStatus(results, 'equivalent'),
        invalid: countByStatus(results, 'invalid'),
        capped, mutantsSkippedDueToCap,
        criticalSurvivors, highSurvivors,
        complexityAdjusted: config.complexityPenaltyEnabled,
        executionTimeMs: Date.now() - startTime,
        filesAnalyzed: eligibleFiles.length,
        ready_for_T6: passed,
        mode: config.mode,
        mutantReports: results,
        hashVerified: allHashesMatch,
    };
}

// ——— Module Scores Builder —————————————————————————————————

async function buildModuleScores(
    files: string[],
    results: MutantResult[],
    deps: T5Deps,
    config: T5Config,
): Promise<ModuleScore[]> {
    const scores: ModuleScore[] = [];
    for (const file of files) {
        const fileResults = results.filter(r => r.mutant.file === file);
        if (fileResults.length === 0) { continue; }

        const complexity = await deps.getComplexity(file);
        const score = calculateScore(
            fileResults, complexity, config.complexityPenaltyEnabled,
        );

        scores.push({
            file,
            rawScore: round2(score.raw),
            complexity,
            penalty: score.penalty,
            adjustedScore: round2(score.adjusted),
            killed: countByStatus(fileResults, 'killed'),
            survived: countByStatus(fileResults, 'survived'),
            timeout: countByStatus(fileResults, 'timeout'),
            equivalentExcluded: countByStatus(fileResults, 'equivalent'),
            invalid: countByStatus(fileResults, 'invalid'),
            totalMutants: fileResults.length,
        });
    }
    return scores;
}

// Re-export types for consumers
export type { T5Result, T5Config, T5Deps, Mutant, MutantResult, ModuleScore };
