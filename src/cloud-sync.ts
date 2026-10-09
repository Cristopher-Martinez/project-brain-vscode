/**
 * CloudSync — Orchestrator for cloud memory synchronization.
 *
 * Coordinates MemoryFS uploads/downloads with the SaaS backend.
 * Implements:
 * - Debounced sync-up (local → cloud) triggered by file changes
 * - Periodic sync-down (cloud → local) for pinned files
 * - Hash-based diffing to minimize transfers
 * - Auto-eviction of non-pinned files after successful cloud upload
 * - Offline resilience via OfflineManager integration
 * - Status reporting for UI indicators
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AutoVectorizer, VectorizeBatchEvent } from "./auto-vectorizer";
import {
  MemoryFS,
  type CloudManifest,
  type CloudManifestEntry,
} from "./memory-fs";
import type { FileManifestEntry, SaaSClient } from "./saas-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SyncStatus =
  | "idle"
  | "syncing-up"
  | "syncing-down"
  | "error"
  | "offline"
  | "disabled";

/** Auto-delete mode for local files after cloud upload */
export type AutoDeleteMode = "never" | "space-limit" | "always";

export interface SyncStats {
  status: SyncStatus;
  lastSyncAt: string | null;
  filesUploaded: number;
  filesDownloaded: number;
  filesEvicted: number;
  errors: number;
}

export interface CloudSyncOptions {
  memoryFS: MemoryFS;
  saasClient: SaaSClient;
  projectId: string;
  memoryPath: string;
  log: (msg: string) => void;
  /** Debounce for upload after file change (default: 30s) */
  syncUpDebounceMs?: number;
  /** Interval for periodic sync-down (default: 5 min) */
  syncDownIntervalMs?: number;
  /** Max storage before auto-eviction kicks in (bytes, default: 10MB local) */
  maxLocalBytes?: number;
  /** Auto-delete mode: 'never' | 'space-limit' | 'always' (default: 'space-limit') */
  autoDeleteMode?: AutoDeleteMode;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SYNC_UP_DEBOUNCE = 30_000; // 30 seconds
const DEFAULT_SYNC_DOWN_INTERVAL = 5 * 60_000; // 5 minutes
const DEFAULT_MAX_LOCAL_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── CloudSync ──────────────────────────────────────────────────────────────

export class CloudSync implements vscode.Disposable {
  private memoryFS: MemoryFS;
  private saasClient: SaaSClient;
  private _projectId: string;
  private memoryPath: string;
  private log: (msg: string) => void;

  /** Cloud project ID — used for API calls */
  get cloudProjectId(): string {
    return this._projectId;
  }

  private syncUpDebounce: number;
  private syncDownInterval: number;
  private maxLocalBytes: number;
  private autoDeleteMode: AutoDeleteMode;

  private _status: SyncStatus = "idle";
  private _lastSyncAt: string | null = null;
  private _stats: SyncStats = {
    status: "idle",
    lastSyncAt: null,
    filesUploaded: 0,
    filesDownloaded: 0,
    filesEvicted: 0,
    errors: 0,
  };

  /** File system watcher for .project-brain/memory/ */
  private watcher: vscode.FileSystemWatcher | null = null;

  /** Debounce timer for sync-up */
  private syncUpTimer: NodeJS.Timeout | null = null;

  /** Periodic sync-down interval */
  private syncDownTimer: ReturnType<typeof setInterval> | null = null;

  /** Files changed since last sync (for batching) */
  private pendingChanges = new Set<string>();

  /** Prevent concurrent syncs */
  private isSyncing = false;

  /** Subscription to AutoVectorizer batch events */
  private vectorizerSubscription: vscode.Disposable | null = null;

  /** Whether this CloudSync is driven by AutoVectorizer events */
  private _connectedToVectorizer = false;

  /** Event emitter for status changes */
  private _onStatusChange = new vscode.EventEmitter<SyncStatus>();
  readonly onStatusChange = this._onStatusChange.event;

  constructor(options: CloudSyncOptions) {
    this.memoryFS = options.memoryFS;
    this.saasClient = options.saasClient;
    this._projectId = options.projectId;
    this.memoryPath = options.memoryPath;
    this.log = options.log;

    this.syncUpDebounce = options.syncUpDebounceMs ?? DEFAULT_SYNC_UP_DEBOUNCE;
    this.syncDownInterval =
      options.syncDownIntervalMs ?? DEFAULT_SYNC_DOWN_INTERVAL;
    this.maxLocalBytes = options.maxLocalBytes ?? this.readLocalStorageLimit();
    this.autoDeleteMode =
      options.autoDeleteMode ?? this.readAutoDeleteSetting();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Connect to an AutoVectorizer to unify the pipeline.
   * When connected, CloudSync skips its own file watcher and instead
   * triggers syncUp after each vectorization batch completes.
   * Flow: file change → vectorize → cloud sync → evict (if configured).
   */
  connectToVectorizer(vectorizer: AutoVectorizer): void {
    // Clean up any previous subscription
    this.vectorizerSubscription?.dispose();

    this.vectorizerSubscription = vectorizer.onBatchComplete(
      async (event: VectorizeBatchEvent) => {
        this.log(
          `[CloudSync] Vectorization batch complete (${event.files.length} files, +${event.chunksAdded}/-${event.chunksRemoved} chunks)`,
        );

        // Skip sync when vectorizer reports no file changes
        if (event.files.length === 0) {
          this.log("[CloudSync] No files in batch — skipping cloud sync");
          return;
        }

        // Add vectorized files to pending changes
        for (const f of event.files) {
          this.pendingChanges.add(f);
        }

        // Trigger upload
        await this.syncUp();
      },
    );

    this._connectedToVectorizer = true;
    this.log(
      "[CloudSync] Connected to AutoVectorizer — pipeline: vectorize → sync → evict",
    );
  }

  get status(): SyncStatus {
    return this._status;
  }

  get stats(): SyncStats {
    return { ...this._stats };
  }

  /**
   * Start watching for file changes and periodic sync.
   */
  start(): void {
    if (!this.memoryFS.cloudEnabled) {
      this._status = "disabled";
      this.log("[CloudSync] Not starting — cloud not enabled");
      return;
    }

    // Watch .project-brain/memory/ for changes — ONLY if not connected to vectorizer
    // When connected, the vectorizer watcher drives the pipeline
    if (!this._connectedToVectorizer) {
      const pattern = new vscode.RelativePattern(
        this.memoryPath,
        "**/*.{md,json}",
      );
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

      this.watcher.onDidChange((uri) => this.onFileChanged(uri));
      this.watcher.onDidCreate((uri) => this.onFileChanged(uri));
      // Don't sync on delete — eviction is controlled by CloudSync, not fs
    } else {
      this.log(
        "[CloudSync] File watcher skipped — driven by AutoVectorizer events",
      );
    }

    // Start periodic sync-down
    this.syncDownTimer = setInterval(
      () => this.syncDown(),
      this.syncDownInterval,
    );

    this._status = "idle";
    this.log("[CloudSync] Started — watching for file changes");

    // Initial sync-down to get latest from cloud
    void this.syncDown();
  }

  /**
   * Stop all watchers and timers.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.syncUpTimer) {
      clearTimeout(this.syncUpTimer);
      this.syncUpTimer = null;
    }
    if (this.syncDownTimer) {
      clearInterval(this.syncDownTimer);
      this.syncDownTimer = null;
    }
    if (this.vectorizerSubscription) {
      this.vectorizerSubscription.dispose();
      this.vectorizerSubscription = null;
    }
    this._connectedToVectorizer = false;
    this.pendingChanges.clear();
    this._status = "idle";
    this.log("[CloudSync] Stopped");
  }

  /**
   * Force a full sync (up + down). Used by manual "Sync Now" command.
   */
  async syncNow(): Promise<void> {
    if (this.isSyncing) {
      this.log("[CloudSync] Sync already in progress — skipping");
      return;
    }

    try {
      await this.syncUp(true); // force: upload all dirty files
      await this.syncDown();
    } catch (err) {
      this.log(
        `[CloudSync] Manual sync error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Upload changed files to cloud.
   * @param force If true, sync ALL local files (not just pending changes)
   */
  async syncUp(force = false): Promise<number> {
    if (this.isSyncing) return 0;
    this.isSyncing = true;
    this.setStatus("syncing-up");

    let uploaded = 0;

    try {
      // Collect files to sync
      const filesToSync = force
        ? this.getAllLocalFiles()
        : Array.from(this.pendingChanges);

      if (filesToSync.length === 0) {
        this.log("[CloudSync] Nothing to upload");
        return 0;
      }

      // Build hashes for batch diff — filter out files with empty hashes
      // (deleted or unreadable files produce empty hash which fails server validation)
      const localHashes = filesToSync
        .map((f) => ({
          path: f,
          hash: this.hashFile(f),
        }))
        .filter((f) => f.hash.length === 64);

      // Remove unresolvable files from pending changes
      const validPaths = new Set(localHashes.map((f) => f.path));
      for (const f of filesToSync) {
        if (!validPaths.has(f)) {
          this.pendingChanges.delete(f);
        }
      }

      if (localHashes.length === 0) {
        this.log("[CloudSync] No valid files to sync (all filtered)");
        return 0;
      }

      // Ask server what actually needs uploading (hash-based diff)
      const diff = await this.saasClient.batchSync(
        this._projectId,
        localHashes,
      );

      // Only upload files the server says are different or new
      const toUpload = diff?.toUpload ?? [];

      if (toUpload.length === 0 && diff) {
        this.log(
          `[CloudSync] All ${diff.synced?.length ?? 0} files already in sync`,
        );
      }

      for (const filePath of toUpload) {
        try {
          const absPath = this.memoryFS.resolve(filePath);
          if (!fs.existsSync(absPath)) continue;

          const content = fs.readFileSync(absPath, "utf-8");
          const result = await this.saasClient.uploadFile(
            this._projectId,
            filePath,
            content,
          );

          if (result) {
            uploaded++;
            this._stats.filesUploaded++;

            // Update manifest
            this.memoryFS.updateManifestEntry(filePath, {
              filePath,
              contentHash: result.contentHash,
              sizeBytes: result.sizeBytes,
              version: result.version,
              syncedAt: new Date().toISOString(),
              pinnedLocally: this.memoryFS.isPinned(filePath),
            });

            // Auto-evict non-pinned files based on configured mode
            if (
              this.autoDeleteMode !== "never" &&
              !this.memoryFS.isPinned(filePath)
            ) {
              const shouldEvictNow =
                this.autoDeleteMode === "always" || this.shouldEvict();
              if (shouldEvictNow) {
                this.memoryFS.evictLocal(filePath);
                this._stats.filesEvicted++;
              }
            }
          }
        } catch (err) {
          this._stats.errors++;
          this.log(
            `[CloudSync] Upload error (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Clear pending changes for uploaded files
      for (const f of toUpload) {
        this.pendingChanges.delete(f);
      }

      this._lastSyncAt = new Date().toISOString();
      this._stats.lastSyncAt = this._lastSyncAt;
      this.log(`[CloudSync] Uploaded ${uploaded} files`);
    } catch (err) {
      this._stats.errors++;
      this.setStatus("error");
      this.log(
        `[CloudSync] Sync-up error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.isSyncing = false;
      if (this._status !== "error") {
        this.setStatus("idle");
      }
    }

    return uploaded;
  }

  /**
   * Download updated files from cloud.
   * Only downloads pinned files and files that are locally present.
   */
  async syncDown(): Promise<number> {
    if (this.isSyncing) return 0;
    this.isSyncing = true;
    this.setStatus("syncing-down");

    let downloaded = 0;

    try {
      // Fetch cloud manifest
      const cloudManifest = await this.saasClient.getFileManifest(
        this._projectId,
      );
      if (!cloudManifest) {
        this.log("[CloudSync] No cloud manifest — skipping sync-down");
        return 0;
      }

      // Update our local manifest with cloud data
      const updatedManifest: CloudManifest = {
        projectId: this._projectId,
        lastSync: new Date().toISOString(),
        files: {},
      };

      for (const cloudFile of cloudManifest.files) {
        const entry: CloudManifestEntry = {
          filePath: cloudFile.filePath,
          contentHash: cloudFile.contentHash,
          sizeBytes: cloudFile.sizeBytes,
          version: cloudFile.version,
          syncedAt: cloudFile.syncedAt,
          pinnedLocally: this.memoryFS.isPinned(cloudFile.filePath),
        };
        updatedManifest.files[cloudFile.filePath] = entry;

        // Download if: pinned OR already exists locally with different hash
        const shouldDownload = this.shouldDownloadFile(cloudFile);
        if (shouldDownload) {
          try {
            const result = await this.saasClient.downloadFile(
              this._projectId,
              cloudFile.filePath,
            );
            if (result) {
              const absPath = this.memoryFS.resolve(cloudFile.filePath);
              const dir = path.dirname(absPath);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(absPath, result.content, "utf-8");
              downloaded++;
              this._stats.filesDownloaded++;
            }
          } catch (err) {
            this._stats.errors++;
            this.log(
              `[CloudSync] Download error (${cloudFile.filePath}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      this.memoryFS.updateManifest(updatedManifest);
      this._lastSyncAt = new Date().toISOString();
      this._stats.lastSyncAt = this._lastSyncAt;

      if (downloaded > 0) {
        this.log(`[CloudSync] Downloaded ${downloaded} files`);
      }
    } catch (err) {
      this._stats.errors++;
      this.setStatus("error");
      this.log(
        `[CloudSync] Sync-down error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.isSyncing = false;
      if (this._status !== "error") {
        this.setStatus("idle");
      }
    }

    return downloaded;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /**
   * Handle a file change event from the watcher.
   * Debounces the sync-up to batch rapid changes.
   */
  private onFileChanged(uri: vscode.Uri): void {
    const absPath = uri.fsPath;
    const relativePath = path.relative(this.memoryPath, absPath);

    // Ignore manifest file and hidden files
    if (
      relativePath.startsWith(".") ||
      relativePath.includes("sessions") ||
      relativePath === ".cloud-manifest.json"
    ) {
      return;
    }

    // Normalize path separators
    const normalized = relativePath.replace(/\\/g, "/");
    this.pendingChanges.add(normalized);

    // Debounce sync-up
    if (this.syncUpTimer) {
      clearTimeout(this.syncUpTimer);
    }
    this.syncUpTimer = setTimeout(() => {
      void this.syncUp();
    }, this.syncUpDebounce);
  }

  /**
   * Decide if a cloud file should be downloaded locally.
   */
  private shouldDownloadFile(cloudFile: FileManifestEntry): boolean {
    const isPinned = this.memoryFS.isPinned(cloudFile.filePath);
    const absPath = this.memoryFS.resolve(cloudFile.filePath);
    const existsLocally = fs.existsSync(absPath);

    // Always download pinned files if hash differs
    if (isPinned) {
      if (!existsLocally) return true;
      const localHash = this.hashFile(cloudFile.filePath);
      return localHash !== cloudFile.contentHash;
    }

    // For non-pinned: only download if it exists locally with stale hash
    if (existsLocally) {
      const localHash = this.hashFile(cloudFile.filePath);
      return localHash !== cloudFile.contentHash;
    }

    // Cloud-only non-pinned: don't download (lazy materialization)
    return false;
  }

  /**
   * Check if we should evict files (local storage exceeds threshold).
   */
  private shouldEvict(): boolean {
    return this.getLocalStorageBytes() > this.maxLocalBytes;
  }

  /**
   * Get total size of local memory files.
   */
  private getLocalStorageBytes(): number {
    let total = 0;
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            // skip
          }
        }
      }
    };
    walk(this.memoryPath);
    return total;
  }

  /**
   * Get all local memory file paths (relative).
   */
  private getAllLocalFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === "sessions") continue; // Skip sessions
          walk(path.join(dir, entry.name), relative);
        } else if (entry.isFile()) {
          files.push(relative);
        }
      }
    };
    walk(this.memoryPath, "");
    return files;
  }

  /**
   * Compute SHA-256 hash of a local file.
   */
  private hashFile(relativePath: string): string {
    const absPath = this.memoryFS.resolve(relativePath);
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      return crypto.createHash("sha256").update(content).digest("hex");
    } catch {
      return "";
    }
  }

  /**
   * Update status and emit event.
   */
  private setStatus(status: SyncStatus): void {
    if (this._status !== status) {
      this._status = status;
      this._stats.status = status;
      this._onStatusChange.fire(status);
    }
  }

  /**
   * Read auto-delete mode from VS Code settings.
   */
  private readAutoDeleteSetting(): AutoDeleteMode {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const value = config.get<string>(
      "cloudSync.autoDeleteAfterSync",
      "space-limit",
    );
    if (value === "never" || value === "always" || value === "space-limit") {
      return value;
    }
    // Migration: old boolean setting → new enum
    const legacyEvict = config.get<boolean>("cloudSync.autoEvict");
    if (legacyEvict === false) return "never";
    return "space-limit";
  }

  /**
   * Read local storage limit from VS Code settings (in bytes).
   */
  private readLocalStorageLimit(): number {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const mb = config.get<number>("cloudSync.localStorageLimitMB", 10);
    return Math.max(1, mb) * 1024 * 1024;
  }

  // ─── Disposal ─────────────────────────────────────────────────────

  dispose(): void {
    this.stop();
    this._onStatusChange.dispose();
  }
}
