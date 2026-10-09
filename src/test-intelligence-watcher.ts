import * as vscode from "vscode";
import { basename } from "path";
import { triggerClassificationAsync } from "./test-classifier";
import { triggerTestAdviceAsync } from "./test-advice";

export interface TestIntelligenceWatcherDeps {
  getModelRouter: () => unknown;
  log: (msg: string) => void;
}

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDED_SEGMENTS = [
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".project-brain",
  ".brain-loops",
  ".brain-forks",
  ".sandbox",
];

const pendingByRoot = new Map<string, Set<string>>();
const timersByRoot = new Map<string, ReturnType<typeof setTimeout>>();

export function setupTestIntelligenceWatcher(
  context: vscode.ExtensionContext,
  deps: TestIntelligenceWatcherDeps,
): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs}");
  const onUri = (uri: vscode.Uri) => queueUri(uri, deps);
  watcher.onDidChange(onUri, null, context.subscriptions);
  watcher.onDidCreate(onUri, null, context.subscriptions);
  context.subscriptions.push(watcher);
}

function queueUri(uri: vscode.Uri, deps: TestIntelligenceWatcherDeps): void {
  if (!deps.getModelRouter()) {
    return;
  }
  const filePath = uri.fsPath;
  if (!isEligible(filePath)) {
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return;
  }
  const root = folder.uri.fsPath;
  const pending = pendingByRoot.get(root) ?? new Set<string>();
  pending.add(filePath);
  pendingByRoot.set(root, pending);

  const existingTimer = timersByRoot.get(root);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  timersByRoot.set(
    root,
    setTimeout(() => {
      void flushRoot(root, deps);
    }, 1500),
  );
}

async function flushRoot(
  root: string,
  deps: TestIntelligenceWatcherDeps,
): Promise<void> {
  timersByRoot.delete(root);
  const pending = pendingByRoot.get(root);
  pendingByRoot.delete(root);
  if (!pending || pending.size === 0) {
    return;
  }
  if (!deps.getModelRouter()) {
    return;
  }

  const files = [...pending];
  deps.log(
    `[TestIntel] Warming test intelligence for ${files.length} file(s): ${files
      .map((file) => basename(file))
      .slice(0, 5)
      .join(", ")}`,
  );

  await Promise.allSettled([
    triggerClassificationAsync(files, root),
    triggerTestAdviceAsync(files, root),
  ]);
}

function isEligible(filePath: string): boolean {
  if (!CODE_EXTENSIONS.test(basename(filePath))) {
    return false;
  }
  return !EXCLUDED_SEGMENTS.some((segment) => filePath.includes(`\\${segment}\\`) || filePath.includes(`/${segment}/`));
}