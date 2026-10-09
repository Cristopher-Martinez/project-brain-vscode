/**
 * T5 — Mutation Testing Hardening Tests
 *
 * Tests for: invalid mutant detection, hash verification,
 * hard cap reporting, report mode, complexity penalty, determinism.
 */

import * as assert from 'assert';
import {
    type T5Deps,
    type T5Config,
    type ASTMutableNode,
    DEFAULT_T5_CONFIG,
} from '../test-gate-mutation-types';
import { runT5MutationGate, type T5Preconditions } from '../test-gate-mutation';

// ——— Shared Helpers ————————————————————————————————————————

function sampleCoreFile(): string {
    return [
        'export function validate(x: number): boolean {',
        '    if (x >= 0) {',
        '        return true;',
        '    }',
        '    return false;',
        '}',
    ].join('\n');
}

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

function createMockDeps(overrides?: Partial<T5Deps>): T5Deps {
    const code = sampleCoreFile();
    const files = new Map<string, string>([['core.ts', code]]);

    return {
        readFile: async (p: string) => files.get(p) || '',
        writeFile: async (p: string, c: string) => { files.set(p, c); },
        runTests: async () => ({
            passed: false, failed: true,
            testName: 'test_validate', durationMs: 10,
        }),
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

function reportConfig(overrides?: Partial<T5Config>): T5Config {
    return { ...DEFAULT_T5_CONFIG, mode: 'report', ...overrides };
}

// ——— Tests —————————————————————————————————————————————————

suite('T5 Mutation Gate — Hardening', () => {

    // Invalid mutant detection
    suite('Invalid Mutant Detection', () => {
        test('invalid syntax → status invalid, excluded from score', async () => {
            const deps = createMockDeps({
                validateSyntax: () => false,
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.ok(result.invalid > 0, 'should have invalid mutants');
            // Score should be 100% when all are invalid (scorable = 0)
            assert.strictEqual(result.globalScore, 100);
        });

        test('mixed valid/invalid: only valid affect score', async () => {
            let callCount = 0;
            const deps = createMockDeps({
                validateSyntax: () => {
                    callCount++;
                    return callCount <= 1; // first valid, rest invalid
                },
                runTests: async () => ({
                    passed: false, failed: true,
                    testName: 'test_boundary', durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.ok(result.invalid > 0);
            assert.ok(result.killed > 0);
        });
    });

    // Hash verification
    suite('Hash Verification', () => {
        test('PASS when hash matches after restore', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.hashVerified, true);
        });

        test('FAIL when hash mismatch after restore', async () => {
            let hashCallCount = 0;
            const deps = createMockDeps({
                computeHash: () => {
                    hashCallCount++;
                    return `hash_${hashCallCount}`; // always different
                },
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.hashVerified, false);
            assert.strictEqual(result.passed, false);
            assert.strictEqual(result.blocking, true);
        });

        test('file is always restored after mutation', async () => {
            const writes: Array<{ path: string; content: string }> = [];
            const code = sampleCoreFile();
            const deps = createMockDeps({
                writeFile: async (p: string, c: string) => {
                    writes.push({ path: p, content: c });
                },
            });
            await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            // Last write for each file should be the original
            const coreWrites = writes.filter(w => w.path === 'core.ts');
            if (coreWrites.length > 0) {
                const lastWrite = coreWrites[coreWrites.length - 1];
                assert.strictEqual(lastWrite.content, code);
            }
        });
    });

    // Hard cap reporting
    suite('Hard Cap Reporting', () => {
        test('reports when cap is triggered', async () => {
            const manyNodes: ASTMutableNode[] = [];
            const code = sampleCoreFile();
            const ge = findPosition(code, '>=');
            for (let i = 0; i < 200; i++) {
                manyNodes.push({
                    kind: 'BinaryExpression', operatorOrValue: '>=',
                    ...ge, functionName: `fn${i}`, isExported: true,
                    isInLogBlock: false, isInString: false, isInType: false,
                });
            }
            const deps = createMockDeps({
                parseMutableNodes: () => manyNodes,
            });
            const config = enforceConfig({
                maxMutantsPerFile: 200,
                maxTotalMutantsPerRun: 10,
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, config,
            );
            assert.strictEqual(result.capped, true);
            assert.strictEqual(result.mutantsSkippedDueToCap, 190);
            assert.strictEqual(result.totalMutants, 10);
        });

        test('no cap when under limit', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            assert.strictEqual(result.capped, false);
            assert.strictEqual(result.mutantsSkippedDueToCap, 0);
        });
    });

    // Report mode (calibration)
    suite('Report Mode', () => {
        test('report mode always passes even with failures', async () => {
            const deps = createMockDeps({
                runTests: async () => ({
                    passed: true, failed: false, durationMs: 5,
                }),
            });
            const result = await runT5MutationGate(
                validPreconditions(), deps, reportConfig(),
            );
            // All survived → would block in enforce
            assert.strictEqual(result.passed, true, 'report mode must pass');
            assert.strictEqual(result.mode, 'report');
        });

        test('report mode still computes scores accurately', async () => {
            const deps = createMockDeps();
            const result = await runT5MutationGate(
                validPreconditions(), deps, reportConfig(),
            );
            assert.notStrictEqual(result.globalScore, null);
            assert.ok(result.moduleScores.length > 0);
        });
    });

    // Complexity penalty
    suite('Complexity Penalty', () => {
        test('no penalty for complexity 1-10', async () => {
            const deps = createMockDeps({ getComplexity: async () => 5 });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            if (result.moduleScores.length > 0) {
                assert.strictEqual(result.moduleScores[0].penalty, 0);
            }
        });

        test('8% penalty for complexity 16-20', async () => {
            const deps = createMockDeps({ getComplexity: async () => 18 });
            const result = await runT5MutationGate(
                validPreconditions(), deps, enforceConfig(),
            );
            if (result.moduleScores.length > 0) {
                assert.strictEqual(result.moduleScores[0].penalty, 0.08);
            }
        });
    });

    // Determinism
    suite('Determinism', () => {
        test('same input → same result', async () => {
            const deps1 = createMockDeps();
            const deps2 = createMockDeps();
            const config = enforceConfig();
            const r1 = await runT5MutationGate(validPreconditions(), deps1, config);
            const r2 = await runT5MutationGate(validPreconditions(), deps2, config);
            assert.strictEqual(r1.totalMutants, r2.totalMutants);
            assert.strictEqual(r1.killed, r2.killed);
            assert.strictEqual(r1.survived, r2.survived);
            assert.strictEqual(r1.globalScore, r2.globalScore);
        });
    });
});
