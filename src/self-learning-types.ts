/**
 * Self-Learning Module — Types
 *
 * Shared types for the self-learning feature that allows users to
 * clone, vectorize, and analyze external repositories.
 *
 * @module self-learning-types
 */

// ─── Vectorizer Providers ──────────────────────────────────────────────────

/** Supported local embedding providers */
export type LocalEmbeddingProvider =
  | "ollama"
  | "lmstudio"
  | "llamafile"
  | "custom";

/** Configuration for a local embedding provider */
export interface LocalEmbeddingConfig {
  provider: LocalEmbeddingProvider;
  /** Base URL for the embedding API (e.g., http://localhost:11434/v1) */
  baseUrl: string;
  /** Model name for embeddings (e.g., nomic-embed-text) */
  model: string;
  /** API key if required (most local providers don't need one) */
  apiKey: string;
  /** Whether this provider is currently available */
  available?: boolean;
}

/** Default configs for known providers */
export const DEFAULT_PROVIDER_CONFIGS: Record<
  Exclude<LocalEmbeddingProvider, "custom">,
  Omit<LocalEmbeddingConfig, "available">
> = {
  ollama: {
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    apiKey: "ollama",
  },
  lmstudio: {
    provider: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    apiKey: "lm-studio",
  },
  llamafile: {
    provider: "llamafile",
    baseUrl: "http://localhost:8080/v1",
    model: "embedding",
    apiKey: "llamafile",
  },
};

// ─── Pipeline ──────────────────────────────────────────────────────────────

/** Pipeline phases for progress tracking */
export type PipelinePhase =
  | "cloning"
  | "vectorizing"
  | "analyzing"
  | "done"
  | "error";

/** Result of a vectorization run */
export interface VectorizationResult {
  chunks: number;
  files: number;
  success: boolean;
  error?: string;
}

// ─── Repository Entry ──────────────────────────────────────────────────────

/** Status of a repository in the self-learning pipeline */
export type RepoStatus =
  | "pending"
  | "cloning"
  | "cloned"
  | "vectorizing"
  | "indexed"
  | "analyzing"
  | "analyzed"
  | "error";

/** A repository entry tracked by the self-learning module */
export interface RepoEntry {
  id: number;
  /** Display name (repo name or folder name) */
  name: string;
  /** Original source: GitHub URL or local folder path */
  source: string;
  /** Whether source is a GitHub URL or local path */
  sourceType: "github" | "local";
  /** Local path where the repo is stored (after cloning or as-is) */
  localPath: string;
  /** Current status in the pipeline */
  status: RepoStatus;
  /** Number of chunks generated during vectorization */
  chunkCount: number;
  /** Number of files processed */
  fileCount: number;
  /** Embedding provider used for vectorization */
  embeddingProvider: LocalEmbeddingProvider | null;
  /** Error message if status is 'error' */
  errorMessage: string | null;
  /** LLM model used in the last analysis (persisted for restore) */
  lastAnalysisModel: string | null;
  /** Target project description used in the last analysis */
  lastAnalysisDescription: string | null;
  /** ISO timestamp of when this entry was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

// ─── Analysis Agent Types ──────────────────────────────────────────────────

/** IDs for the 10 analysis agents */
export type AnalysisAgentId =
  | "architect"
  | "patterns"
  | "components"
  | "business-logic"
  | "infrastructure"
  | "security"
  | "performance"
  | "devops"
  | "cookbook"
  | "auditor";

/** Status of an individual analysis agent */
export type AgentAnalysisStatus = "pending" | "running" | "completed" | "error";

/** Metadata for an analysis agent */
export interface AnalysisAgentMeta {
  id: AnalysisAgentId;
  name: string;
  outputFile: string;
  description: string;
}

/** Result of a single agent's analysis */
export interface AgentAnalysisResult {
  repoId: number;
  agentId: AnalysisAgentId;
  status: AgentAnalysisStatus;
  /** Path to the generated analysis file */
  outputPath: string | null;
  /** Error message if failed */
  error: string | null;
  /** Duration in ms */
  durationMs: number;
  /** ISO timestamp */
  completedAt: string | null;
}

/** Full analysis session for a repo */
export interface AnalysisSession {
  repoId: number;
  /** LLM model used for analysis */
  llmModel: string;
  /** User's target project description */
  targetProjectDescription: string;
  /** Status of each agent */
  agents: AgentAnalysisResult[];
  /** Overall status */
  status: "pending" | "running" | "completed" | "error";
  /** ISO timestamp */
  startedAt: string;
  completedAt: string | null;
}

// ─── Message types (webview ↔ extension) ────────────────────────────────────

/** Messages from webview → extension */
export type SelfLearningMessage =
  | { type: "sl:addRepo"; source: string }
  | { type: "sl:removeRepo"; repoId: number }
  | { type: "sl:vectorizeRepo"; repoId: number }
  | {
      type: "sl:analyzeRepo";
      repoId: number;
      llmModel: string;
      targetDescription: string;
    }
  | { type: "sl:getRepos" }
  | { type: "sl:getConfig" }
  | { type: "sl:saveConfig"; config: LocalEmbeddingConfig }
  | { type: "sl:checkProvider"; provider: LocalEmbeddingProvider }
  | { type: "sl:cancelOperation"; repoId: number }
  | {
      type: "sl:analyzeSingleAgent";
      repoId: number;
      llmModel: string;
      targetDescription: string;
      agentIds: AnalysisAgentId[];
    }
  | { type: "sl:openAnalysis"; repoId: number; agentId: AnalysisAgentId }
  | { type: "sl:openTemplate" };

/** The 10 analysis agents metadata */
export const ANALYSIS_AGENTS: AnalysisAgentMeta[] = [
  {
    id: "architect",
    name: "Agente Arquitecto",
    outputFile: "01_arquitectura.md",
    description:
      "Analiza arquitectura general, capas, flujo de datos, escalabilidad",
  },
  {
    id: "patterns",
    name: "Agente de Patrones y Calidad",
    outputFile: "02_patrones_y_calidad.md",
    description: "Detecta patrones de diseño, anti-patrones, SOLID, DRY, KISS",
  },
  {
    id: "components",
    name: "Agente de Componentes Reutilizables",
    outputFile: "03_componentes_reutilizables.md",
    description: "Extrae componentes, servicios, hooks, helpers reutilizables",
  },
  {
    id: "business-logic",
    name: "Agente de Lógica de Negocio",
    outputFile: "04_logica_negocio.md",
    description:
      "Identifica reglas de negocio, validaciones, flujos, casos borde",
  },
  {
    id: "infrastructure",
    name: "Agente de Infraestructura",
    outputFile: "05_infraestructura.md",
    description: "Analiza Docker, CI/CD, ESLint, tsconfig, env management",
  },
  {
    id: "security",
    name: "Agente de Seguridad",
    outputFile: "06_seguridad.md",
    description: "Evalúa auth, sanitización, XSS, CSRF, SQL injection",
  },
  {
    id: "performance",
    name: "Agente de Performance",
    outputFile: "07_performance.md",
    description: "Analiza lazy loading, caching, N+1, bundle size, memoización",
  },
  {
    id: "devops",
    name: "Agente DevOps y Escalabilidad",
    outputFile: "08_devops_y_escalabilidad.md",
    description: "Evalúa producción readiness, observabilidad, scaling",
  },
  {
    id: "cookbook",
    name: "Agente Cookbook",
    outputFile: "09_cookbook.md",
    description: "Convierte hallazgos en recetas accionables con código",
  },
  {
    id: "auditor",
    name: "Agente Auditor Final",
    outputFile: "10_auditoria_final.md",
    description: "Consolida todo, prioriza, detecta contradicciones, roadmap",
  },
];
