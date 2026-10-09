export interface ChunkMetadata {
  title?: string;
  section?: string;
  parentHeaders?: string[];
  lineStart: number;
  lineEnd: number;
  modifiedAt: number;
  tags?: string[];
  references?: string[];
  isCode?: boolean;
  category?: string;
  topic?: string;
}

export interface DocumentChunk {
  id: string;
  filePath: string;
  relativePath: string;
  projectId: string;
  content: string;
  keywords: string[];
  metadata: ChunkMetadata;
  embedding: number[];
}

export interface ProjectIndex {
  projectId: string;
  projectPath: string;
  memoryPath: string;
  lastUpdated: number;
  fileHashes: Record<string, string>;
  chunks: DocumentChunk[];
  vocabulary?: string[];
  embeddingType?: "remote" | "tfidf" | "openai" | "cloudflare";
  embeddingDimension?: number;
}

export interface SearchResult {
  chunk: DocumentChunk;
  score: number;
  semanticScore?: number;
  keywordScore?: number;
}

export interface VectorizeOptions {
  projectPath: string;
  memoryFolder?: string;
  forceReindex?: boolean;
  /** When true, scan all .md files from project root if no memory folder found */
  scanAll?: boolean;
  /** Additional directories to include in indexing (e.g., local storage memory dir) */
  additionalPaths?: string[];
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  hybridWeight?: number;
  fileFilter?: string;
  category?: string;
  topic?: string;
}
