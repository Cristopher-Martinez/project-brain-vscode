import * as vscode from "vscode";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { log, logError } from "./logger";
import type { ModelRouter } from "./model-router";
import { attachAutopilotArtifacts } from "./test-advice-autopilot";
import { readFreshAdvice, writeAdviceEntries } from "./test-advice-cache";
import { computeDiffFingerprint, readDiffSnippet } from "./test-advice-diff";
import {
  deriveSuggestedTestPath,
  findExistingRelatedTestPath,
  listRelatedTestDirectories,
} from "./test-advice-locator";
import type { TestAdviceEntry } from "./test-advice-types";

let modelRouterRef: ModelRouter | undefined;
let defaultModel: vscode.LanguageModelChat | undefined;
let pendingAdvice: Promise<void> | undefined;

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MAX_FILES_PER_BATCH = 4;
const MAX_SNIPPET_CHARS = 3200;
const MAX_TEST_SNIPPET_CHARS = 1600;

export function initTestAdvice(modelRouter: ModelRouter): void {
  modelRouterRef = modelRouter;
  log("[TestAdvice] Initialized with ModelRouter");
}

export async function triggerTestAdviceAsync(
  files: string[],
  wsRoot: string,
): Promise<void> {
  if (!modelRouterRef) {
    log("[TestAdvice] No ModelRouter — skipping advice generation");
    return;
  }

  if (pendingAdvice) {
    log("[TestAdvice] Advice generation already in progress — skipping");
    return;
  }

  const candidates = uniqueCodeFiles(files);
  if (candidates.length === 0) {
    return;
  }

  const fresh = readFreshAdvice(wsRoot, candidates);
  const pendingFiles = candidates.filter((file) => !fresh.has(basename(file)));
  if (pendingFiles.length === 0) {
    log("[TestAdvice] Fresh advice already available — skipping");
    return;
  }

  if (!defaultModel) {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    defaultModel = models[0];
  }
  if (!defaultModel) {
    log("[TestAdvice] No fallback model available — skipping");
    return;
  }

  pendingAdvice = generateAdviceBatches(
    pendingFiles,
    wsRoot,
    modelRouterRef,
    defaultModel,
  )
    .then((entries) => {
      if (entries.length > 0) {
        writeAdviceEntries(wsRoot, attachAutopilotArtifacts(wsRoot, entries));
      }
    })
    .catch((err) => {
      logError(`[TestAdvice] Advice generation failed: ${err}`);
    })
    .finally(() => {
      pendingAdvice = undefined;
    });

  await pendingAdvice;
}

async function generateAdviceBatches(
  files: string[],
  wsRoot: string,
  modelRouter: ModelRouter,
  fallbackModel: vscode.LanguageModelChat,
): Promise<TestAdviceEntry[]> {
  const entries: TestAdviceEntry[] = [];
  for (let index = 0; index < files.length; index += MAX_FILES_PER_BATCH) {
    const batch = files.slice(index, index + MAX_FILES_PER_BATCH);
    const batchEntries = await generateAdviceBatch(
      batch,
      wsRoot,
      modelRouter,
      fallbackModel,
    );
    entries.push(...batchEntries);
  }
  return entries;
}

async function generateAdviceBatch(
  files: string[],
  wsRoot: string,
  modelRouter: ModelRouter,
  fallbackModel: vscode.LanguageModelChat,
): Promise<TestAdviceEntry[]> {
  const tokenSource = new vscode.CancellationTokenSource();
  const prompt = buildAdvicePrompt(files, wsRoot);
  const result = await modelRouter.delegateTask(prompt, tokenSource.token, fallbackModel, {
    taskKind: "classify",
    maxTier: "standard",
    skipValidation: true,
    outputConstraints: {
      format: "json",
      maxLength: 12000,
    },
    systemPrompt:
      "You are a senior test architect. Decide whether EACH edited file truly needs tests now, " +
      "then propose acceptance criteria and a high-signal draft test only when needed. " +
      "Prefer needsTests=false for trivial, non-behavioral, declaration-only, barrel, constants, " +
      "comments, formatting, or logging-only changes. Respond ONLY with valid JSON.",
  });

  return normalizeAdviceEntries(
    files,
    parseAdviceResponse(result.text),
    result.decision.selectedModel.id,
    wsRoot,
  );
}

function buildAdvicePrompt(files: string[], wsRoot: string): string {
  const sections = files.map((file, index) => {
    const fileBase = basename(file);
    const source = readSnippet(file, MAX_SNIPPET_CHARS);
    const relatedTest = findRelatedTestSnippet(file, wsRoot);
    const fallbackTestPath = deriveSuggestedTestPath(file, wsRoot);
    return [
      `### File ${index + 1}: ${fileBase}`,
      `Relative path: ${relative(wsRoot, file)}`,
      `Fallback suggested test path: ${fallbackTestPath}`,
      "Source snippet:",
      source,
      "Diff snippet:",
      readDiffSnippet(file, wsRoot),
      relatedTest ? "Existing related test snippet:" : "No related test snippet found.",
      relatedTest || "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "Analyze the edited files below.",
    "For each file, determine whether the CURRENT change likely needs tests right now.",
    "If tests are needed, provide behavioral acceptance criteria and a real starter draft test.",
    "Avoid dummy assertions and implementation-detail tests.",
    "Return JSON with this exact shape:",
    '{"entries":[{"file":"scanner.ts","needsTests":true,"confidence":0.9,"reason":"...","suggestedTestPath":"src/__tests__/scanner.test.ts","acceptanceCriteria":["..."],"draftTest":"raw test code"}]}',
    "Rules:",
    "- needsTests=false for pure declarations, constants-only files, barrel exports, trivial string changes, comments, docs, formatting, or clearly non-behavioral edits.",
    "- If needsTests=true, acceptanceCriteria must target regression coverage and observable behavior.",
    "- draftTest must be concise but meaningful and follow any visible existing test style when possible.",
    "- confidence must be a number between 0 and 1.",
    "",
    ...sections,
  ].join("\n");
}

function parseAdviceResponse(text: string): unknown[] {
  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    log(`[TestAdvice] Failed to parse LLM response: ${err}`);
    return [];
  }
}

function normalizeAdviceEntries(
  files: string[],
  rawEntries: unknown[],
  modelId?: string,
  wsRoot?: string,
): TestAdviceEntry[] {
  const byBase = new Map<string, TestAdviceEntry>();
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const candidate = raw as {
      file?: unknown;
      needsTests?: unknown;
      confidence?: unknown;
      reason?: unknown;
      suggestedTestPath?: unknown;
      acceptanceCriteria?: unknown;
      draftTest?: unknown;
    };
    const file = resolvePath(candidate.file, files);
    if (!file) {
      continue;
    }
    byBase.set(basename(file), {
      file,
      relativePath: normalizeRelativePath(file),
      diffFingerprint: wsRoot ? computeDiffFingerprint(file, wsRoot) : undefined,
      needsTests: candidate.needsTests !== false,
      confidence: normalizeConfidence(candidate.confidence),
      reason:
        typeof candidate.reason === "string" && candidate.reason.trim().length > 0
          ? candidate.reason.trim()
          : "AI classified this file as behaviorally relevant.",
      suggestedTestPath:
        typeof candidate.suggestedTestPath === "string"
          ? candidate.suggestedTestPath.trim()
          : deriveSuggestedTestPath(file, wsRoot ?? dirname(file)),
      acceptanceCriteria: normalizeCriteria(candidate.acceptanceCriteria),
      draftTest:
        typeof candidate.draftTest === "string" && candidate.draftTest.trim().length > 0
          ? candidate.draftTest.trim()
          : undefined,
      timestamp: Date.now(),
      modelId,
    });
  }

  return files.map((file) => {
    const existing = byBase.get(basename(file));
    if (existing) {
      return existing;
    }
    return {
      file,
      relativePath: normalizeRelativePath(file),
      diffFingerprint: wsRoot ? computeDiffFingerprint(file, wsRoot) : undefined,
      needsTests: true,
      confidence: 0.45,
      reason:
        "No advice model output was available, so the file remains conservatively marked as needing verification.",
      suggestedTestPath: deriveSuggestedTestPath(file, wsRoot ?? dirname(file)),
      acceptanceCriteria: [],
      timestamp: Date.now(),
      modelId,
    };
  });
}

function normalizeRelativePath(file: string): string {
  return file.replace(/\\/g, "/");
}

function resolvePath(candidate: unknown, files: string[]): string | undefined {
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return files.find((file) => basename(file) === trimmed || file.endsWith(trimmed));
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.75;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function uniqueCodeFiles(files: string[]): string[] {
  return [...new Set(files)]
    .filter((file) => CODE_EXTENSIONS.test(basename(file)))
    .filter((file) => !/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(basename(file)));
}

function readSnippet(file: string, limit: number): string {
  try {
    if (!existsSync(file)) {
      return "(file not found)";
    }
    return readFileSync(file, "utf8").slice(0, limit);
  } catch {
    return "(unable to read file)";
  }
}

function findRelatedTestSnippet(file: string, wsRoot: string): string | undefined {
  const relatedPath = findExistingRelatedTestPath(file, wsRoot);
  if (relatedPath && existsSync(relatedPath)) {
    return readSnippet(relatedPath, MAX_TEST_SNIPPET_CHARS);
  }

  const commonTestDirs = [
    ...listRelatedTestDirectories(file, wsRoot),
  ];
  for (const dir of commonTestDirs) {
    if (!existsSync(dir)) {
      continue;
    }
    try {
      const firstTest = readdirSync(dir).find((entry) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry));
      if (firstTest) {
        return readSnippet(join(dir, firstTest), MAX_TEST_SNIPPET_CHARS);
      }
    } catch {
      // Ignore filesystem issues and keep looking.
    }
  }
  return undefined;
}