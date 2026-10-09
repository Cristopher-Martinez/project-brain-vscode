import chokidar from "chokidar";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { chunkDocument, type ChunkWithoutEmbedding } from "./chunker.js";
import { generateEmbeddings } from "./embeddings.js";
import {
  getIndexPath,
  getProjectId,
  hashContent,
  loadIndex,
  saveIndex,
} from "./storage.js";
import { findMemoryFolder, vectorizeProject } from "./vectorize.js";

// ─── Watcher status file (cross-process state) ──────────────────────────────
// The CLI watcher process writes a `.watcher.json` file so the MCP server
// (running in a different process) can read watcher state accurately.

interface WatcherStatusFile {
  pid: number;
  projectPath: string;
  startedAt: number;
  lastSync: number;
  totalUpdates: number;
  pendingChanges: number;
  isProcessing: boolean;
  lastError: string | null;
}

function getWatcherStatusPath(projectId: string): string {
  return getIndexPath(projectId).replace(".json", ".watcher.json");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeWatcherStatus(state: WatcherState): void {
  const statusPath = getWatcherStatusPath(state.projectId);
  const status: WatcherStatusFile = {
    pid: process.pid,
    projectPath: state.projectPath,
    startedAt: state.lastSyncTime,
    lastSync: state.lastSyncTime,
    totalUpdates: state.stats.totalUpdates,
    pendingChanges: state.pendingChanges.size + state.batchedChanges.size,
    isProcessing: state.isProcessing,
    lastError: state.stats.lastError,
  };
  try {
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
  } catch {
    // Best effort — don't crash the watcher for a status write failure
  }
}

function removeWatcherStatus(projectId: string): void {
  const statusPath = getWatcherStatusPath(projectId);
  try {
    if (existsSync(statusPath)) unlinkSync(statusPath);
  } catch {
    // Best effort
  }
}

function readWatcherStatus(projectId: string): WatcherStatusFile | null {
  const statusPath = getWatcherStatusPath(projectId);
  try {
    if (!existsSync(statusPath)) return null;
    const raw = readFileSync(statusPath, "utf-8");
    const status = JSON.parse(raw) as WatcherStatusFile;
    if (!isProcessAlive(status.pid)) {
      unlinkSync(statusPath);
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

const registeredProjectIds = new Set<string>();
let cleanupRegistered = false;

function registerForCleanup(projectId: string): void {
  registeredProjectIds.add(projectId);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    const cleanup = () => {
      for (const id of registeredProjectIds) {
        removeWatcherStatus(id);
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }
}

// ─── Cloud-backed protection ─────────────────────────────────────────────────
// When CLOUD_MANIFEST_PATH is set, files listed in the manifest are cloud-backed.
// The watcher SKIPS vector deletion for these files on unlink events —
// the file is evicted from local disk but its content still lives in R2.

function isCloudBacked(filePath: string, memoryPath: string): boolean {
  const manifestPath = process.env.CLOUD_MANIFEST_PATH;
  if (!manifestPath) return false;

  try {
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const relativePath = relative(memoryPath, filePath).replace(/\\/g, "/");
    return manifest?.files?.[relativePath] !== undefined;
  } catch {
    return false;
  }
}

// ─── Async Mutex per project ─────────────────────────────────────────────────

class ProjectMutex {
  private locks = new Map<string, Promise<void>>();

  async acquire(projectId: string): Promise<() => void> {
    while (this.locks.has(projectId)) {
      await this.locks.get(projectId);
    }
    let release!: () => void;
    const promise = new Promise<void>((res) => {
      release = res;
    });
    this.locks.set(projectId, promise);
    return () => {
      this.locks.delete(projectId);
      release();
    };
  }
}

export const projectMutex = new ProjectMutex();

// ─── Types ───────────────────────────────────────────────────────────────────

interface WatcherState {
  projectPath: string;
  memoryPath: string;
  projectId: string;
  watcher: chokidar.FSWatcher | null;
  pendingChanges: Map<string, "add" | "change" | "delete">;
  batchedChanges: Map<string, "add" | "change" | "delete">;
  debounceTimer: NodeJS.Timeout | null;
  recentEventTimestamps: number[];
  embeddingCache: Map<string, number[]>;
  isProcessing: boolean;
  stats: {
    totalUpdates: number;
    chunksAdded: number;
    chunksRemoved: number;
    cacheHits: number;
    lastError: string | null;
  };
  lastSyncTime: number;
}

const watchers = new Map<string, WatcherState>();

// ─── Ignore / priority ──────────────────────────────────────────────────────

const IGNORE_PATTERNS = [
  /\.md~$/,
  /\.swp$/,
  /\.tmp$/,
  /~\$.*\.md$/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
];

const PRIORITY_FILES = [
  "00_PROJECT_OVERVIEW.md",
  "01_ARCHITECTURE.md",
  "02_CODE_MAP.md",
];

function shouldIgnoreFile(filePath: string): boolean {
  const name = basename(filePath);
  return IGNORE_PATTERNS.some((p) => p.test(name));
}

function getFilePriority(filePath: string): number {
  const name = basename(filePath);
  const idx = PRIORITY_FILES.indexOf(name);
  return idx >= 0 ? idx : PRIORITY_FILES.length;
}

// ─── Adaptive debounce ──────────────────────────────────────────────────────

function getAdaptiveDebounce(state: WatcherState): number {
  const now = Date.now();
  state.recentEventTimestamps = state.recentEventTimestamps.filter(
    (t) => now - t < 2000,
  );
  state.recentEventTimestamps.push(now);

  if (state.recentEventTimestamps.length > 5) return 3000;
  if (state.recentEventTimestamps.length > 2) return 1500;
  return 500;
}

// ─── Core: start / stop ─────────────────────────────────────────────────────

export async function startWatching(projectPath: string): Promise<void> {
  const memoryPath = findMemoryFolder(projectPath);
  if (!memoryPath) {
    throw new Error(`No memory folder found in ${projectPath}`);
  }

  const projectId = getProjectId(projectPath);

  if (watchers.has(projectId)) {
    await stopWatching(projectPath);
  }

  console.log(`\n  Scanning for changes since last sync...`);

  const release = await projectMutex.acquire(projectId);
  try {
    await vectorizeProject({ projectPath, forceReindex: false });
  } finally {
    release();
  }

  const state: WatcherState = {
    projectPath,
    memoryPath,
    projectId,
    watcher: null,
    pendingChanges: new Map(),
    batchedChanges: new Map(),
    debounceTimer: null,
    recentEventTimestamps: [],
    embeddingCache: new Map(),
    isProcessing: false,
    stats: {
      totalUpdates: 0,
      chunksAdded: 0,
      chunksRemoved: 0,
      cacheHits: 0,
      lastError: null,
    },
    lastSyncTime: Date.now(),
  };

  const watcher = chokidar.watch(join(memoryPath, "**/*.md"), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher
    .on("add", (path) => handleFileChange(state, path, "add"))
    .on("change", (path) => handleFileChange(state, path, "change"))
    .on("unlink", (path) => handleFileChange(state, path, "delete"));

  state.watcher = watcher;
  watchers.set(projectId, state);
  writeWatcherStatus(state);
  registerForCleanup(projectId);

  console.log(`\n  Watching for changes in ${basename(memoryPath)}/`);
}

function handleFileChange(
  state: WatcherState,
  filePath: string,
  event: "add" | "change" | "delete",
): void {
  if (shouldIgnoreFile(filePath)) return;

  const priorityLabel =
    getFilePriority(filePath) < PRIORITY_FILES.length ? " [PRIORITY]" : "";
  console.log(
    `\n  ${event.toUpperCase()}: ${basename(filePath)}${priorityLabel}`,
  );

  if (state.isProcessing) {
    state.pendingChanges.set(filePath, event);
    return;
  }

  state.batchedChanges.set(filePath, event);

  if (state.debounceTimer) clearTimeout(state.debounceTimer);

  const debounceMs = getAdaptiveDebounce(state);
  state.debounceTimer = setTimeout(() => processBatch(state), debounceMs);
}

async function processBatch(state: WatcherState): Promise<void> {
  if (state.batchedChanges.size === 0) return;

  state.isProcessing = true;
  const changes = new Map(state.batchedChanges);
  state.batchedChanges.clear();

  const release = await projectMutex.acquire(state.projectId);

  try {
    const index = loadIndex(state.projectId);
    if (!index) {
      console.log("  No existing index — running full vectorization");
      await vectorizeProject({ projectPath: state.projectPath });
      return;
    }

    // Sort by priority
    const sorted = Array.from(changes.entries()).sort(
      ([a], [b]) => getFilePriority(a) - getFilePriority(b),
    );

    let chunksAdded = 0;
    let chunksRemoved = 0;

    for (const [filePath, event] of sorted) {
      // Cloud-backed guard: if file is deleted locally but exists in cloud
      // manifest, KEEP its vectors — the content still lives in R2
      if (event === "delete" && isCloudBacked(filePath, state.memoryPath)) {
        console.log(
          `  SKIP vector deletion for ${basename(filePath)} (cloud-backed)`,
        );
        continue;
      }

      const oldChunks = index.chunks.filter((c) => c.filePath === filePath);
      index.chunks = index.chunks.filter((c) => c.filePath !== filePath);
      chunksRemoved += oldChunks.length;

      if (event !== "delete") {
        try {
          const content = readFileSync(filePath, "utf-8");
          const hash = hashContent(content);
          index.fileHashes[filePath] = hash;

          const newRawChunks: ChunkWithoutEmbedding[] = chunkDocument({
            filePath,
            projectPath: state.projectPath,
            projectId: state.projectId,
          });

          const { chunks: embeddedChunks } = await generateEmbeddings(
            newRawChunks,
            index.vocabulary,
          );

          index.chunks.push(...embeddedChunks);
          chunksAdded += embeddedChunks.length;
        } catch (error) {
          state.stats.lastError =
            error instanceof Error ? error.message : String(error);
          console.error(`  Failed to process ${basename(filePath)}:`, error);
        }
      } else {
        delete index.fileHashes[filePath];
      }
    }

    index.lastUpdated = Date.now();
    saveIndex(index);

    state.stats.totalUpdates++;
    state.stats.chunksAdded += chunksAdded;
    state.stats.chunksRemoved += chunksRemoved;
    state.lastSyncTime = Date.now();
    writeWatcherStatus(state);

    console.log(`  Updated: +${chunksAdded} -${chunksRemoved} chunks`);
  } catch (error) {
    state.stats.lastError =
      error instanceof Error ? error.message : String(error);
    console.error("  Batch processing error:", error);
  } finally {
    release();
    state.isProcessing = false;
  }

  // Process any changes that arrived during processing
  if (state.pendingChanges.size > 0) {
    for (const [path, event] of state.pendingChanges) {
      state.batchedChanges.set(path, event);
    }
    state.pendingChanges.clear();
    const debounceMs = getAdaptiveDebounce(state);
    state.debounceTimer = setTimeout(() => processBatch(state), debounceMs);
  }
}

export async function stopWatching(projectPath: string): Promise<void> {
  const projectId = getProjectId(projectPath);
  const state = watchers.get(projectId);
  if (!state) return;

  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.watcher) await state.watcher.close();

  watchers.delete(projectId);
  removeWatcherStatus(projectId);
  console.log(`  Stopped watching ${basename(projectPath)}`);
}

export function isWatching(projectPath: string): boolean {
  const projectId = getProjectId(projectPath);
  // Check in-memory first (same process), then shared status file (cross-process)
  if (watchers.has(projectId)) return true;
  return readWatcherStatus(projectId) !== null;
}

export function getWatchedProjects(): string[] {
  return Array.from(watchers.values()).map((s) => s.projectPath);
}

export function getWatcherStats(projectPath: string): {
  totalUpdates: number;
  pendingChanges: number;
  isProcessing: boolean;
  lastSyncTime: number;
  lastError: string | null;
} | null {
  const projectId = getProjectId(projectPath);
  // In-memory state (same process)
  const state = watchers.get(projectId);
  if (state) {
    return {
      totalUpdates: state.stats.totalUpdates,
      pendingChanges: state.pendingChanges.size + state.batchedChanges.size,
      isProcessing: state.isProcessing,
      lastSyncTime: state.lastSyncTime,
      lastError: state.stats.lastError,
    };
  }
  // Cross-process: read from shared status file
  const fileStatus = readWatcherStatus(projectId);
  if (!fileStatus) return null;
  return {
    totalUpdates: fileStatus.totalUpdates,
    pendingChanges: fileStatus.pendingChanges,
    isProcessing: fileStatus.isProcessing,
    lastSyncTime: fileStatus.lastSync,
    lastError: fileStatus.lastError,
  };
}
