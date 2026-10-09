/**
 * T5 — Mutation Execution & Scoring
 *
 * Extracted from test-gate-mutation.ts to keep files under 400 lines.
 * Contains: single mutant execution, equivalent detection, complexity
 * penalty, score calculation, and utility helpers.
 */

import {
    type Mutant,
    type MutantResult,
    type MutantStatus,
    type MutationOperator,
    type ASTMutableNode,
    type T5Deps,
    EQUIVALENT_PATTERNS,
    COMPLEXITY_PENALTIES,
} from './test-gate-mutation-types';

// ——— Mutated Text Builder ——————————————————————————————————

export function buildMutatedText(
    content: string,
    node: ASTMutableNode,
    op: MutationOperator,
): string {
    const actual = content.substring(node.pos, node.end);
    // For compound operators (+ 1, - 1), swap only the sign
    if (op.original === '+ 1' || op.original === '- 1') {
        return actual.replace(/[+-]/, op.mutated[0]);
    }
    return op.mutated;
}

// ——— Equivalent Detection ——————————————————————————————————

export function isEquivalentMutation(mutant: Mutant): boolean {
    return EQUIVALENT_PATTERNS.some(p => p.test(mutant.lineContent));
}

// ——— Complexity Penalty ————————————————————————————————————

export function getComplexityPenalty(complexity: number): number {
    for (const cp of COMPLEXITY_PENALTIES) {
        if (complexity >= cp.minComplexity && complexity <= cp.maxComplexity) {
            return cp.penalty;
        }
    }
    return 0;
}

// ——— Score Calculation ——————————————————————————————————————

export function calculateScore(
    results: MutantResult[],
    complexity: number,
    penaltyEnabled: boolean,
): { raw: number; adjusted: number; penalty: number } {
    const killed = results.filter(r => r.status === 'killed').length;
    const survived = results.filter(r => r.status === 'survived').length;
    const scorable = killed + survived;

    if (scorable === 0) {
        return { raw: 100, adjusted: 100, penalty: 0 };
    }

    const raw = (killed / scorable) * 100;
    const penalty = penaltyEnabled ? getComplexityPenalty(complexity) : 0;
    const adjusted = raw * (1 - penalty);

    return { raw, adjusted, penalty };
}

// ——— Helpers ———————————————————————————————————————————————

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function countByStatus(
    results: MutantResult[],
    status: MutantStatus,
): number {
    return results.filter(r => r.status === status).length;
}

// ——— Single Mutant Execution (AST-guided, hash-verified) ———

export interface ExecutionResult {
    result: MutantResult;
    hashMatch: boolean;
}

export async function executeMutant(
    mutant: Mutant,
    deps: T5Deps,
    timeoutMs: number,
): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Check for equivalent mutation first
    if (isEquivalentMutation(mutant)) {
        return {
            result: {
                mutant, status: 'equivalent',
                executionTimeMs: Date.now() - startTime,
            },
            hashMatch: true,
        };
    }

    // Read original content + snapshot hash
    const original = await deps.readFile(mutant.file);
    const originalHash = deps.computeHash(original);

    // Apply AST-guided mutation (position-based, not text-based)
    const mutated = original.substring(0, mutant.pos) +
        mutant.mutatedText +
        original.substring(mutant.end);

    // Validate syntax — if invalid, skip without touching file
    if (!deps.validateSyntax(mutated, mutant.file)) {
        deps.log(`[T5] INVALID: ${mutant.id} — syntax error after mutation`);
        return {
            result: {
                mutant, status: 'invalid',
                executionTimeMs: Date.now() - startTime,
            },
            hashMatch: true,
        };
    }

    let status: MutantStatus = 'survived';
    let killedBy: string | undefined;

    try {
        await deps.writeFile(mutant.file, mutated);

        const testPromise = deps.runTests(mutant.file);
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), timeoutMs),
        );

        const result = await Promise.race([testPromise, timeoutPromise]);

        if (result === 'timeout') {
            status = 'timeout';
        } else if (result.failed) {
            status = 'killed';
            killedBy = result.testName;
        }
    } finally {
        // ALWAYS restore — even if process crashes
        await deps.writeFile(mutant.file, original);
    }

    // Verify hash after restoration
    const restored = await deps.readFile(mutant.file);
    const restoredHash = deps.computeHash(restored);
    const hashMatch = originalHash === restoredHash;

    if (!hashMatch) {
        deps.log(
            `[T5] CRITICAL: hash mismatch after restoring ${mutant.file}!`,
        );
    }

    return {
        result: {
            mutant, status, killedBy,
            executionTimeMs: Date.now() - startTime,
        },
        hashMatch,
    };
}
