/**
 * T5 — Mutation Execution & Scoring Tests
 *
 * Tests for: buildMutatedText, isEquivalentMutation, getComplexityPenalty,
 * calculateScore, countByStatus, round2, executeMutant.
 */

import * as assert from 'assert';
import {
    type Mutant,
    type MutantResult,
    type ASTMutableNode,
    type T5Deps,
    TIER1_OPERATORS,
    TIER2_OPERATORS,
} from '../test-gate-mutation-types';
import {
    buildMutatedText,
    isEquivalentMutation,
    getComplexityPenalty,
    calculateScore,
    countByStatus,
    round2,
    executeMutant,
} from '../test-gate-mutation-execution';

// ——— Helpers ———————————————————————————————————————————————

function makeMutant(overrides: Partial<Mutant> = {}): Mutant {
    return {
        id: 'test:L1:>=→>',
        file: 'test.ts',
        line: 2,
        column: 10,
        pos: 50,
        end: 52,
        originalText: '>=',
        mutatedText: '>',
        lineContent: '    if (x >= 5) {',
        operator: TIER1_OPERATORS[0],
        functionName: 'validate',
        isExported: true,
        hasInvariant: false,
        astNodeKind: 'BinaryExpression',
        ...overrides,
    };
}

function makeResult(
    status: 'killed' | 'survived' | 'timeout' | 'equivalent' | 'invalid',
    mutant?: Mutant,
): MutantResult {
    return {
        mutant: mutant || makeMutant(),
        status,
        executionTimeMs: 10,
    };
}

function makeMockDeps(overrides?: Partial<T5Deps>): T5Deps {
    const content = 'export function test(x: number) { if (x >= 5) { return true; } return false; }';
    return {
        readFile: async () => content,
        writeFile: async () => {},
        runTests: async () => ({ passed: false, failed: true, testName: 'test_1', durationMs: 5 }),
        getComplexity: async () => 5,
        getCoreModules: () => ['test.ts'],
        getModifiedFiles: () => ['test.ts'],
        getInvariantFiles: () => [],
        log: () => {},
        parseMutableNodes: () => [],
        validateSyntax: () => true,
        computeHash: (c: string) => `hash_${c.length}`,
        ...overrides,
    };
}

// ——— Tests —————————————————————————————————————————————————

suite('T5 Execution & Scoring', () => {

    suite('buildMutatedText', () => {
        test('simple operator replacement', () => {
            const node: ASTMutableNode = {
                kind: 'BinaryExpression', operatorOrValue: '>=',
                pos: 0, end: 2, line: 1, column: 1,
                functionName: 'test', isExported: true,
                isInLogBlock: false, isInString: false, isInType: false,
            };
            const result = buildMutatedText('>=', node, TIER1_OPERATORS[0]);
            assert.strictEqual(result, '>');
        });

        test('compound operator (+ 1 → - 1) swaps sign', () => {
            const node: ASTMutableNode = {
                kind: 'BinaryExpression', operatorOrValue: '+ 1',
                pos: 0, end: 3, line: 1, column: 1,
                functionName: 'test', isExported: true,
                isInLogBlock: false, isInString: false, isInType: false,
            };
            const result = buildMutatedText('+ 1', node, TIER2_OPERATORS[0]);
            assert.strictEqual(result, '- 1');
        });
    });

    suite('isEquivalentMutation', () => {
        test('detects x + 0 as equivalent', () => {
            const m = makeMutant({ lineContent: 'return x + 0;' });
            assert.strictEqual(isEquivalentMutation(m), true);
        });

        test('detects if (true) as equivalent', () => {
            const m = makeMutant({ lineContent: 'if (true) {' });
            assert.strictEqual(isEquivalentMutation(m), true);
        });

        test('regular code is NOT equivalent', () => {
            const m = makeMutant({ lineContent: 'if (x >= 5) {' });
            assert.strictEqual(isEquivalentMutation(m), false);
        });

        test('detects .length > 0 as equivalent', () => {
            const m = makeMutant({ lineContent: 'if (arr.length > 0) {' });
            assert.strictEqual(isEquivalentMutation(m), true);
        });

        test('detects && true as equivalent', () => {
            const m = makeMutant({ lineContent: 'return x && true;' });
            assert.strictEqual(isEquivalentMutation(m), true);
        });
    });

    suite('getComplexityPenalty', () => {
        test('0% for complexity 1-10', () => {
            assert.strictEqual(getComplexityPenalty(5), 0);
            assert.strictEqual(getComplexityPenalty(10), 0);
        });

        test('3% for complexity 11-15', () => {
            assert.strictEqual(getComplexityPenalty(12), 0.03);
        });

        test('8% for complexity 16-20', () => {
            assert.strictEqual(getComplexityPenalty(18), 0.08);
        });

        test('15% for complexity 21+', () => {
            assert.strictEqual(getComplexityPenalty(25), 0.15);
        });
    });

    suite('calculateScore', () => {
        test('100% when all killed', () => {
            const results = [makeResult('killed'), makeResult('killed')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 100);
        });

        test('0% when all survived', () => {
            const results = [makeResult('survived'), makeResult('survived')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 0);
        });

        test('50% when half killed half survived', () => {
            const results = [makeResult('killed'), makeResult('survived')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 50);
        });

        test('timeout excluded from denominator', () => {
            const results = [makeResult('killed'), makeResult('timeout')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 100);
        });

        test('equivalent excluded from denominator', () => {
            const results = [makeResult('killed'), makeResult('equivalent')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 100);
        });

        test('invalid excluded from denominator', () => {
            const results = [makeResult('killed'), makeResult('invalid')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 100);
        });

        test('complexity penalty applied to adjusted', () => {
            const results = [makeResult('killed')];
            const score = calculateScore(results, 18, true);
            assert.strictEqual(score.raw, 100);
            assert.strictEqual(score.penalty, 0.08);
            assert.strictEqual(score.adjusted, 92);
        });

        test('100% when no scorable results', () => {
            const results = [makeResult('timeout'), makeResult('equivalent')];
            const score = calculateScore(results, 5, false);
            assert.strictEqual(score.raw, 100);
        });
    });

    suite('countByStatus', () => {
        test('counts correctly', () => {
            const results = [
                makeResult('killed'), makeResult('killed'),
                makeResult('survived'), makeResult('timeout'),
            ];
            assert.strictEqual(countByStatus(results, 'killed'), 2);
            assert.strictEqual(countByStatus(results, 'survived'), 1);
            assert.strictEqual(countByStatus(results, 'timeout'), 1);
            assert.strictEqual(countByStatus(results, 'equivalent'), 0);
        });
    });

    suite('round2', () => {
        test('rounds to 2 decimal places', () => {
            assert.strictEqual(round2(3.14159), 3.14);
            assert.strictEqual(round2(100), 100);
            assert.strictEqual(round2(66.666), 66.67);
        });
    });

    suite('executeMutant', () => {
        test('killed when test fails after mutation', async () => {
            const deps = makeMockDeps({
                runTests: async () => ({
                    passed: false, failed: true,
                    testName: 'test_boundary', durationMs: 5,
                }),
            });
            const mutant = makeMutant({ pos: 34, end: 36 });
            const { result, hashMatch } = await executeMutant(mutant, deps, 30000);
            assert.strictEqual(result.status, 'killed');
            assert.strictEqual(result.killedBy, 'test_boundary');
            assert.strictEqual(hashMatch, true);
        });

        test('survived when tests pass', async () => {
            const deps = makeMockDeps({
                runTests: async () => ({
                    passed: true, failed: false, durationMs: 5,
                }),
            });
            const mutant = makeMutant({ pos: 34, end: 36 });
            const { result } = await executeMutant(mutant, deps, 30000);
            assert.strictEqual(result.status, 'survived');
        });

        test('invalid when syntax check fails', async () => {
            const deps = makeMockDeps({ validateSyntax: () => false });
            const mutant = makeMutant({ pos: 34, end: 36 });
            const { result, hashMatch } = await executeMutant(mutant, deps, 30000);
            assert.strictEqual(result.status, 'invalid');
            assert.strictEqual(hashMatch, true);
        });

        test('equivalent detected before execution', async () => {
            const deps = makeMockDeps();
            const mutant = makeMutant({
                lineContent: 'return x + 0;',
                pos: 34, end: 36,
            });
            const { result } = await executeMutant(mutant, deps, 30000);
            assert.strictEqual(result.status, 'equivalent');
        });

        test('hash mismatch flagged', async () => {
            let hashCount = 0;
            const deps = makeMockDeps({
                computeHash: () => `hash_${hashCount++}`,
            });
            const mutant = makeMutant({ pos: 34, end: 36 });
            const { hashMatch } = await executeMutant(mutant, deps, 30000);
            assert.strictEqual(hashMatch, false);
        });
    });
});
