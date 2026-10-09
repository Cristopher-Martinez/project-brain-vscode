/**
 * Filesystem utilities — Robust operations for cross-platform support.
 *
 * @module fs-utils
 */

import * as fs from "fs";

const TRANSIENT_FS_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/**
 * Robust recursive directory removal with retry.
 * Handles Windows EBUSY/EPERM locks (e.g., git processes holding handles).
 * Uses exponential backoff: 200ms, 400ms, 800ms, 1600ms.
 */
export async function robustRm(dirPath: string, retries = 4): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i < retries && code && TRANSIENT_FS_ERRORS.has(code)) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      } else {
        throw err;
      }
    }
  }
}

/** Robust rename with retry — used for atomic swap from temp clone dir → final dir. */
export async function robustRename(
  fromPath: string,
  toPath: string,
  retries = 4,
): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i < retries && code && TRANSIENT_FS_ERRORS.has(code)) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      } else {
        throw err;
      }
    }
  }
}
