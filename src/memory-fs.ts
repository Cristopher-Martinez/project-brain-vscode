/**
 * MemoryFS — Cloud-first file system abstraction for .project-brain/memory/.
 *
 * Implements the "Lazy Materialization" pattern:
 * - Local files are cached copies of cloud source-of-truth
 * - "Pinned" files always stay local (BOOT.md, 14_OPINIONS.md, etc.)
 * - Other files are fetched on-demand with TTL-based caching
 * - Writes go to local first, then async-upload to cloud
 * - When offline, operates fully from local copies
 *
 * Cloud manifest tracks what exists in R2 without needing local copies.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { SaaSClient } from "./saas-client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CloudManifestEntry {
  filePath: string; // Relative to .project-brain/memory/ (e.g., "BOOT.md")
  contentHash: string; // SHA-256 of content
  sizeBytes: number;
  version: number;
  syncedAt: string; // ISO date
  pinnedLocally: boolean; // If true, never evict
}

export interface CloudManifest {
  projectId: string;
  lastSync: string; // ISO date
  files: Record<string, CloudManifestEntry>; // keyed by filePath
}

export interface MemoryFSOptions {
  memoryPath: string; // Absolute path to .project-brain/memory/
  projectId: string;
  saasClient: SaaSClient;
  log: (msg: string) => void;
  cacheTtlMs?: number; // Default: 5 minutes
}

interface CacheEntry {
  content: string;
  fetchedAt: number;
  hash: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Files that ALWAYS remain local — never evicted */
const DEFAULT_PINNED_FILES = [
  "BOOT.md",
  "14_OPINIONS.md",
  "07_SESSION_HANDOFF.md",
  "09_AGENT_SOUL.md",
  "08_AGENT_IDENTITY.md",
  "TASK_QUEUE.md",
  // Writable by writeMemory — must stay local to prevent data loss after eviction
  "01_ARCHITECTURE.md",
  "02_CODE_MAP.md",
  "03_DEPENDENCIES.md",
  "04_LEARNINGS.md",
  "05_TROUBLESHOOTING.md",
];

const MANIFEST_FILENAME = ".cloud-manifest.json";
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const UPLOAD_DEBOUNCE_MS = 3000; // 3 seconds

// ─── MemoryFS ───────────────────────────────────────────────────────────────

export class MemoryFS implements vscode.Disposable {
  private memoryPath: string;
  private projectId: string;
  private saasClient: SaaSClient;
  private log: (msg: string) => void;
  private cacheTtl: number;

  /** In-memory cache for fetched files */
  private cache = new Map<string, CacheEntry>();

  /** Cloud manifest (source of truth for what exists remotely) */
  private manifest: CloudManifest | null = null;

  /** Files pinned locally (always kept on disk) */
  private pinnedFiles = new Set<string>(DEFAULT_PINNED_FILES);

  /** Pending uploads (debounced) */
  private uploadQueue = new Map<string, NodeJS.Timeout>();

  /** Whether cloud features are available (Pro+ with cloud_storage) */
  private _cloudEnabled = false;

  /** Upload in progress flag to prevent concurrent uploads */
  private uploading = new Set<string>();

  constructor(options: MemoryFSOptions) {
    this.memoryPath = options.memoryPath;
    this.projectId = options.projectId;
    this.saasClient = options.saasClient;
    this.log = options.log;
    this.cacheTtl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL;

    this.loadManifest();
  }

  // ─── Public API ───────────────────────────────────────────────────

  /** Enable cloud features (call after license check confirms Pro+) */
  enableCloud(): void {
    this._cloudEnabled = true;
    this.log("[MemoryFS] Cloud mode ENABLED");
  }

  /** Disable cloud features (free tier or offline) */
  disableCloud(): void {
    this._cloudEnabled = false;
    this.log("[MemoryFS] Cloud mode DISABLED — local only");
  }

  get cloudEnabled(): boolean {
    return this._cloudEnabled;
  }

  /**
   * Update the cloud project ID (UUID from backend registration).
   */
  setProjectId(projectId: string): void {
    if (!projectId || this.projectId === projectId) return;
    this.projectId = projectId;
    if (this.manifest) {
      this.manifest.projectId = projectId;
      this.saveManifest();
    }
    this.log(`[MemoryFS] Cloud project ID updated: ${projectId}`);
  }

  /**
   * Read a memory file. Resolution order:
   * 1. Local file (if exists and not stale)
   * 2. In-memory cache (if within TTL)
   * 3. Cloud download (if cloud enabled)
   * 4. null (file not found anywhere)
   */
  async readFile(relativePath: string): Promise<string | null> {
    const absPath = this.resolve(relativePath);

    // 1. Try local file first (always preferred)
    if (fs.existsSync(absPath)) {
      try {
        return fs.readFileSync(absPath, "utf-8");
      } catch {
        this.log(`[MemoryFS] Error reading local file: ${relativePath}`);
      }
    }

    // 2. Check in-memory cache
    const cached = this.cache.get(relativePath);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtl) {
      return cached.content;
    }

    // 3. Try cloud download
    if (this._cloudEnabled && this.isInManifest(relativePath)) {
      try {
        const content = await this.downloadFromCloud(relativePath);
        if (content !== null) {
          // Cache in memory
          this.cache.set(relativePath, {
            content,
            fetchedAt: Date.now(),
            hash: this.simpleHash(content),
          });
          return content;
        }
      } catch (err) {
        this.log(
          `[MemoryFS] Cloud download failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return null;
  }

  /**
   * Write a memory file. Strategy:
   * 1. Always write to local disk
   * 2. If cloud enabled, enqueue async upload (debounced)
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const absPath = this.resolve(relativePath);

    // Ensure directory exists
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write locally
    fs.writeFileSync(absPath, content, "utf-8");

    // Update in-memory cache
    const hash = this.simpleHash(content);
    this.cache.set(relativePath, {
      content,
      fetchedAt: Date.now(),
      hash,
    });

    // Enqueue cloud upload (debounced)
    if (this._cloudEnabled) {
      this.enqueueUpload(relativePath, content);
    }
  }

  /**
   * Check if a file exists (locally or in cloud manifest).
   */
  fileExists(relativePath: string): boolean {
    const absPath = this.resolve(relativePath);
    if (fs.existsSync(absPath)) return true;
    if (this._cloudEnabled && this.isInManifest(relativePath)) return true;
    return false;
  }

  /**
   * List all memory files (combining local + cloud manifest).
   */
  listFiles(): string[] {
    const files = new Set<string>();

    // Local files
    this.walkDir(this.memoryPath, "", files);

    // Cloud manifest entries
    if (this.manifest) {
      for (const key of Object.keys(this.manifest.files)) {
        files.add(key);
      }
    }

    // Filter out internal files
    files.delete(MANIFEST_FILENAME);

    return Array.from(files).sort();
  }

  /**
   * Pin a file so it always stays local (never evicted).
   */
  pinFile(relativePath: string): void {
    this.pinnedFiles.add(relativePath);
    this.log(`[MemoryFS] Pinned: ${relativePath}`);
  }

  /**
   * Unpin a file (eligible for eviction after next sync).
   */
  unpinFile(relativePath: string): void {
    if (DEFAULT_PINNED_FILES.includes(relativePath)) {
      this.log(`[MemoryFS] Cannot unpin default pinned file: ${relativePath}`);
      return;
    }
    this.pinnedFiles.delete(relativePath);
    this.log(`[MemoryFS] Unpinned: ${relativePath}`);
  }

  /**
   * Check if a file is pinned locally.
   */
  isPinned(relativePath: string): boolean {
    return this.pinnedFiles.has(relativePath);
  }

  /**
   * Delete a local file (cloud copy remains unless explicitly deleted).
   * Primarily used for eviction of non-pinned files.
   */
  evictLocal(relativePath: string): boolean {
    if (this.pinnedFiles.has(relativePath)) {
      this.log(`[MemoryFS] Refusing to evict pinned file: ${relativePath}`);
      return false;
    }

    const absPath = this.resolve(relativePath);
    if (fs.existsSync(absPath)) {
      try {
        fs.unlinkSync(absPath);
        this.log(`[MemoryFS] Evicted local: ${relativePath}`);
        return true;
      } catch {
        this.log(`[MemoryFS] Failed to evict: ${relativePath}`);
      }
    }
    return false;
  }

  /**
   * Force download a file from cloud and save locally.
   * Used for "materialize" operations.
   */
  async materialize(relativePath: string): Promise<string | null> {
    if (!this._cloudEnabled) return null;

    try {
      const content = await this.downloadFromCloud(relativePath);
      if (content === null) return null;

      const absPath = this.resolve(relativePath);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(absPath, content, "utf-8");

      this.cache.set(relativePath, {
        content,
        fetchedAt: Date.now(),
        hash: this.simpleHash(content),
      });

      this.log(`[MemoryFS] Materialized: ${relativePath}`);
      return content;
    } catch (err) {
      this.log(
        `[MemoryFS] Materialize failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Check if a file is in the cloud manifest (exists remotely).
   */
  isInManifest(relativePath: string): boolean {
    return this.manifest?.files[relativePath] !== undefined;
  }

  /**
   * Check if a file only exists in the cloud (not local).
   */
  isCloudOnly(relativePath: string): boolean {
    const absPath = this.resolve(relativePath);
    return !fs.existsSync(absPath) && this.isInManifest(relativePath);
  }

  /**
   * Get storage stats for status display.
   */
  getStats(): {
    localFiles: number;
    cloudFiles: number;
    cloudOnlyFiles: number;
    pinnedFiles: number;
    pendingUploads: number;
  } {
    const localFiles = this.countLocalFiles();
    const cloudFiles = this.manifest
      ? Object.keys(this.manifest.files).length
      : 0;

    let cloudOnlyFiles = 0;
    if (this.manifest) {
      for (const key of Object.keys(this.manifest.files)) {
        if (!fs.existsSync(this.resolve(key))) {
          cloudOnlyFiles++;
        }
      }
    }

    return {
      localFiles,
      cloudFiles,
      cloudOnlyFiles,
      pinnedFiles: this.pinnedFiles.size,
      pendingUploads: this.uploadQueue.size,
    };
  }

  /**
   * Resolve a relative path to absolute within .project-brain/memory/.
   */
  resolve(relativePath: string): string {
    return path.join(this.memoryPath, relativePath);
  }

  /**
   * Get the cloud manifest (for sync operations).
   */
  getManifest(): CloudManifest | null {
    return this.manifest;
  }

  /**
   * Update the manifest with data from the cloud.
   */
  updateManifest(manifest: CloudManifest): void {
    this.manifest = manifest;
    this.saveManifest();
  }

  /**
   * Update a single entry in the manifest.
   */
  updateManifestEntry(relativePath: string, entry: CloudManifestEntry): void {
    if (!this.manifest) {
      this.manifest = {
        projectId: this.projectId,
        lastSync: new Date().toISOString(),
        files: {},
      };
    }
    this.manifest.files[relativePath] = entry;
    this.manifest.lastSync = new Date().toISOString();
    this.saveManifest();
  }

  /**
   * Remove an entry from the manifest.
   */
  removeManifestEntry(relativePath: string): void {
    if (this.manifest?.files[relativePath]) {
      delete this.manifest.files[relativePath];
      this.manifest.lastSync = new Date().toISOString();
      this.saveManifest();
    }
  }

  // ─── Cloud Operations ─────────────────────────────────────────────

  /**
   * Download a file from the cloud via SaaSClient.
   */
  private async downloadFromCloud(
    relativePath: string,
  ): Promise<string | null> {
    try {
      const result = await this.saasClient.downloadFile(
        this.projectId,
        relativePath,
      );
      return result?.content ?? null;
    } catch (err) {
      this.log(
        `[MemoryFS] Download error (${relativePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Enqueue a file for cloud upload with debounce.
   * Multiple rapid writes to the same file only trigger one upload.
   */
  private enqueueUpload(relativePath: string, content: string): void {
    // Clear any pending upload for this file
    const existing = this.uploadQueue.get(relativePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(async () => {
      this.uploadQueue.delete(relativePath);
      await this.uploadToCloud(relativePath, content);
    }, UPLOAD_DEBOUNCE_MS);

    this.uploadQueue.set(relativePath, timeout);
  }

  /**
   * Upload a file to the cloud via SaaSClient.
   */
  private async uploadToCloud(
    relativePath: string,
    content: string,
  ): Promise<void> {
    if (this.uploading.has(relativePath)) return;
    this.uploading.add(relativePath);

    try {
      const result = await this.saasClient.uploadFile(
        this.projectId,
        relativePath,
        content,
      );

      if (result) {
        // Update manifest with new version info
        this.updateManifestEntry(relativePath, {
          filePath: relativePath,
          contentHash: result.contentHash ?? this.simpleHash(content),
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          version: result.version ?? 1,
          syncedAt: new Date().toISOString(),
          pinnedLocally: this.pinnedFiles.has(relativePath),
        });
        this.log(`[MemoryFS] Uploaded: ${relativePath}`);
      }
    } catch (err) {
      this.log(
        `[MemoryFS] Upload failed (${relativePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      // File stays local — will retry on next write or sync
    } finally {
      this.uploading.delete(relativePath);
    }
  }

  // ─── Manifest Persistence ─────────────────────────────────────────

  private loadManifest(): void {
    const manifestPath = path.join(this.memoryPath, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      this.manifest = null;
      return;
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      this.manifest = JSON.parse(raw) as CloudManifest;
    } catch {
      this.log("[MemoryFS] Failed to parse cloud manifest — starting fresh");
      this.manifest = null;
    }
  }

  private saveManifest(): void {
    if (!this.manifest) return;

    const manifestPath = path.join(this.memoryPath, MANIFEST_FILENAME);
    try {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(this.manifest, null, 2),
        "utf-8",
      );
    } catch (err) {
      this.log(
        `[MemoryFS] Failed to save manifest: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Clear the cloud manifest — call after purging all cloud files.
   * Resets the manifest to empty so MemoryFS knows nothing is cloud-backed.
   */
  clearCloudManifest(): void {
    this.manifest = {
      projectId: this.manifest?.projectId ?? "",
      lastSync: "",
      files: {},
    };
    this.saveManifest();
    this.log("[MemoryFS] Cloud manifest cleared (purge)");
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private walkDir(dir: string, prefix: string, result: Set<string>): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Skip hidden dirs and sessions
        if (entry.name.startsWith(".") || entry.name === "sessions") continue;
        this.walkDir(path.join(dir, entry.name), relative, result);
      } else if (entry.isFile() && !entry.name.startsWith(".")) {
        result.add(relative);
      }
    }
  }

  private countLocalFiles(): number {
    const files = new Set<string>();
    this.walkDir(this.memoryPath, "", files);
    return files.size;
  }

  /**
   * Simple hash for content comparison (not crypto-grade).
   * Used only for local diffing — actual crypto uses SHA-256 on the backend.
   */
  private simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
  }

  // ─── Disposal ─────────────────────────────────────────────────────

  dispose(): void {
    // Clear all pending upload timeouts
    for (const timeout of this.uploadQueue.values()) {
      clearTimeout(timeout);
    }
    this.uploadQueue.clear();
    this.cache.clear();
  }
}
