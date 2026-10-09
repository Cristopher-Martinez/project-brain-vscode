/**
 * Self-Learning Constants — Static data for analysis context building.
 *
 * Extracted from self-learning-context.ts to keep files under 400 lines.
 * Contains: tree limits, skip filters, key file list, agent queries, types.
 *
 * @module self-learning-constants
 */

import type { AnalysisAgentId } from "./self-learning-types";

// ——— Limits ————————————————————————————————————————————————————————————
/** Max depth for recursive file tree */
export const MAX_TREE_DEPTH = 5;
/** Max files to list in structural map */
export const MAX_TREE_FILES = 300;
/** Max chars to read from a key file */
export const MAX_KEY_FILE_CHARS = 3000;
/** Max chars for RAG search results per query */
export const MAX_RAG_CHARS = 4000;
/** Max total context size to avoid blowing context window */
export const MAX_TOTAL_CONTEXT = 30_000;

// ——— Skip Filters ——————————————————————————————————————————————————————
/** Directories to skip when building file tree */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".idea",
  ".vscode",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".output",
]);

/** File patterns to skip */
export const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  ".DS_Store",
  "Thumbs.db",
]);

/** Binary/non-code extensions to skip */
export const SKIP_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".min.js",
  ".min.css",
  ".map",
]);

/** Key files to read for base context */
export const KEY_FILES = [
  "package.json",
  "README.md",
  "README",
  "readme.md",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "build.gradle",
  "pom.xml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
  ".github/workflows/main.yml",
  ".gitlab-ci.yml",
];

// ——— Agent-specific RAG queries ———————————————————————————————————————
export const AGENT_QUERIES: Record<AnalysisAgentId, string[]> = {
  architect: [
    "entry point main index routing",
    "database connection model schema",
    "middleware pipeline request lifecycle",
  ],
  patterns: [
    "factory singleton observer pattern class",
    "error handling try catch custom error",
    "interface abstract base class service",
  ],
  components: [
    "component button modal form layout",
    "hook composable directive util helper",
    "shared service provider context",
  ],
  "business-logic": [
    "validation rules business logic domain",
    "authentication authorization role permission",
    "workflow state machine status transition",
  ],
  infrastructure: [
    "dockerfile docker compose container",
    "CI CD pipeline deploy workflow",
    "eslint prettier config lint",
  ],
  security: [
    "authentication token password hash jwt",
    "cors sanitize injection xss csrf",
    "secret env key api credential",
  ],
  performance: [
    "cache memo lazy loading optimize",
    "database query index bulk batch",
    "bundle import async stream",
  ],
  devops: [
    "health check status monitor",
    "logging metric trace observability",
    "deploy scale replicate backup",
  ],
  cookbook: [
    "setup install configuration getting started",
    "example usage pattern recipe",
    "api endpoint route controller handler",
  ],
  auditor: [
    "todo fixme hack workaround technical debt",
    "test coverage spec assertion",
    "error exception throw catch log",
  ],
};

// ——— Types ————————————————————————————————————————————————————————————
export interface AgentContext {
  structuralMap: string;
  keyFiles: string;
  ragResults: string;
  previousAgents: string;
}

export interface TreeEntry {
  name: string;
  isDir: boolean;
  ext?: string;
}
