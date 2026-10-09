import { glob } from "glob";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chunkDocument, type ChunkWithoutEmbedding } from "./chunker.js";
import { restoreFromCloud, scheduleCloudUpload } from "./cloud-backup.js";
import { checkRemoteProvider, generateEmbeddings } from "./embeddings.js";
import { buildGraphFromChunks } from "./graph.js";
import { MemoryHistory } from "./history.js";
import {
  backupIndex,
  getProjectId,
  hashContent,
  loadIndex,
  saveIndex,
} from "./storage.js";
import type { DocumentChunk, ProjectIndex, VectorizeOptions } from "./types.js";

export async function vectorizeProject(
  options: VectorizeOptions,
): Promise<ProjectIndex> {
  const {
    projectPath,
    memoryFolder,
    forceReindex = false,
    scanAll = false,
    additionalPaths = [],
  } = options;
  const absProjectPath = resolve(projectPath);

  let memoryPath = findMemoryFolder(absProjectPath, memoryFolder);
  if (!memoryPath) {
    if (scanAll) {
      // Self-learning repos may not have a memory/ folder — scan all .md from root
      console.log(
        "No memory folder found, scanning all .md files from project root (--scan-all)",
      );
      memoryPath = absProjectPath;
    } else if (additionalPaths.length > 0) {
      // No project memory folder, but local storage has files — use that as primary
      const validAdditional = additionalPaths.find((p) => existsSync(p));
      if (validAdditional) {
        console.log("No project memory folder found, using local storage as primary source");
        memoryPath = validAdditional;
      } else {
        throw new Error(
          "No memory folder found in " +
            absProjectPath +
            ". Expected '.project-brain/memory/', 'memory/' or 'docs/memory/'",
        );
      }
    } else {
      throw new Error(
        "No memory folder found in " +
          absProjectPath +
          ". Expected '.project-brain/memory/', 'memory/' or 'docs/memory/'",
      );
    }
  }

  console.log("Found memory folder: " + memoryPath);

  const projectId = getProjectId(absProjectPath);
  let existingIndex = forceReindex ? null : loadIndex(projectId);

  // If local index is missing, try to restore from cloud
  if (!existingIndex && !forceReindex) {
    const restored = await restoreFromCloud(projectId);
    if (restored) {
      existingIndex = loadIndex(projectId);
      if (existingIndex) {
        console.log("Restored index from cloud backup");
      }
    }
  }

  // Initialize history tracker
  const history = new MemoryHistory(projectId);
  history.load();

  // Detect embedding type change
  if (existingIndex && !forceReindex) {
    // Match priority from embeddings.ts: Remote > TF-IDF
    const hasRemote = checkRemoteProvider();
    const currentType = hasRemote ? "remote" : "tfidf";
    const indexType = existingIndex.embeddingType || "unknown";
    // Normalize legacy types for comparison
    const normalizedIndexType = (indexType === "openai" || indexType === "cloudflare") ? "remote" : indexType;
    if (normalizedIndexType !== "unknown" && normalizedIndexType !== currentType) {
      console.log(
        "  Embedding type changed (" +
          indexType +
          " -> " +
          currentType +
          "). Forcing full reindex.",
      );
      // Backup existing index before reindex (safety net)
      backupIndex(projectId);
      history.recordUpdate(
        "embeddings",
        "Embedding provider changed from " + indexType + " to " + currentType,
      );
      existingIndex = null;
    }
  }

  const files = await glob("**/*.md", {
    cwd: memoryPath,
    absolute: true,
    nodir: true,
  });

  // Include files from additional paths (e.g., local storage memory dir)
  for (const addPath of additionalPaths) {
    if (existsSync(addPath)) {
      const addFiles = await glob("**/*.md", {
        cwd: addPath,
        absolute: true,
        nodir: true,
      });
      // Only add files not already in the list (avoid duplicates)
      const existingSet = new Set(files);
      for (const f of addFiles) {
        if (!existingSet.has(f)) {
          files.push(f);
        }
      }
    }
  }

  console.log("Found " + files.length + " markdown files");

  const currentHashes: Record<string, string> = {};
  const filesToProcess: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const hash = hashContent(content);
    currentHashes[file] = hash;

    if (
      !existingIndex?.fileHashes[file] ||
      existingIndex.fileHashes[file] !== hash
    ) {
      filesToProcess.push(file);
    }
  }

  const deletedFiles = existingIndex
    ? Object.keys(existingIndex.fileHashes).filter((f) => !currentHashes[f])
    : [];

  console.log(
    filesToProcess.length +
      " files to update, " +
      deletedFiles.length +
      " deleted",
  );

  // Track file changes in history
  for (const file of filesToProcess) {
    const relativePath = file.replace(absProjectPath, "").replace(/\\/g, "/");
    const isNew = !existingIndex?.fileHashes[file];
    if (isNew) {
      history.recordAdd(relativePath, "New file indexed: " + relativePath, {
        sourceFile: file,
      });
    } else {
      history.recordUpdate(
        relativePath,
        "File updated: " + relativePath,
        existingIndex?.fileHashes[file],
        currentHashes[file],
        { sourceFile: file },
      );
    }
  }

  for (const file of deletedFiles) {
    const relativePath = file.replace(absProjectPath, "").replace(/\\/g, "/");
    history.recordDelete(relativePath, "File removed: " + relativePath, {
      sourceFile: file,
    });
  }

  let chunks: DocumentChunk[] = existingIndex?.chunks || [];
  if (deletedFiles.length > 0) {
    chunks = chunks.filter((c) => !deletedFiles.includes(c.filePath));
  }
  if (filesToProcess.length > 0) {
    chunks = chunks.filter((c) => !filesToProcess.includes(c.filePath));
  }

  let vocabulary = existingIndex?.vocabulary;
  let embeddingType: "remote" | "tfidf" | undefined =
    existingIndex?.embeddingType === "openai" || existingIndex?.embeddingType === "cloudflare"
      ? "remote"
      : existingIndex?.embeddingType as "remote" | "tfidf" | undefined;

  if (filesToProcess.length > 0) {
    const newChunks: ChunkWithoutEmbedding[] = [];

    for (const file of filesToProcess) {
      console.log("  Processing: " + file);
      try {
        const fileChunks = chunkDocument({
          filePath: file,
          projectPath: absProjectPath,
          projectId,
        });
        newChunks.push(...fileChunks);
      } catch (err) {
        console.warn(`  ⚠ Skipping ${file} — parse error: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log("Generated " + newChunks.length + " new chunks");

    const result = await generateEmbeddings(newChunks, vocabulary);
    chunks.push(...result.chunks);
    if (result.vocabulary.length > 0) {
      vocabulary = result.vocabulary;
    }
    embeddingType = result.embeddingType;
  }

  const embeddingDim =
    chunks.length > 0 ? chunks[0].embedding.length : undefined;

  const index: ProjectIndex = {
    projectId,
    projectPath: absProjectPath,
    memoryPath,
    lastUpdated: Date.now(),
    fileHashes: currentHashes,
    chunks,
    vocabulary,
    embeddingType,
    embeddingDimension: embeddingDim,
  };

  saveIndex(index);
  console.log("Index saved with " + chunks.length + " total chunks");

  // Upload to cloud (fire-and-forget)
  scheduleCloudUpload(index);

  // Build relationship graph from chunks
  if (filesToProcess.length > 0 || deletedFiles.length > 0 || forceReindex) {
    try {
      const graphChunks = chunks.map((c) => ({
        content: c.content,
        filePath: c.filePath,
        relativePath: c.relativePath,
      }));
      const gm = buildGraphFromChunks(projectId, graphChunks);
      const gs = gm.getStats();
      history.recordGraphOp(
        "graph_add",
        "knowledge-graph",
        "Graph rebuilt: " + gs.nodes + " nodes, " + gs.edges + " edges",
      );
    } catch (err) {
      console.error("Graph build failed (non-fatal):", err);
    }
  }

  // Save history
  history.save();

  return index;
}

export function findMemoryFolder(
  projectPath: string,
  customFolder?: string,
): string | null {
  if (customFolder) {
    const custom = join(projectPath, customFolder);
    if (existsSync(custom) && statSync(custom).isDirectory()) {
      return custom;
    }
  }

  const candidates = [".project-brain/memory", "memory", "docs/memory", "doc/memory", ".memory"];

  for (const candidate of candidates) {
    const fullPath = join(projectPath, candidate);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      return fullPath;
    }
  }

  return null;
}
