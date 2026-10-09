// ─── Shared types for extension entry point and its extracted modules ────────
import type { AutoVectorizer } from "./auto-vectorizer";
import type { Bootstrapper } from "./bootstrapper";
import type { AgentIdentityManager } from "./agent-identity";
import type { GlobalConfigProvider } from "./global-config-provider";
import type { GlobalKnowledgeManager } from "./global-knowledge";
import type { MCPManager } from "./mcp-manager";
import type { ProjectScanner } from "./scanner";
import type { BrainTreeDataProvider } from "./tree-view";
import type * as vscode from "vscode";

/** Per-folder state for multi-root workspace support */
export interface FolderState {
  bootstrapper: Bootstrapper;
  scanner: ProjectScanner;
  mcpManager: MCPManager;
  autoVectorizer: AutoVectorizer | null;
  identityManager: AgentIdentityManager;
}

/** Getter for per-folder state */
export type GetStateFn = (
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
) => FolderState;

/** Mutable ref container — allows extracted modules to read changing values */
export interface ServiceRef<T> {
  get: () => T | null;
  set: (v: T | null) => void;
}

/** Helper to create a ServiceRef from a getter/setter */
export function createRef<T>(initial: T | null = null): ServiceRef<T> {
  let value: T | null = initial;
  return {
    get: () => value,
    set: (v: T | null) => {
      value = v;
    },
  };
}

/** Shared dependencies for project lifecycle functions */
export interface LifecycleDeps {
  folderStates: Map<string, FolderState>;
  getState: GetStateFn;
  treeDataProvider: BrainTreeDataProvider;
  statusBarItem: vscode.StatusBarItem;
  getSaasClient: () => import("./saas-client").SaaSClient | null;
  getLoginWebview: () => import("./login-webview").LoginWebviewProvider | null;
  getSessionDb: () => import("./session-db").SessionDB | null;
  getGlobalConfig: () => GlobalConfigProvider | null;
  getGlobalKnowledge: () => GlobalKnowledgeManager | null;
  log: (msg: string) => void;
}
