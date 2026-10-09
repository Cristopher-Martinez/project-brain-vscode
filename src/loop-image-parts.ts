/**
 * Loop feedback image → LanguageModelDataPart converter.
 * Extracts image file paths from feedback text and creates native
 * vision-compatible LanguageModelDataPart.image() objects.
 *
 * @module loop-image-parts
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./logger";
import { getLoopFeedbackImagesDir } from "./loop-feedback-image-paths";

/** Regex to extract image paths from augmented feedback text.
 * Matches format: `- Imagen N: \`<path>\`` produced by appendFeedbackImages */
const IMAGE_PATH_RE = /Imagen \d+: `(.+?\.(?:jpg|jpeg|png|gif|webp))`/gi;

/** MIME map for supported image extensions. */
const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function extractImagePaths(feedbackText: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  IMAGE_PATH_RE.lastIndex = 0;
  while ((match = IMAGE_PATH_RE.exec(feedbackText)) !== null) {
    const filePath = match[1].trim();
    if (!paths.includes(filePath)) {
      paths.push(filePath);
    }
  }

  return paths;
}

export function buildImagePriorityContext(feedbackText: string): string {
  const imagePaths = extractImagePaths(feedbackText);
  if (imagePaths.length === 0) {
    return "";
  }

  return [
    "🚨 **PRIORIDAD ALTA — FEEDBACK CON IMÁGENES**",
    `Hay ${imagePaths.length} imagen(es) adjuntas en este feedback.`,
    "Debes analizarlas explícitamente antes de responder.",
    "No ignores las imágenes aunque el texto del usuario sea corto o ambiguo.",
    "Si texto e imagen se contradicen, explica la discrepancia y prioriza la evidencia visual.",
    "---",
  ].join("\n");
}

/**
 * Extracts image file paths from augmented feedback text and converts
 * them to LanguageModelDataPart.image() objects for Vision API support.
 *
 * Falls back gracefully: if files don't exist or reading fails,
 * they're simply skipped. The text feedback still contains paths.
 *
 * @returns Array of LanguageModelDataPart (may be empty)
 */
export function extractImageParts(
  feedbackText: string,
): vscode.LanguageModelDataPart[] {
  // Guard: if LanguageModelDataPart.image is not available in runtime
  if (
    !vscode.LanguageModelDataPart ||
    typeof vscode.LanguageModelDataPart.image !== "function"
  ) {
    log(
      "[LoopImageParts] LanguageModelDataPart.image not available — skipping vision pass-through",
    );
    return [];
  }

  const parts: vscode.LanguageModelDataPart[] = [];
  for (const filePath of extractImagePaths(feedbackText)) {
    try {
      if (!fs.existsSync(filePath)) {
        log(`[LoopImageParts] File not found, skipping: ${filePath}`);
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_MAP[ext];
      if (!mime) {
        log(`[LoopImageParts] Unsupported extension ${ext}, skipping`);
        continue;
      }

      const buffer = fs.readFileSync(filePath);
      const data = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      parts.push(vscode.LanguageModelDataPart.image(data, mime));
      log(`[LoopImageParts] Added image part: ${path.basename(filePath)} (${mime}, ${data.byteLength} bytes)`);
    } catch (err) {
      log(`[LoopImageParts] Failed to read image ${filePath}: ${err}`);
    }
  }

  return parts;
}

/**
 * Cleanup feedback images for a session.
 * Called when a loop ends, resets, or times out.
 */
export function cleanupFeedbackImages(
  sessionId: string,
  logFn?: (msg: string) => void,
): void {
  const imgDir = getLoopFeedbackImagesDir(sessionId);
  if (!imgDir) return;
  try {
    if (fs.existsSync(imgDir)) {
      fs.rmSync(imgDir, { recursive: true, force: true });
      (logFn ?? log)(
        `[LoopImageParts] Cleaned up feedback images for session ${sessionId}`,
      );
    }
  } catch (err) {
    (logFn ?? log)(`[LoopImageParts] Failed to cleanup: ${err}`);
  }
}
