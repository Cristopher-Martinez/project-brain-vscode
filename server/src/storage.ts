import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProjectIndex } from "./types.js";

const DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".mcp-rag-docs",
);

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export function getProjectId(projectPath: string): string {
  return createHash("md5")
    .update(normalizePath(projectPath))
    .digest("hex")
    .slice(0, 12);
}

export function getIndexPath(projectId: string): string {
  ensureDataDir();
  return join(DATA_DIR, `${projectId}.json`);
}

/**
 * Returns the local memory directory for a project.
 * Stored under ~/.mcp-rag-docs/<projectId>/memory/ — never pollutes the project dir.
 */
export function getLocalMemoryDir(projectPath: string): string {
  const projectId = getProjectId(projectPath);
  const dir = join(DATA_DIR, projectId, "memory");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadIndex(projectId: string): ProjectIndex | null {
  const indexPath = getIndexPath(projectId);
  const tmpPath = indexPath + ".tmp";

  if (existsSync(indexPath)) {
    try {
      const data = readFileSync(indexPath, "utf-8");
      const parsed = JSON.parse(data) as ProjectIndex;
      if (parsed && parsed.projectId && Array.isArray(parsed.chunks)) {
        return parsed;
      }
      console.error(`Corrupt index for ${projectId}: missing required fields`);
    } catch {
      console.error(
        `Failed to parse index for ${projectId}, checking tmp recovery...`,
      );
    }
  }

  // Recovery: try .tmp file
  if (existsSync(tmpPath)) {
    try {
      const data = readFileSync(tmpPath, "utf-8");
      const parsed = JSON.parse(data) as ProjectIndex;
      if (parsed && parsed.projectId && Array.isArray(parsed.chunks)) {
        console.log(`Recovered index from tmp file for ${projectId}`);
        try {
          renameSync(tmpPath, indexPath);
        } catch {
          /* best effort */
        }
        return parsed;
      }
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
    }
  }

  return null;
}

/** Atomic write: write to .tmp first, then rename. */
export function saveIndex(index: ProjectIndex): void {
  const indexPath = getIndexPath(index.projectId);
  const tmpPath = indexPath + ".tmp";

  // Truncate embedding precision to reduce file size (768 floats per chunk)
  const compactIndex = {
    ...index,
    chunks: index.chunks.map((c) => ({
      ...c,
      embedding: c.embedding.map((v) => Math.round(v * 1e6) / 1e6),
    })),
  };

  // No pretty-printing — saves ~30-40% file size on large indexes
  writeFileSync(tmpPath, JSON.stringify(compactIndex));
  renameSync(tmpPath, indexPath);
}

/** Create a .backup.json copy before destructive operations (e.g. provider change reindex). */
export function backupIndex(projectId: string): boolean {
  const indexPath = getIndexPath(projectId);
  const backupPath = indexPath.replace(".json", ".backup.json");
  if (!existsSync(indexPath)) return false;
  try {
    const data = readFileSync(indexPath);
    writeFileSync(backupPath, data);
    console.log(`Backup created: ${backupPath}`);
    return true;
  } catch (err) {
    console.error(`Backup failed for ${projectId}:`, err);
    return false;
  }
}

/** Restore from .backup.json if the main index is corrupt or missing. */
export function restoreBackup(projectId: string): boolean {
  const indexPath = getIndexPath(projectId);
  const backupPath = indexPath.replace(".json", ".backup.json");
  if (!existsSync(backupPath)) return false;
  try {
    renameSync(backupPath, indexPath);
    console.log(`Restored backup for ${projectId}`);
    return true;
  } catch (err) {
    console.error(`Restore failed for ${projectId}:`, err);
    return false;
  }
}

/**
 * Delete all local storage data for a project (index + memory dir).
 * Returns a summary of what was deleted.
 */
export function deleteProjectData(projectPath: string): { deleted: string[]; projectId: string } {
  const projectId = getProjectId(projectPath);
  const deleted: string[] = [];

  // Remove vector index file
  const indexPath = getIndexPath(projectId);
  if (existsSync(indexPath)) {
    unlinkSync(indexPath);
    deleted.push("vector-index");
  }

  // Remove backup index
  const backupPath = indexPath.replace(".json", ".backup.json");
  if (existsSync(backupPath)) {
    unlinkSync(backupPath);
    deleted.push("vector-index-backup");
  }

  // Remove local memory directory (opinions, diaries, learnings written via MCP)
  const localDir = join(DATA_DIR, projectId);
  if (existsSync(localDir)) {
    rmSync(localDir, { recursive: true, force: true });
    deleted.push("local-memory");
  }

  return { deleted, projectId };
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function listProjects(): string[] {
  ensureDataDir();
  return readdirSync(DATA_DIR)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(".json", ""));
}
