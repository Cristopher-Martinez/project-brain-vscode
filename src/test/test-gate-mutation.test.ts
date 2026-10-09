/**
 * T5 — Mutation Testing Engine Tests (Core)
 *
 * Core functionality: preconditions, AST generation, kill/survived,
 * timeout, scoring, critical survivors.
 */

import * as assert from 'assert';
import {
    type T5Deps,
    type T5Config,
    type ASTMutableNode,
    type TestRunResult,
    DEFAULT_T5_CONFIG,
    TIER1_OPERATORS,
} from '../test-gate-mutation-types';
import { runT5MutationGate, type T5Preconditions } from '../test-gate-mutation';

// ——— Sample Data ———————————————————————————————————————————

function sampleCoreFile(): string {
    return [
        'export function validate(x: number): boolean {',
        '    if (x >= 5) {',
        '        return true;',
        '    }',
        '    return false;',
        '}',
    ].join('\n');
}

/** Find position of a substring in content (1-based line/col). */
function findPosition(
    content: string,
    search: string,
    occurrence: number = 1,
): { pos: number; end: number; line: number; column: number } {
    let idx = -1;
    for (let i = 0; i < occurrence; i++) {
        idx = content.indexOf(search, idx + 1);
        if (idx === -1) {
            throw new Error(`"${search}" not found (occurrence ${occurrence})`);
        }
    }
    const before = content.substring(0, idx);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    const column = idx - lastNewline;
    return { pos: idx, end: idx + search.length, line, column };
}

/** Create mock AST nodes for the sample core file. */
function sampleASTNodes(content: string): ASTMutableNode[] {
    const ge = findPosition(content, '>=');
    const trueKw = findPosition(content, 'true');
    const falseKw = findPosition(content, 'false');
    return [
        {
            kind: 'BinaryExpression', operatorOrValue: '>=',
            ...ge, functionName: 'validate', isExported: true,
            isInLogBlock: false, isInString: false, isInType: false,
        },
        {
            kind: 'BooleanLiteral', operatorOrValue: 'true',
            ...trueKw, functionName: 'validate', isExported: true,
            isInLogBlock: false, isInString: false, isInType: false,
        },
        {
            kind: 'BooleanLiteral', operatorOrValue: 'false',
            ...falseKw, functionName: 'validate', isExported: true,
            isInLogBlock: false, isInString: false, isInType: false,
        },
    ];
}

// ——— Mock Factory ——————————————————————————————————————————

function createMockDeps(overrides?: Partial<T5Deps>): T5Deps {
    const code = sampleCoreFile();
    const files = new Map<string, string>([['core.ts', code]]);

    return {
        readFile: async (p: string) => files.get(p) || '',
        writeFile: async (p: string, c: string) => { files.set(p, c); },
        runTests: async () => ({ passed: false, failed: true, testName: 'test_validate', durationMs: 10 }),
        getComplexity: async () => 5,
        getCoreModules: () => ['core.ts'],
        getModifiedFiles: () => ['core.ts'],
        getInvariantFiles: () => ['core.ts'],
        log: () => {},
        parseMutableNodes: (content: string) => sampleASTNodes(content),
        validateSyntax: () => true,
        computeHash: (c: string) => `hash_${c.length}`,
        ...overrides,
    };
}

function validPreconditions(): T5Preconditions {
    return { t4Passed: true, hpdScore: 75 };
}

function enforceConfig(overrides?: Partial<T5Config>): T5Config {
    return { ...DEFAULT_T5_CONFIG, mode: 'enforce', ...overrides };
}

// ——— Tests —————————————————————————————————————————————————

suite('T5 Mutation Gate — Core', () => {

    // Preconditions
    suite('Preconditions', () => {
        test('ABORT if T4 not passed', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                { t4Passed: false, hpdScore: 80 }, deps, enforceConfig(),
            );
            assert.strictEqual(result.passed, false);
            assert.strictEqual(result.blocking, true);
            assert.ok(result.skipReason?.includes('T4'));
        });

        test('ABORT if HPD < 65', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                { t4Passed: true, hpdScore: 50 }, deps, enforceConfig(),
            );
            assert.strictEqual(result.passed, false);
            assert.ok(result.skipReason?.includes('HPD'));
        });

        test('PASS preconditions when OK', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.skipped, false);
        });
    });

    // Skip scenarios
    suite('Skip Scenarios', () => {
        test('SKIP if no core module modified', async () => {
            const deps = createMockDeps({ getModifiedFiles: () => ['other.ts'] });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.passed, true);
            assert.strictEqual(result.globalScore, null);
        });

        test('SKIP if no mutable AST nodes', async () => {
            const deps = createMockDeps({
                parseMutableNodes: () => [],
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.passed, true);
        });
    });

    // AST-based generation
    suite('AST-based Generation', () => {
        test('generates mutants from AST nodes', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.ok(result.totalMutants > 0, 'should generate mutants');
            assert.strictEqual(result.skipped, false);
        });

        test('respects maxMutantsPerFile', async () => {
            const deps = createMockDeps();
            const config = enforceConfig({ maxMutantsPerFile: 1 });
            const result = await runT5MutationGate(
                validPreconditions(), deps, config,
            );
            assert.ok(result.totalMutants <= 1);
        });

        test('skips log block nodes', async () => {
            const deps = createMockDeps({
                parseMutableNodes: () => [{
                    kind: 'BinaryExpression' as const,
                    operatorOrValue: '>=',
                    pos: 10, end: 12, line: 1, column: 10,
                    functionName: 'test', isExported: true,
                    isInLogBlock: true, isInString: false, isInType: false,
                }],
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.totalMutants, 0);
        });

        test('skips string-embedded nodes', async () => {
            const deps = createMockDeps({
                parseMutableNodes: () => [{
                    kind: 'BinaryExpression' as const,
                    operatorOrValue: '>=',
                    pos: 10, end: 12, line: 1, column: 10,
                    functionName: 'test', isExported: true,
                    isInLogBlock: false, isInString: true, isInType: false,
                }],
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.skipped, true);
        });
    });

    // Kill detection
    suite('Kill Detection', () => {
        test('marks killed when test fails', async () => {
            const deps = createMockDeps({
                runTests: async () => ({
                    passed: false, failed: true,
                    testName: 'test_boundary', durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.ok(result.killed > 0, 'should have killed mutants');
        });

        test('marks survived when tests pass', async () => {
            const deps = createMockDeps({
                runTests: async () => ({
                    passed: true, failed: false, durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.ok(result.survived > 0, 'should have survived mutants');
        });
    });

    // Timeout handling
    suite('Timeout', () => {
        test('timeout excluded from score denominator', async () => {
            const timedOutFn = async (): Promise<TestRunResult> => {
                return new Promise((resolve) => {
                    setTimeout(() => resolve({
                        passed: true, failed: false, durationMs: 999,
                    }), 200);
                });
            };
            const deps = createMockDeps({ runTests: timedOutFn });
            const config = enforceConfig({ mutationTimeoutMs: 10 });
            const result = await runT5MutationGate(
                validPreconditions(), deps, config,
            );
            assert.ok(result.timeout > 0, 'should have timeouts');
            assert.strictEqual(result.survived, 0, 'timeout != survived');
        });
    });

    // Score thresholds
    suite('Score Thresholds', () => {
        test('BLOCK when adjusted score < 65% (enforce)', async () => {
            const deps = createMockDeps({
                runTests: async () => ({
                    passed: true, failed: false, durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            // All survived → score 0% → BLOCK
            assert.strictEqual(result.passed, false);
            assert.strictEqual(result.blocking, true);
        });

        test('PASS when score >= 65% (enforce)', async () => {
            // Return AST nodes where only one matches Tier1
            const code = sampleCoreFile();
            const ge = findPosition(code, '>=');
            const deps = createMockDeps({
                parseMutableNodes: () => [{
                    kind: 'BinaryExpression' as const,
                    operatorOrValue: '>=',
                    ...ge, functionName: 'validate', isExported: true,
                    isInLogBlock: false, isInString: false, isInType: false,
                }],
                runTests: async () => ({
                    passed: false, failed: true,
                    testName: 'test_boundary', durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig({ tiers: ['Tier1'] }),
            );
            assert.strictEqual(result.passed, true);
            assert.ok((result.globalScore ?? 0) >= 65);
        });
    });

    // Critical survivors
    suite('Critical Survivors', () => {
        test('Tier1 in core → critical → block in enforce', async () => {
            const code = sampleCoreFile();
            const ge = findPosition(code, '>=');
            const deps = createMockDeps({
                parseMutableNodes: () => [{
                    kind: 'BinaryExpression' as const,
                    operatorOrValue: '>=',
                    ...ge, functionName: 'validate', isExported: true,
                    isInLogBlock: false, isInString: false, isInType: false,
                }],
                runTests: async () => ({
                    passed: true, failed: false, durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig({ tiers: ['Tier1'] }),
            );
            assert.ok(result.criticalSurvivors.length > 0);
            assert.strictEqual(result.passed, false);
        });
    });

    // Module scores
    suite('Module Scores', () => {
        test('produces per-file module score', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.moduleScores.length, 1);
            assert.strictEqual(result.moduleScores[0].file, 'core.ts');
        });
    });
});
