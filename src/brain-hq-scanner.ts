/**
 * Brain HQ — Memory & docs directory scanners.
 * Extracted from brain-hq-helpers.ts to keep files under 400 lines.
 */

import * as fsp from "fs/promises";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryFileInfo {
  name: string;
  relativePath: string;
  sizeKb: number;
  modifiedAt: string;
  createdAt: string;
  isDir: boolean;
  tags: string[];
  category: string;
  excerpt: string;
}

// ─── Category Detection ─────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /^skills\//i, category: "skill" },
  { pattern: /PLAN|STRATEGY|IMPLEMENTATION/i, category: "plan" },
  { pattern: /LEARNING|04_/i, category: "learning" },
  { pattern: /TROUBLESHOOT|05_/i, category: "troubleshooting" },
  { pattern: /ARCHITECT|AUDIT|SECURITY/i, category: "architecture" },
  { pattern: /SESSION|HANDOFF|07_/i, category: "session" },
  { pattern: /CODE_INTEL|DEPENDENCY|01_|02_|03_/i, category: "reference" },
];

function detectCategory(relPath: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(relPath)) return rule.category;
  }
  return "other";
}

// ─── Metadata Extraction ────────────────────────────────────────────────────

function extractMetadata(content: string): { tags: string[]; excerpt: string } {
  const tags: string[] = [];
  let excerpt = "";

  // Try YAML frontmatter: ---\n...\n---
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const tagsLine = fm.split("\n").find((l) => l.startsWith("tags:"));
    if (tagsLine) {
      const inline = tagsLine.replace("tags:", "").trim();
      if (inline) {
        tags.push(
          ...inline
            .replace(/[[\]]/g, "")
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean),
        );
      }
    }
  }

  // Try **Tags**: keyword1, keyword2 pattern
  const tagsBodyMatch = content.match(/\*\*Tags?\*\*:\s*(.+)/i);
  if (tagsBodyMatch) {
    tags.push(
      ...tagsBodyMatch[1]
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !tags.includes(t)),
    );
  }

  // Extract excerpt: first non-empty, non-heading, non-frontmatter line
  const bodyStart = fmMatch ? content.indexOf("---", 4) + 4 : 0;
  const bodyLines = content.slice(bodyStart).split("\n");
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      excerpt = trimmed.slice(0, 120);
      break;
    }
  }

  return { tags, excerpt };
}

// ─── Shared File Scanner ────────────────────────────────────────────────────

async function scanFileEntry(
  absPath: string,
  relPath: string,
): Promise<MemoryFileInfo> {
  const stat = await fsp.stat(absPath);
  let tags: string[] = [];
  let excerpt = "";
  try {
    const head = await fsp.readFile(absPath, "utf-8");
    const meta = extractMetadata(head.slice(0, 2048));
    tags = meta.tags;
    excerpt = meta.excerpt;
  } catch { /* ignore */ }
  return {
    name: path.basename(absPath),
    relativePath: relPath,
    sizeKb: Math.round(stat.size / 1024),
    modifiedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    isDir: false,
    tags,
    category: detectCategory(relPath),
    excerpt,
  };
}

// ─── Memory Dir Scanner (async, recursive) ──────────────────────────────────

export async function scanMemoryDir(
  absDir: string,
  relDir: string,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = [];
  try {
    const exists = await fsp.access(absDir).then(
      () => true,
      () => false,
    );
    if (!exists) return result;
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          relativePath: relPath,
          sizeKb: 0,
          modifiedAt: "",
          createdAt: "",
          isDir: true,
          tags: [],
          category: detectCategory(relPath),
          excerpt: "",
        });
        result.push(...(await scanMemoryDir(absPath, relPath)));
      } else if (entry.name.endsWith(".md")) {
        result.push(await scanFileEntry(absPath, relPath));
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

// ─── Docs Parent Dir Scanner ────────────────────────────────────────────────

/**
 * Scans the parent docs/ directory for .md files NOT inside memory/.
 * Returns MemoryFileInfo[] with relativePaths prefixed by "../" so that
 * memoryPath + "/" + relativePath resolves to the docs/ file.
 */
export async function scanDocsRootDir(
  docsDir: string,
  memoryDirName: string,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = [];
  try {
    const exists = await fsp.access(docsDir).then(
      () => true,
      () => false,
    );
    if (!exists) return result;
    const entries = await fsp.readdir(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === memoryDirName) continue;
      const absPath = path.join(docsDir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await scanDocsSubDir(absPath, `../${entry.name}`);
        if (subFiles.length > 0) {
          result.push({
            name: entry.name,
            relativePath: `../${entry.name}`,
            sizeKb: 0,
            modifiedAt: "",
            createdAt: "",
            isDir: true,
            tags: [],
            category: detectCategory(entry.name),
            excerpt: "",
          });
          result.push(...subFiles);
        }
      } else if (entry.name.endsWith(".md")) {
        result.push(await scanFileEntry(absPath, `../${entry.name}`));
      }
    }
  } catch { /* ignore */ }
  return result;
}

/** Scans a subdirectory of docs/ for .md files (non-recursive). */
async function scanDocsSubDir(
  absDir: string,
  relPrefix: string,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = [];
  try {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const absPath = path.join(absDir, entry.name);
      result.push(await scanFileEntry(absPath, `${relPrefix}/${entry.name}`));
    }
  } catch { /* ignore */ }
  return result;
}
