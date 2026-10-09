import * as path from "path";
import * as vscode from "vscode";
import { getLoopDir } from "./brain-paths";

const FEEDBACK_IMAGES_SUBDIR = "feedback-images";

function getRepoRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function getLoopFeedbackImagesDir(
  sessionId: string,
  repoRoot?: string,
): string | null {
  const root = repoRoot ?? getRepoRoot();
  if (!root) {
    return null;
  }

  return path.join(getLoopDir(root, sessionId), FEEDBACK_IMAGES_SUBDIR);
}