import matter from "gray-matter";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { ChunkMetadata } from "./types.js";

// BGE-small-en-v1.5 has 512-token limit (~2048 chars).
// Keep chunks under that to avoid truncation and preserve embedding quality.
const CHUNK_SIZE_PROSE = 1200;
const CHUNK_SIZE_CODE = 1600;
const CHUNK_OVERLAP_PROSE = 150;
const CHUNK_OVERLAP_CODE = 300;

const KEYWORD_PATTERNS = [
  /`([^`]+)`/g,
  /\b(src\/[\w\-\/\.]+)/g,
  /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)/g,
  /\b([a-z]+(?:_[a-z]+)+)\b/g,
];

export interface ChunkOptions {
  filePath: string;
  projectPath: string;
  projectId: string;
}

export interface ChunkWithoutEmbedding {
  id: string;
  filePath: string;
  relativePath: string;
  projectId: string;
  content: string;
  keywords: string[];
  metadata: ChunkMetadata;
}

/** Category inference rules — path-based heuristics + frontmatter override. */
const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /TROUBLESHOOTING|05_/, category: "troubleshooting" },
  { pattern: /LEARNINGS|04_/, category: "learnings" },
  { pattern: /ARCHITECTURE|01_/, category: "architecture" },
  { pattern: /CODE_MAP|02_/, category: "codemap" },
  { pattern: /DEPENDENCIES|03_/, category: "dependencies" },
  { pattern: /SESSION|07_/, category: "session" },
  { pattern: /OPINIONS|14_/, category: "opinions" },
  { pattern: /BOOT\.md$/i, category: "overview" },
  { pattern: /PROJECT_OVERVIEW|00_/, category: "overview" },
  { pattern: /USER_PROFILE|10_/, category: "user" },
  { pattern: /IDENTITY|SOUL/, category: "identity" },
  { pattern: /skills\//, category: "skills" },
];

export function inferCategory(relativePath: string, frontmatter?: Record<string, unknown>): string {
  if (frontmatter?.category && typeof frontmatter.category === "string") {
    return frontmatter.category;
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(relativePath)) return rule.category;
  }
  return "general";
}

export function inferTopic(content: string, section?: string): string | undefined {
  if (section) return section.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  const firstLine = content.split("\n").find(l => l.startsWith("#"));
  if (firstLine) return firstLine.replace(/^#+\s*/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return undefined;
}

function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  for (const pattern of KEYWORD_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const kw = match[1] || match[0];
      if (kw.length > 2 && kw.length < 100) {
        keywords.add(kw.toLowerCase());
      }
    }
  }
  return Array.from(keywords);
}

function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\b(src\/[\w\-\/\.]+\.ts)\b/g,
    /\b(docs\/[\w\-\/\.]+\.md)\b/g,
    /\[(.*?)\]\(([\w\-\/\.]+\.(?:ts|md|json))\)/g,
  ];
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      refs.add(match[2] || match[1] || match[0]);
    }
  }
  return Array.from(refs);
}

function isCodeHeavy(content: string): boolean {
  const codeBlockMatches = content.match(/```[\s\S]*?```/g) || [];
  const codeLength = codeBlockMatches.reduce(
    (sum, block) => sum + block.length,
    0,
  );
  return codeLength > content.length * 0.4;
}

export function chunkDocument(options: ChunkOptions): ChunkWithoutEmbedding[] {
  const { filePath, projectPath, projectId } = options;
  const content = readFileSync(filePath, "utf-8");
  const relativePath = relative(projectPath, filePath);

  const { data: frontmatter, content: body } = matter(content);
  const chunks: ChunkWithoutEmbedding[] = [];
  const sections = splitByHeadersWithHierarchy(body);

  for (const section of sections) {
    const isCode = isCodeHeavy(section.content);
    const chunkSize = isCode ? CHUNK_SIZE_CODE : CHUNK_SIZE_PROSE;
    const overlap = isCode ? CHUNK_OVERLAP_CODE : CHUNK_OVERLAP_PROSE;
    const sectionChunks = splitIntoChunks(section.content, chunkSize, overlap);

    for (let i = 0; i < sectionChunks.length; i++) {
      const chunkContent = sectionChunks[i];
      const contextPrefix =
        section.parentHeaders.length > 0
          ? `[Context: ${section.parentHeaders.join(" > ")}]\n\n`
          : "";
      const enrichedContent = contextPrefix + chunkContent;

      const id = createHash("md5")
        .update(`${filePath}:${section.header}:${i}`)
        .digest("hex")
        .slice(0, 16);

      chunks.push({
        id,
        filePath,
        relativePath,
        projectId,
        content: enrichedContent,
        keywords: extractKeywords(chunkContent),
        metadata: {
          title: frontmatter.title || basename(filePath, ".md"),
          section: section.header || undefined,
          parentHeaders: section.parentHeaders,
          lineStart: section.lineStart + i * Math.floor(chunkSize / 50),
          lineEnd: section.lineStart + (i + 1) * Math.floor(chunkSize / 50),
          modifiedAt: Date.now(),
          tags: frontmatter.tags || [],
          references: extractReferences(chunkContent),
          isCode,
          category: inferCategory(relativePath, frontmatter),
          topic: inferTopic(chunkContent, section.header),
        },
      });
    }
  }

  return chunks;
}

interface Section {
  header: string;
  parentHeaders: string[];
  content: string;
  lineStart: number;
  level: number;
}

function splitByHeadersWithHierarchy(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  const headerStack: { header: string; level: number }[] = [];
  let currentSection: Section = {
    header: "",
    parentHeaders: [],
    content: "",
    lineStart: 0,
    level: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headerMatch) {
      if (currentSection.content.trim()) {
        sections.push(currentSection);
      }

      const level = headerMatch[1].length;
      const header = headerMatch[2];

      while (
        headerStack.length > 0 &&
        headerStack[headerStack.length - 1].level >= level
      ) {
        headerStack.pop();
      }

      const parentHeaders = headerStack.map((h) => h.header);
      headerStack.push({ header, level });

      currentSection = {
        header,
        parentHeaders,
        content: line + "\n",
        lineStart: i,
        level,
      };
    } else {
      currentSection.content += line + "\n";
    }
  }

  if (currentSection.content.trim()) {
    sections.push(currentSection);
  }

  if (sections.length === 0) {
    sections.push({
      header: "",
      parentHeaders: [],
      content,
      lineStart: 0,
      level: 0,
    });
  }

  return sections;
}

function splitIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];

  if (text.length <= chunkSize) {
    return [text.trim()];
  }

  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks: { start: number; end: number }[] = [];
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length });
  }

  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;

    const inCodeBlock = codeBlocks.find(
      (cb) => start < cb.end && end > cb.start,
    );
    if (inCodeBlock) {
      if (end < inCodeBlock.end) {
        end = inCodeBlock.end;
      }
    }

    if (end < text.length && !inCodeBlock) {
      const breakPoints = ["\n\n", "\n", ". ", ", "];
      for (const bp of breakPoints) {
        const lastBreak = text.lastIndexOf(bp, end);
        if (lastBreak > start + chunkSize / 2) {
          end = lastBreak + bp.length;
          break;
        }
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}
