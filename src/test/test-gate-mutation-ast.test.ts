/**
 * T5 — AST Parser Tests
 *
 * Tests for the TypeScript AST-based mutation node parser.
 * Verifies correct identification of mutable nodes, context tracking,
 * syntax validation, and hash computation.
 */

import * as assert from 'assert';
import {
    parseMutableNodes,
    validateSyntax,
    computeHash,
} from '../test-gate-mutation-ast';

// ——— Sample Code ———————————————————————————————————————————

const SIMPLE_FUNCTION = [
    'export function validate(x: number): boolean {',
    '    if (x >= 0) {',
    '        return true;',
    '    }',
    '    return false;',
    '}',
].join('\n');

const FUNCTION_WITH_LOG = [
    'export function process(x: number): number {',
    '    console.log(x >= 0);',
    '    if (x >= 0) {',
    '        return x + 1;',
    '    }',
    '    return x - 1;',
    '}',
].join('\n');

const STRING_WITH_OPERATORS = [
    'export function getMessage(): string {',
    '    return "x >= 0 is " + (x >= 0 ? "yes" : "no");',
    '}',
].join('\n');

const TYPE_ANNOTATIONS = [
    'interface Config {',
    '    enabled: boolean;',
    '    threshold: number;',
    '}',
    'export function check(c: Config): boolean {',
    '    return c.enabled === true;',
    '}',
].join('\n');

const LOGICAL_EXPRESSIONS = [
    'export function guard(a: boolean, b: boolean): boolean {',
    '    return a && b || false;',
    '}',
].join('\n');

// ——— Tests —————————————————————————————————————————————————

suite('T5 AST Parser', () => {

    suite('parseMutableNodes', () => {
        test('finds binary operators (>=, ===)', () => {
            const nodes = parseMutableNodes(SIMPLE_FUNCTION, 'test.ts');
            const geNode = nodes.find(n => n.operatorOrValue === '>=');
            assert.ok(geNode, 'should find >= operator');
            assert.strictEqual(geNode.kind, 'BinaryExpression');
            assert.strictEqual(geNode.functionName, 'validate');
            assert.strictEqual(geNode.isExported, true);
        });

        test('finds boolean literals (true, false)', () => {
            const nodes = parseMutableNodes(SIMPLE_FUNCTION, 'test.ts');
            const trueNode = nodes.find(n => n.operatorOrValue === 'true');
            const falseNode = nodes.find(n => n.operatorOrValue === 'false');
            assert.ok(trueNode, 'should find true');
            assert.ok(falseNode, 'should find false');
            assert.strictEqual(trueNode.kind, 'BooleanLiteral');
            assert.strictEqual(falseNode.kind, 'BooleanLiteral');
        });

        test('finds logical operators (&&, ||)', () => {
            const nodes = parseMutableNodes(LOGICAL_EXPRESSIONS, 'test.ts');
            const andNode = nodes.find(n => n.operatorOrValue === '&&');
            const orNode = nodes.find(n => n.operatorOrValue === '||');
            assert.ok(andNode, 'should find &&');
            assert.ok(orNode, 'should find ||');
            assert.strictEqual(andNode.kind, 'LogicalExpression');
        });

        test('marks nodes inside log calls', () => {
            const nodes = parseMutableNodes(FUNCTION_WITH_LOG, 'test.ts');
            const logNodes = nodes.filter(n => n.isInLogBlock);
            assert.ok(logNodes.length > 0, 'should find nodes in log blocks');
            const nonLogGe = nodes.filter(
                n => n.operatorOrValue === '>=' && !n.isInLogBlock,
            );
            assert.ok(nonLogGe.length > 0, 'should have non-log >= too');
        });

        test('detects off-by-one patterns (+ 1, - 1)', () => {
            const nodes = parseMutableNodes(FUNCTION_WITH_LOG, 'test.ts');
            const plus1 = nodes.find(n => n.operatorOrValue === '+ 1');
            const minus1 = nodes.find(n => n.operatorOrValue === '- 1');
            assert.ok(plus1, 'should find + 1');
            assert.ok(minus1, 'should find - 1');
        });

        test('returns sorted by line then column', () => {
            const nodes = parseMutableNodes(SIMPLE_FUNCTION, 'test.ts');
            for (let i = 1; i < nodes.length; i++) {
                const prev = nodes[i - 1];
                const curr = nodes[i];
                const sorted = prev.line < curr.line ||
                    (prev.line === curr.line && prev.column <= curr.column);
                assert.ok(sorted, `node ${i} should be after node ${i - 1}`);
            }
        });

        test('identifies exported functions', () => {
            const nodes = parseMutableNodes(SIMPLE_FUNCTION, 'test.ts');
            assert.ok(nodes.every(n => n.isExported), 'all should be exported');
        });

        test('tracks type annotations correctly', () => {
            const nodes = parseMutableNodes(TYPE_ANNOTATIONS, 'test.ts');
            // The === true in the function body should NOT be in type
            const eqNode = nodes.find(n => n.operatorOrValue === '===');
            assert.ok(eqNode, 'should find === in function body');
            assert.strictEqual(eqNode.isInType, false);
        });
    });

    suite('validateSyntax', () => {
        test('valid TypeScript returns true', () => {
            assert.strictEqual(
                validateSyntax(SIMPLE_FUNCTION, 'test.ts'),
                true,
            );
        });

        test('invalid syntax returns false', () => {
            assert.strictEqual(
                validateSyntax('function { broken syntax !!!', 'test.ts'),
                false,
            );
        });

        test('empty file is valid', () => {
            assert.strictEqual(validateSyntax('', 'test.ts'), true);
        });
    });

    suite('computeHash', () => {
        test('same content → same hash', () => {
            const h1 = computeHash('hello world');
            const h2 = computeHash('hello world');
            assert.strictEqual(h1, h2);
        });

        test('different content → different hash', () => {
            const h1 = computeHash('hello');
            const h2 = computeHash('world');
            assert.notStrictEqual(h1, h2);
        });

        test('returns hex string', () => {
            const h = computeHash('test');
            assert.ok(/^[0-9a-f]+$/.test(h), 'should be hex');
            assert.strictEqual(h.length, 64, 'sha256 = 64 hex chars');
        });
    });
});
