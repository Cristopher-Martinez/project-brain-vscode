/**
 * T5 — AST-based Mutation Analysis
 *
 * Provides real implementations of AST parsing for T5 mutation testing.
 * Uses TypeScript compiler API (devDependency) for precise node identification.
 *
 * This file is only imported during CI/testing — never in production extension.
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';
import type { ASTMutableNode, ASTNodeKind } from './test-gate-mutation-types';

// ——— Operator-to-kind mapping ——————————————————————————————

function tsOperatorToString(token: ts.SyntaxKind): string | undefined {
    const map: Partial<Record<ts.SyntaxKind, string>> = {
        [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
        [ts.SyntaxKind.LessThanEqualsToken]: '<=',
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: '===',
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!==',
        [ts.SyntaxKind.EqualsEqualsToken]: '==',
        [ts.SyntaxKind.ExclamationEqualsToken]: '!=',
        [ts.SyntaxKind.AmpersandAmpersandToken]: '&&',
        [ts.SyntaxKind.BarBarToken]: '||',
    };
    return map[token];
}

function getNodeKind(token: ts.SyntaxKind): ASTNodeKind {
    if (token === ts.SyntaxKind.AmpersandAmpersandToken ||
        token === ts.SyntaxKind.BarBarToken) {
        return 'LogicalExpression';
    }
    return 'BinaryExpression';
}

// ——— Context tracking ——————————————————————————————————————

function isInsideLogCall(node: ts.Node, sf: ts.SourceFile): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isCallExpression(current)) {
            const text = current.expression.getText(sf);
            if (/\b(log|logError|logWarn|console\.log|console\.error|console\.warn)\b/.test(text)) {
                return true;
            }
        }
        current = current.parent;
    }
    return false;
}

function isInsideTypeAnnotation(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isTypeNode(current) ||
            ts.isInterfaceDeclaration(current) ||
            ts.isTypeAliasDeclaration(current)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function isInsideString(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isStringLiteral(current) ||
            ts.isTemplateExpression(current) ||
            ts.isNoSubstitutionTemplateLiteral(current)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function getEnclosingFunction(
    node: ts.Node,
): { name: string; isExported: boolean } {
    let current = node.parent;
    while (current) {
        if (ts.isFunctionDeclaration(current) && current.name) {
            const isExported = current.modifiers?.some(
                m => m.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false;
            return { name: current.name.text, isExported };
        }
        if (ts.isVariableStatement(current)) {
            const isExported = current.modifiers?.some(
                m => m.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false;
            const decl = current.declarationList.declarations[0];
            if (decl && ts.isIdentifier(decl.name)) {
                return { name: decl.name.text, isExported };
            }
        }
        if (ts.isMethodDeclaration(current) && current.name) {
            return { name: current.name.getText(), isExported: true };
        }
        current = current.parent;
    }
    return { name: '<module>', isExported: false };
}

// ——— Core AST parser ———————————————————————————————————————

export function parseMutableNodes(
    content: string,
    filePath: string,
): ASTMutableNode[] {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const nodes: ASTMutableNode[] = [];

    function visit(node: ts.Node): void {
        // Binary expressions: >=, <=, ===, !==, ==, !=
        if (ts.isBinaryExpression(node)) {
            const opStr = tsOperatorToString(node.operatorToken.kind);
            if (opStr) {
                const { line, character } = sf.getLineAndCharacterOfPosition(
                    node.operatorToken.getStart(sf),
                );
                const fn = getEnclosingFunction(node);
                nodes.push({
                    kind: getNodeKind(node.operatorToken.kind),
                    operatorOrValue: opStr,
                    pos: node.operatorToken.getStart(sf),
                    end: node.operatorToken.getEnd(),
                    line: line + 1,
                    column: character + 1,
                    functionName: fn.name,
                    isExported: fn.isExported,
                    isInLogBlock: isInsideLogCall(node, sf),
                    isInString: isInsideString(node),
                    isInType: isInsideTypeAnnotation(node),
                });
            }

            // Off-by-one: + 1, - 1
            if ((node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
                 node.operatorToken.kind === ts.SyntaxKind.MinusToken) &&
                ts.isNumericLiteral(node.right) && node.right.text === '1') {
                const opStart = node.operatorToken.getStart(sf);
                const rightEnd = node.right.getEnd();
                const actualText = content.substring(opStart, rightEnd);
                const normalized = actualText.replace(/\s+/g, ' ').trim();
                const { line, character } = sf.getLineAndCharacterOfPosition(opStart);
                const fn = getEnclosingFunction(node);
                nodes.push({
                    kind: 'BinaryExpression',
                    operatorOrValue: normalized,
                    pos: opStart,
                    end: rightEnd,
                    line: line + 1,
                    column: character + 1,
                    functionName: fn.name,
                    isExported: fn.isExported,
                    isInLogBlock: isInsideLogCall(node, sf),
                    isInString: isInsideString(node),
                    isInType: isInsideTypeAnnotation(node),
                });
            }
        }

        // Logical expressions (&&, ||) — already handled above via binary

        // Boolean literals: true, false
        if (node.kind === ts.SyntaxKind.TrueKeyword ||
            node.kind === ts.SyntaxKind.FalseKeyword) {
            const text = node.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false';
            const { line, character } = sf.getLineAndCharacterOfPosition(
                node.getStart(sf),
            );
            const fn = getEnclosingFunction(node);
            nodes.push({
                kind: 'BooleanLiteral',
                operatorOrValue: text,
                pos: node.getStart(sf),
                end: node.getEnd(),
                line: line + 1,
                column: character + 1,
                functionName: fn.name,
                isExported: fn.isExported,
                isInLogBlock: isInsideLogCall(node, sf),
                isInString: isInsideString(node),
                isInType: isInsideTypeAnnotation(node),
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(sf);

    // Sort deterministically: line ASC, column ASC
    nodes.sort((a, b) => a.line - b.line || a.column - b.column);
    return nodes;
}

// ——— Syntax validation ————————————————————————————————————

export function validateSyntax(content: string, filePath: string): boolean {
    try {
        const sf = ts.createSourceFile(
            filePath, content, ts.ScriptTarget.Latest, true,
        );
        // Access internal parse diagnostics — stable across TS versions
        const diagnostics = (sf as unknown as Record<string, unknown>)[
            'parseDiagnostics'
        ] as ts.Diagnostic[] | undefined;
        return !diagnostics || diagnostics.length === 0;
    } catch {
        return false;
    }
}

// ——— Hash computation ————————————————————————————————————

export function computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
