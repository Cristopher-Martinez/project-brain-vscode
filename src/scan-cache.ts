import { createHash } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { log, logError, logWarn } from "./logger";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface FileHashEntry {
  hash: string;
  lastModified: number;
  lineCount: number;
}

interface ScanCache {
  version: number;
  projectRoot: string;
  files: Record<string, FileHashEntry>;
  lastFullScan: number;
}

const CACHE_VERSION = 1;
const CACHE_FILENAME = ".project-brain-cache.json";

// ─── ScanCacheManager ────────────────────────────────────────────────────────

export class ScanCacheManager {
  private cache: ScanCache | null = null;
  private cacheUri: vscode.Uri;

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    this.cacheUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      ".vscode",
      CACHE_FILENAME,
    );
  }

  /**
   * Load cache from disk. Returns null if cache doesn't exist or is invalid.
   */
  async load(): Promise<ScanCache | null> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheUri);
      const parsed = JSON.parse(Buffer.from(raw).toString("utf-8"));

      if (parsed.version !== CACHE_VERSION) {
        log("Scan cache version mismatch — will rebuild");
        return null;
      }

      this.cache = parsed;
      return this.cache;
    } catch {
      return null;
    }
  }

  /**
   * Save current cache to disk.
   */
  async save(): Promise<void> {
    if (!this.cache) return;

    const json = JSON.stringify(this.cache, null, 2);
    await vscode.workspace.fs.writeFile(
      this.cacheUri,
      Buffer.from(json, "utf-8"),
    );
  }

  /**
   * Initialize or reset the cache.
   */
  init(): void {
    this.cache = {
      version: CACHE_VERSION,
      projectRoot: this.workspaceFolder.uri.fsPath,
      files: {},
      lastFullScan: Date.now(),
    };
  }

  /**
   * Determine which files have changed since the last scan.
   * Returns arrays of changed, added, and deleted files.
   */
  async getChangedFiles(currentFiles: vscode.Uri[]): Promise<{
    changed: vscode.Uri[];
    added: vscode.Uri[];
    deleted: string[];
    unchanged: string[];
  }> {
    const cache = this.cache;
    if (!cache) {
      // No cache — everything is new
      return {
        changed: [],
        added: currentFiles,
        deleted: [],
        unchanged: [],
      };
    }

    const rootPath = this.workspaceFolder.uri.fsPath;
    const currentPaths = new Set<string>();
    const changed: vscode.Uri[] = [];
    const added: vscode.Uri[] = [];
    const unchanged: string[] = [];

    for (const fileUri of currentFiles) {
      const relativePath = path
        .relative(rootPath, fileUri.fsPath)
        .replace(/\\/g, "/");
      currentPaths.add(relativePath);

      const cached = cache.files[relativePath];
      if (!cached) {
        added.push(fileUri);
        continue;
      }

      // Check if file has changed by comparing stat mtime
      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (stat.mtime > cached.lastModified) {
          // mtime differs — verify with content hash
          const content = await vscode.workspace.fs.readFile(fileUri);
          const hash = hashContent(content);
          if (hash !== cached.hash) {
            changed.push(fileUri);
          } else {
            // mtime changed but content is same (e.g., touched)
            cached.lastModified = stat.mtime;
            unchanged.push(relativePath);
          }
        } else {
          unchanged.push(relativePath);
        }
      } catch {
        // Can't stat — treat as changed
        changed.push(fileUri);
      }
    }

    // Find deleted files
    const deleted: string[] = [];
    for (const prevPath of Object.keys(cache.files)) {
      if (!currentPaths.has(prevPath)) {
        deleted.push(prevPath);
      }
    }

    return { changed, added, deleted, unchanged };
  }

  /**
   * Update cache entry for a file after scanning it.
   */
  async updateEntry(fileUri: vscode.Uri): Promise<void> {
    if (!this.cache) this.init();

    const rootPath = this.workspaceFolder.uri.fsPath;
    const relativePath = path
      .relative(rootPath, fileUri.fsPath)
      .replace(/\\/g, "/");

    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      const content = await vscode.workspace.fs.readFile(fileUri);
      const hash = hashContent(content);
      const lineCount = Buffer.from(content)
        .toString("utf-8")
        .split("\n").length;

      this.cache!.files[relativePath] = {
        hash,
        lastModified: stat.mtime,
        lineCount,
      };
    } catch {
      // File unreadable — remove from cache
      delete this.cache!.files[relativePath];
    }
  }

  /**
   * Remove a file from the cache (after deletion).
   */
  removeEntry(relativePath: string): void {
    if (this.cache) {
      delete this.cache.files[relativePath];
    }
  }

  /**
   * Get summary stats about the cache.
   */
  getStats(): {
    totalFiles: number;
    lastFullScan: number;
  } | null {
    if (!this.cache) return null;
    return {
      totalFiles: Object.keys(this.cache.files).length,
      lastFullScan: this.cache.lastFullScan,
    };
  }

  /**
   * Update the lastFullScan timestamp.
   */
  markFullScan(): void {
    if (this.cache) {
      this.cache.lastFullScan = Date.now();
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashContent(content: Uint8Array): string {
  return createHash("md5").update(Buffer.from(content)).digest("hex");
}
