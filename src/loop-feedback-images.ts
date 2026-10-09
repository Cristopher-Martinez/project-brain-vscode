/**
 * Loop Feedback Images — extracted from brain-hq-loop-handler.ts.
 * Saves base64 data-URI images to session subfolder with hash dedup,
 * then appends markdown refs to the feedback text.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getLoopFeedbackImagesDir } from "./loop-feedback-image-paths";

const MAX_FEEDBACK_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

export function appendFeedbackImages(
  feedback: string,
  images: string[],
  sessionId: string,
  log: (msg: string) => void,
): string {
  if (images.length === 0) return feedback;

  const imgDir = getLoopFeedbackImagesDir(sessionId);
  if (!imgDir) return feedback;

  try {
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }
  } catch {
    log(`[BrainHQ] Failed to create feedback-images dir`);
    return feedback;
  }

  const savedPaths: string[] = [];
  let totalBytes = 0;
  const limitedImages = images.slice(0, MAX_FEEDBACK_IMAGES);
  if (images.length > limitedImages.length) {
    log(
      `[BrainHQ] Skipping ${images.length - limitedImages.length} feedback image(s) beyond limit ${MAX_FEEDBACK_IMAGES}`,
    );
  }

  for (let i = 0; i < limitedImages.length; i++) {
    try {
      const dataUri = limitedImages[i];
      const match = /^data:image\/([\w+]+);base64,(.+)$/.exec(dataUri);
      if (!match) {
        log(`[BrainHQ] Invalid feedback image payload at index ${i}`);
        continue;
      }
      const ext = match[1].replace("+xml", "").replace("jpeg", "jpg");
      if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
        log(`[BrainHQ] Unsupported feedback image extension: ${ext}`);
        continue;
      }
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        log(
          `[BrainHQ] Skipping feedback image ${i}: ${buffer.byteLength} bytes exceeds limit ${MAX_IMAGE_BYTES}`,
        );
        continue;
      }
      if (totalBytes + buffer.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        log(
          `[BrainHQ] Skipping feedback image ${i}: total payload would exceed ${MAX_TOTAL_IMAGE_BYTES} bytes`,
        );
        continue;
      }
      totalBytes += buffer.byteLength;

      // Hash dedup — skip identical images
      const hash = crypto
        .createHash("md5")
        .update(buffer)
        .digest("hex")
        .substring(0, 12);
      const filename = `img-${hash}.${ext}`;
      const filePath = path.join(imgDir, filename);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buffer);
        log(
          `[BrainHQ] Saved feedback image: ${filename} (${buffer.length} bytes)`,
        );
      } else {
        log(`[BrainHQ] Dedup hit: ${filename} already exists`);
      }
      savedPaths.push(filePath);
    } catch (err) {
      log(`[BrainHQ] Failed to save feedback image ${i}: ${err}`);
    }
  }

  if (savedPaths.length === 0) return feedback;

  const imageSection = [
    "",
    `🚨 **PRIORIDAD DE IMÁGENES**`,
    `Este feedback incluye ${savedPaths.length} imagen(es) adjuntas. Analízalas antes que el texto.`,
    `Si texto e imagen se contradicen, reporta la discrepancia y prioriza lo visible en la imagen.`,
    "",
    `📷 **Imágenes adjuntas (${savedPaths.length}):**`,
    ...savedPaths.map((p, i) => `- Imagen ${i + 1}: \`${p}\``),
    "",
  ].join("\n");

  return feedback + imageSection;
}
