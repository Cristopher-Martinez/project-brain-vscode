/**
 * Cloud Backup — Vector index sync with Project Brain Worker (R2)
 *
 * Uploads/downloads/deletes vector indexes via the /api/vectors endpoint.
 * Activated only when CLOUDFLARE_API_KEY is set.
 */

import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { getIndexPath } from "./storage.js";
import type { ProjectIndex } from "./types.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY || "";
const CLOUDFLARE_URL =
  process.env.CLOUDFLARE_URL || "https://api.projectbrain.tech";
const UPLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCloudBackupEnabled(): boolean {
  return CLOUDFLARE_API_KEY.length > 0;
}

function vectorsUrl(projectId: string): string {
  return `${CLOUDFLARE_URL}/api/vectors/${projectId}`;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    "X-API-Key": CLOUDFLARE_API_KEY,
    ...extra,
  };
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export interface UploadResult {
  success: boolean;
  etag?: string;
  error?: string;
}

/**
 * Uploads a ProjectIndex to the cloud.
 * The index is serialized to JSON and sent as binary to R2.
 * Includes metadata headers for dimension, chunk count, embedding type.
 */
export async function uploadIndex(index: ProjectIndex): Promise<UploadResult> {
  if (!isCloudBackupEnabled()) {
    return { success: false, error: "Cloud backup not configured" };
  }

  try {
    const payload = JSON.stringify(index);
    const etag = createHash("md5").update(payload).digest("hex");

    const res = await fetch(vectorsUrl(index.projectId), {
      method: "PUT",
      headers: headers({
        "Content-Type": "application/octet-stream",
        "X-PB-Embedding-Type": index.embeddingType || "unknown",
        "X-PB-Embedding-Dim": String(index.embeddingDimension || 0),
        "X-PB-Chunk-Count": String(index.chunks.length),
        "X-PB-Version": "1",
      }),
      body: payload,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        error: `Upload failed: ${res.status} ${res.statusText} — ${body}`,
      };
    }

    const responseEtag = res.headers.get("etag") || etag;
    console.log(
      `Cloud backup uploaded: ${index.projectId} (${index.chunks.length} chunks, etag: ${responseEtag})`,
    );
    return { success: true, etag: responseEtag };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cloud backup upload error: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Download ────────────────────────────────────────────────────────────────

export interface DownloadResult {
  success: boolean;
  index?: ProjectIndex;
  etag?: string;
  error?: string;
}

/**
 * Downloads a ProjectIndex from the cloud.
 * Returns null if not found (404).
 */
export async function downloadIndex(
  projectId: string,
): Promise<DownloadResult> {
  if (!isCloudBackupEnabled()) {
    return { success: false, error: "Cloud backup not configured" };
  }

  try {
    const res = await fetch(vectorsUrl(projectId), {
      method: "GET",
      headers: headers(),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return { success: true, index: undefined }; // Not found is not an error
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        error: `Download failed: ${res.status} ${res.statusText} — ${body}`,
      };
    }

    const data = await res.text();
    const index = JSON.parse(data) as ProjectIndex;

    if (!index || !index.projectId || !Array.isArray(index.chunks)) {
      return { success: false, error: "Invalid index format from cloud" };
    }

    const etag = res.headers.get("etag") || undefined;
    console.log(
      `Cloud backup downloaded: ${projectId} (${index.chunks.length} chunks, etag: ${etag || "none"})`,
    );
    return { success: true, index, etag };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cloud backup download error: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Deletes a remote vector index.
 */
export async function deleteRemoteIndex(
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isCloudBackupEnabled()) {
    return { success: false, error: "Cloud backup not configured" };
  }

  try {
    const res = await fetch(vectorsUrl(projectId), {
      method: "DELETE",
      headers: headers(),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!res.ok && res.status !== 404) {
      return {
        success: false,
        error: `Delete failed: ${res.status} ${res.statusText}`,
      };
    }

    console.log(`Cloud backup deleted: ${projectId}`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// ─── Sync helpers ────────────────────────────────────────────────────────────

/**
 * After local vectorization: upload to cloud (fire-and-forget).
 * Call this after saveIndex() in vectorize.ts.
 */
export function scheduleCloudUpload(index: ProjectIndex): void {
  if (!isCloudBackupEnabled()) return;

  // Fire-and-forget — don't block vectorization
  uploadIndex(index).catch((err) => {
    console.error("Background cloud upload failed:", err);
  });
}

/**
 * Try to restore index from cloud when local is missing.
 * Returns true if restored, false otherwise.
 */
export async function restoreFromCloud(projectId: string): Promise<boolean> {
  if (!isCloudBackupEnabled()) return false;

  const indexPath = getIndexPath(projectId);
  if (existsSync(indexPath)) return false; // Local exists, no need

  console.log(`Local index missing for ${projectId}, checking cloud...`);
  const result = await downloadIndex(projectId);

  if (!result.success || !result.index) {
    console.log(`No cloud backup found for ${projectId}`);
    return false;
  }

  // Write to local — atomic via .tmp + rename
  const tmpPath = indexPath + ".cloud-restore.tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(result.index, null, 2));
    renameSync(tmpPath, indexPath);
    console.log(
      `Restored index from cloud: ${projectId} (${result.index.chunks.length} chunks)`,
    );
    return true;
  } catch (err) {
    console.error(`Failed to write restored index: ${err}`);
    return false;
  }
}
