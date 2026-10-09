// ─── Self-Learning types (webview-side mirrors of extension types) ──────────

/** Supported local embedding providers */
export type SLEmbeddingProvider =
  | "ollama"
  | "lmstudio"
  | "llamafile"
  | "custom";

/** Configuration for a local embedding provider */
export interface SLEmbeddingConfig {
  provider: SLEmbeddingProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  available?: boolean;
}

/** Status pipeline for a repo */
export type SLRepoStatus =
  | "pending"
  | "cloning"
  | "cloned"
  | "vectorizing"
  | "indexed"
  | "analyzing"
  | "analyzed"
  | "error";

/** A tracked repository */
export interface SLRepoEntry {
  id: number;
  name: string;
  source: string;
  sourceType: "github" | "local";
  localPath: string;
  status: SLRepoStatus;
  chunkCount: number;
  fileCount: number;
  embeddingProvider: SLEmbeddingProvider | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Analysis agent IDs */
export type SLAgentId =
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

/** Status of an individual agent */
export type SLAgentStatus = "pending" | "running" | "completed" | "error";

/** Result of a single agent's analysis */
export interface SLAgentResult {
  repoId: number;
  agentId: SLAgentId;
  status: SLAgentStatus;
  outputPath: string | null;
  error: string | null;
  durationMs: number;
  completedAt: string | null;
}

/** Full analysis session for a repo */
export interface SLAnalysisSession {
  repoId: number;
  llmModel: string;
  targetProjectDescription: string;
  agents: SLAgentResult[];
  status: "pending" | "running" | "completed" | "error";
  startedAt: string;
  completedAt: string | null;
}

/** Agent metadata for display */
export interface SLAgentMeta {
  id: SLAgentId;
  name: string;
  outputFile: string;
  description: string;
}

/** The 10 analysis agents metadata */
export const SL_AGENTS: SLAgentMeta[] = [
  {
    id: "architect",
    name: "Arquitecto",
    outputFile: "01_arquitectura.md",
    description: "Arquitectura general, capas, flujo de datos",
  },
  {
    id: "patterns",
    name: "Patrones",
    outputFile: "02_patrones_y_calidad.md",
    description: "Patrones de diseño, SOLID, DRY",
  },
  {
    id: "components",
    name: "Componentes",
    outputFile: "03_componentes_reutilizables.md",
    description: "Componentes y helpers reutilizables",
  },
  {
    id: "business-logic",
    name: "Negocio",
    outputFile: "04_logica_negocio.md",
    description: "Reglas de negocio y validaciones",
  },
  {
    id: "infrastructure",
    name: "Infra",
    outputFile: "05_infraestructura.md",
    description: "Docker, CI/CD, config",
  },
  {
    id: "security",
    name: "Seguridad",
    outputFile: "06_seguridad.md",
    description: "Auth, sanitización, XSS",
  },
  {
    id: "performance",
    name: "Performance",
    outputFile: "07_performance.md",
    description: "Lazy loading, caching, N+1",
  },
  {
    id: "devops",
    name: "DevOps",
    outputFile: "08_devops_y_escalabilidad.md",
    description: "Producción readiness, observabilidad",
  },
  {
    id: "cookbook",
    name: "Cookbook",
    outputFile: "09_cookbook.md",
    description: "Recetas accionables con código",
  },
  {
    id: "auditor",
    name: "Auditor",
    outputFile: "10_auditoria_final.md",
    description: "Consolidación, priorización, roadmap",
  },
];

/** Default provider configs */
export const SL_DEFAULT_CONFIGS: Record<
  Exclude<SLEmbeddingProvider, "custom">,
  Omit<SLEmbeddingConfig, "available">
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

/** Pipeline phase for progress tracking */
export type SLPipelinePhase =
  | "cloning"
  | "vectorizing"
  | "analyzing"
  | "done"
  | "error";

/** Real-time progress info for a repo pipeline */
export interface SLProgressInfo {
  repoId: number;
  phase: SLPipelinePhase;
  detail: string;
  percent?: number;
  /** Epoch ms when this progress started (first dispatch for this repo) */
  startedAt?: number;
  /** Epoch ms of last update received */
  updatedAt?: number;
}
