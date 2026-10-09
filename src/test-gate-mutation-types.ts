/**
 * T5 — Mutation Testing Types
 *
 * Type definitions for the mutation testing gate.
 * Includes AST node types, operators, equivalents, and result contracts.
 * Separated from engine to keep files under 400 lines.
 */

// ——— AST Node Types ————————————————————————————————————————

export type ASTNodeKind =
    | 'BinaryExpression'
    | 'LogicalExpression'
    | 'BooleanLiteral'
    | 'NumericLiteral'
    | 'PrefixUnary';

export interface ASTMutableNode {
    readonly kind: ASTNodeKind;
    readonly operatorOrValue: string;
    readonly pos: number;
    readonly end: number;
    readonly line: number;
    readonly column: number;
    readonly functionName: string;
    readonly isExported: boolean;
    readonly isInLogBlock: boolean;
    readonly isInString: boolean;
    readonly isInType: boolean;
}

// ——— Mutation Operators ————————————————————————————————————

export type MutationTier = 'Tier1' | 'Tier2';

export interface MutationOperator {
    readonly original: string;
    readonly mutated: string;
    readonly tier: MutationTier;
    readonly description: string;
}

/** Tier 1 — CRITICAL: boundary, logic, equality */
export const TIER1_OPERATORS: readonly MutationOperator[] = [
    { original: '>=', mutated: '>', tier: 'Tier1', description: 'boundary shift (>=→>)' },
    { original: '<=', mutated: '<', tier: 'Tier1', description: 'boundary shift (<=→<)' },
    { original: '===', mutated: '!==', tier: 'Tier1', description: 'strict equality inversion' },
    { original: '!==', mutated: '===', tier: 'Tier1', description: 'strict inequality inversion' },
    { original: '==', mutated: '!=', tier: 'Tier1', description: 'equality inversion' },
    { original: '!=', mutated: '==', tier: 'Tier1', description: 'inequality inversion' },
    { original: '&&', mutated: '||', tier: 'Tier1', description: 'logic gate swap (&&→||)' },
    { original: '||', mutated: '&&', tier: 'Tier1', description: 'logic gate swap (||→&&)' },
] as const;

/** Tier 2 — HIGH: off-by-one, boolean flip */
export const TIER2_OPERATORS: readonly MutationOperator[] = [
    { original: '+ 1', mutated: '- 1', tier: 'Tier2', description: 'off-by-one (+1→-1)' },
    { original: '- 1', mutated: '+ 1', tier: 'Tier2', description: 'off-by-one (-1→+1)' },
    { original: 'true', mutated: 'false', tier: 'Tier2', description: 'boolean flip (true→false)' },
    { original: 'false', mutated: 'true', tier: 'Tier2', description: 'boolean flip (false→true)' },
] as const;

// ——— Equivalent Patterns (false positive whitelist, 21 patterns) ———————

export const EQUIVALENT_PATTERNS: readonly RegExp[] = [
    // Arithmetic identity
    /\+\s*0(?!\d)/,                      // x + 0
    /-\s*0(?!\d)/,                       // x - 0
    /\*\s*1(?!\d)/,                      // x * 1
    /\/\s*1(?!\d)/,                      // x / 1
    /\|\s*0(?!\d)/,                      // x | 0 (bitwise identity)

    // Boolean identity / coercion
    /if\s*\(\s*true\s*\)/,               // if (true) — dead branch
    /if\s*\(\s*false\s*\)/,              // if (false) — dead branch
    /!\s*!\s*\w+/,                       // !!x double negation coercion
    /Boolean\s*\(\s*\w+\s*\)/,           // Boolean(x) explicit coercion
    /===\s*true\b/,                      // x === true → !!x
    /!==\s*false\b/,                     // x !== false → !!x

    // Boundary equivalences
    />=\s*0(?!\d)/,                      // >= 0 same as > -1
    />\s*-\s*1(?!\d)/,                   // > -1 same as >= 0
    /\.length\s*>\s*0/,                  // .length > 0 same as >= 1
    /\.length\s*>=\s*1/,                 // .length >= 1 same as > 0

    // Identity calls
    /\.toString\(\)\s*$/,                // .toString() on string
    /String\s*\(\s*\w+\s*\)/,            // String(x) on string

    // Return identity
    /return\s+undefined\b/,              // return undefined same as return
    /void\s+0/,                          // void 0 same as undefined

    // Logical identity
    /\|\|\s*false\b/,                    // x || false → x
    /&&\s*true\b/,                       // x && true → x
];

// ——— Complexity Penalty ————————————————————————————————————

export interface ComplexityPenalty {
    readonly range: string;
    readonly minComplexity: number;
    readonly maxComplexity: number;
    readonly penalty: number;
}

export const COMPLEXITY_PENALTIES: readonly ComplexityPenalty[] = [
    { range: '1-10', minComplexity: 1, maxComplexity: 10, penalty: 0 },
    { range: '11-15', minComplexity: 11, maxComplexity: 15, penalty: 0.03 },
    { range: '16-20', minComplexity: 16, maxComplexity: 20, penalty: 0.08 },
    { range: '21+', minComplexity: 21, maxComplexity: Infinity, penalty: 0.15 },
] as const;

// ——— Mutant Types ——————————————————————————————————————————

export type MutantStatus = 'killed' | 'survived' | 'timeout' | 'equivalent' | 'invalid';

export interface Mutant {
    readonly id: string;
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly pos: number;
    readonly end: number;
    readonly originalText: string;
    readonly mutatedText: string;
    readonly lineContent: string;
    readonly operator: MutationOperator;
    readonly functionName: string;
    readonly isExported: boolean;
    readonly hasInvariant: boolean;
    readonly astNodeKind: ASTNodeKind;
}

export interface MutantResult {
    readonly mutant: Mutant;
    readonly status: MutantStatus;
    readonly killedBy?: string;
    readonly executionTimeMs: number;
}

// ——— Module Score ——————————————————————————————————————————

export interface ModuleScore {
    readonly file: string;
    readonly rawScore: number;
    readonly complexity: number;
    readonly penalty: number;
    readonly adjustedScore: number;
    readonly killed: number;
    readonly survived: number;
    readonly timeout: number;
    readonly equivalentExcluded: number;
    readonly invalid: number;
    readonly totalMutants: number;
}

// ——— T5 Result —————————————————————————————————————————————

export interface T5Result {
    readonly name: 'mutation-testing';
    readonly passed: boolean;
    readonly blocking: boolean;
    readonly skipped: boolean;
    readonly skipReason?: string;

    // Scores
    readonly globalScore: number | null;
    readonly rawGlobalScore: number | null;
    readonly moduleScores: ModuleScore[];

    // Mutant breakdown
    readonly totalMutants: number;
    readonly killed: number;
    readonly survived: number;
    readonly timeout: number;
    readonly equivalentExcluded: number;
    readonly invalid: number;

    // Hard cap tracking
    readonly capped: boolean;
    readonly mutantsSkippedDueToCap: number;

    // Impact
    readonly criticalSurvivors: MutantResult[];
    readonly highSurvivors: MutantResult[];

    // Meta
    readonly complexityAdjusted: boolean;
    readonly executionTimeMs: number;
    readonly filesAnalyzed: number;
    readonly ready_for_T6: boolean;
    readonly mode: 'enforce' | 'report';
    readonly mutantReports: MutantResult[];
    readonly hashVerified: boolean;
}

// ——— Config ————————————————————————————————————————————————

export interface T5Config {
    readonly globalMinScore: number;
    readonly coreModuleMinScore: number;
    readonly maxMutantsPerFile: number;
    readonly maxTotalMutantsPerRun: number;
    readonly mutationTimeoutMs: number;
    readonly equivalentTolerance: number;
    readonly complexityPenaltyEnabled: boolean;
    readonly tiers: readonly MutationTier[];
    readonly mode: 'enforce' | 'report';
}

export const DEFAULT_T5_CONFIG: T5Config = {
    globalMinScore: 65,
    coreModuleMinScore: 55,
    maxMutantsPerFile: 30,
    maxTotalMutantsPerRun: 150,
    mutationTimeoutMs: 30000,
    equivalentTolerance: 5,
    complexityPenaltyEnabled: true,
    tiers: ['Tier1', 'Tier2'],
    mode: 'report',
};

// ——— External Dependencies (injected) ——————————————————————

export interface T5Deps {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    runTests(targetFile: string): Promise<TestRunResult>;
    getComplexity(file: string): Promise<number>;
    getCoreModules(): string[];
    getModifiedFiles(): string[];
    getInvariantFiles(): string[];
    log(msg: string): void;

    // AST-based analysis (replaces text-based mutation)
    parseMutableNodes(content: string, filePath: string): ASTMutableNode[];
    validateSyntax(content: string, filePath: string): boolean;
    computeHash(content: string): string;
}

export interface TestRunResult {
    readonly passed: boolean;
    readonly failed: boolean;
    readonly testName?: string;
    readonly error?: string;
    readonly durationMs: number;
}
