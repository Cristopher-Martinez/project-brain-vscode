// ============================================================
// test-classifier.ts — AI-powered test file classification
// Uses ModelRouter delegation to determine which edited files
// require test coverage, replacing fragile regex patterns.
// ============================================================

import * as vscode from "vscode";
import { basename } from "path";
import { log, logError } from "./logger";
import type { ModelRouter } from "./model-router";
import {
  readCache,
  writeCache,
  buildResult,
  matchFilesToPaths,
  matchSingleFilePath,
} from "./test-classifier-cache";

// ——— Module-level state (set once at registration) ————————————

let _modelRouter: ModelRouter | undefined;
let _defaultModel: vscode.LanguageModelChat | undefined;
let _pendingClassification: Promise<TestClassification> | undefined;

/**
 * Initialize the test classifier with required dependencies.
 * Call once during tool registration.
 */
export function initTestClassifier(
  modelRouter: ModelRouter,
): void {
  _modelRouter = modelRouter;
  log("[TestClassifier] Initialized with ModelRouter");
}

/**
 * Trigger async classification for edited files.
 * Fire-and-forget — writes result to cache for hooks to read later.
 * Uses debouncing: if called again while running, the new call is a no-op.
 */
export async function triggerClassificationAsync(
  files: string[],
  wsRoot: string,
): Promise<void> {
  if (!_modelRouter) {
    log("[TestClassifier] No ModelRouter — skipping AI classification");
    return;
  }

  if (_pendingClassification) {
    log("[TestClassifier] Classification already in progress — skipping");
    return;
  }

  // Pre-filter: if no code files, skip entirely
  const { codeFiles } = preFilterFiles(files);
  if (codeFiles.length === 0) return;

  // Check cache first
  const cached = readCache(wsRoot, codeFiles);
  if (cached) {
    log("[TestClassifier] Cache still valid — skipping AI call");
    return;
  }

  try {
    // Get a default model lazily
    if (!_defaultModel) {
      const models = await vscode.lm.selectChatModels({
        vendor: "copilot",
      });
      _defaultModel = models[0];
    }

    if (!_defaultModel) {
      log("[TestClassifier] No LLM model available — skipping");
      return;
    }

    const token = new vscode.CancellationTokenSource().token;

    _pendingClassification = classifyTestability(
      files,
      _modelRouter,
      _defaultModel,
      token,
      wsRoot,
    );

    await _pendingClassification;
    log("[TestClassifier] Async classification complete — cached for hooks");
  } catch (err) {
    logError(`[TestClassifier] Async classification failed: ${err}`);
  } finally {
    _pendingClassification = undefined;
  }
}

// ——— Types ———————————————————————————————————————————————————

export interface TestClassification {
  /** Files that require test coverage */
  testable: string[];
  /** Files that do NOT require test coverage, with reason */
  excluded: Array<{ file: string; reason: string }>;
  /** Timestamp of classification */
  timestamp: number;
  /** Model used for classification */
  modelId?: string;
  /** Response time in ms */
  responseTimeMs?: number;
}

const MAX_FILES_PER_BATCH = 40; // LLM context limit safety

/** Fast regex pre-filter — skip obviously non-testable files */
const OBVIOUSLY_NON_TESTABLE = /\.(env|ya?ml|toml|cfg|ini|svg|png|jpg|jpeg|gif|ico|webp|css|scss|less|html|xml|txt|lock|log|sh|bat|ps1|md|json|d\.ts)$|^(Dockerfile|docker-compose|\.gitignore|\.eslint|\.prettier|LICENSE|Makefile)/;

/** Fast regex for code files that MIGHT need tests */
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// ——— Core Classification ————————————————————————————————————

/**
 * Classify files for testability using LLM delegation.
 * Falls back to regex heuristics if LLM is unavailable.
 */
export async function classifyTestability(
  files: string[],
  modelRouter: ModelRouter,
  fallbackModel: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  wsRoot?: string,
): Promise<TestClassification> {
  // Fast pre-filter: skip obviously non-testable files
  const { codeFiles, excludedFiles } = preFilterFiles(files);

  if (codeFiles.length === 0) {
    return buildResult([], excludedFiles);
  }

  // Check cache first
  if (wsRoot) {
    const cached = readCache(wsRoot, codeFiles);
    if (cached) {
      log("[TestClassifier] Cache hit — returning cached classification");
      return cached;
    }
  }

  // Attempt LLM classification
  try {
    const result = await classifyViaLLM(
      codeFiles,
      excludedFiles,
      modelRouter,
      fallbackModel,
      token,
    );

    // Write to cache
    if (wsRoot) {
      writeCache(wsRoot, codeFiles, result);
    }

    return result;
  } catch (err) {
    logError(`[TestClassifier] LLM classification failed, using regex fallback: ${err}`);
    return buildResult(codeFiles, excludedFiles);
  }
}

// ——— Pre-filter (instant, no LLM) ———————————————————————————

function preFilterFiles(files: string[]): {
  codeFiles: string[];
  excludedFiles: Array<{ file: string; reason: string }>;
} {
  const codeFiles: string[] = [];
  const excludedFiles: Array<{ file: string; reason: string }> = [];

  for (const file of files) {
    const base = basename(file);

    if (OBVIOUSLY_NON_TESTABLE.test(base)) {
      excludedFiles.push({ file, reason: "non-code file" });
      continue;
    }

    if (!CODE_EXTENSIONS.test(base)) {
      excludedFiles.push({ file, reason: "unknown extension" });
      continue;
    }

    // Skip test files themselves
    if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(base)) {
      excludedFiles.push({ file, reason: "test file" });
      continue;
    }

    // Skip type definition files
    if (/\.d\.ts$/.test(base)) {
      excludedFiles.push({ file, reason: "type declaration" });
      continue;
    }

    codeFiles.push(file);
  }

  return { codeFiles, excludedFiles };
}

// ——— LLM Classification ————————————————————————————————————

async function classifyViaLLM(
  codeFiles: string[],
  preExcluded: Array<{ file: string; reason: string }>,
  modelRouter: ModelRouter,
  fallbackModel: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<TestClassification> {
  const batch = codeFiles.slice(0, MAX_FILES_PER_BATCH);

  const prompt = buildClassificationPrompt(batch);

  const result = await modelRouter.delegateTask(prompt, token, fallbackModel, {
    taskKind: "classify",
    maxTier: "cheap",
    skipValidation: true,
    outputConstraints: {
      format: "json",
      maxLength: 2000,
    },
    systemPrompt:
      "You are a test coverage classifier. Given a list of source code files, " +
      "determine which ones need unit/integration test coverage. " +
      "Respond ONLY with valid JSON, no markdown fences.",
  });

  const parsed = parseClassificationResponse(result.text, batch);

  // Merge pre-excluded + LLM excluded
  const allExcluded = [
    ...preExcluded,
    ...parsed.excluded,
  ];

  return {
    testable: parsed.testable,
    excluded: allExcluded,
    timestamp: Date.now(),
    modelId: result.decision.selectedModel.id,
    responseTimeMs: result.responseTimeMs,
  };
}

function buildClassificationPrompt(files: string[]): string {
  const fileList = files.map((f, i) => `${i + 1}. ${basename(f)}`).join("\n");

  return (
    `Classify these source code files by testability.\n\n` +
    `Files:\n${fileList}\n\n` +
    `Rules:\n` +
    `- "testable": files with logic that benefits from unit/integration tests\n` +
    `- "excluded": files that typically don't need tests (configs, constants, ` +
    `type-only files, barrel exports, simple re-exports, CLI entry points, ` +
    `pure declarations without logic)\n\n` +
    `Respond with JSON:\n` +
    `{"testable": ["file1.ts"], "excluded": [{"file": "file2.ts", "reason": "constants only"}]}`
  );
}

function parseClassificationResponse(
  text: string,
  originalFiles: string[],
): { testable: string[]; excluded: Array<{ file: string; reason: string }> } {
  try {
    // Strip markdown fences if present
    const cleaned = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed.testable)) {
      throw new Error("Missing 'testable' array");
    }

    // Map back to full paths
    const testable = matchFilesToPaths(parsed.testable || [], originalFiles);
    const excluded = (parsed.excluded || []).map(
      (e: { file: string; reason: string }) => ({
        file: matchSingleFilePath(e.file, originalFiles) || e.file,
        reason: e.reason || "AI classified",
      }),
    );

    return { testable, excluded };
  } catch (err) {
    log(`[TestClassifier] Failed to parse LLM response, treating all as testable: ${err}`);
    // Fallback: all code files are testable
    return {
      testable: originalFiles,
      excluded: [],
    };
  }
}



// ——— Hook-readable helper ——————————————————————————————————

/**
 * Read the cached test classification from disk.
 * Designed to be called from hook scripts (plain JSON read).
 * @param wsRoot - Workspace root path
 * @param files - Array of edited file paths to check
 * @returns Cached classification or null if not available
 */
export function readTestClassificationSync(
  wsRoot: string,
  files: string[],
): TestClassification | null {
  return readCache(wsRoot, files);
}
