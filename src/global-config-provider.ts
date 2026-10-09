// ─── Global Config Provider ──────────────────────────────────────────────────
// Singleton that manages global (cross-project) identity, soul, user profile,
// and programming preferences. Uses VS Code globalStorageUri for persistence.
// This is the "source of truth" when identityScope = "global".

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type {
  AgentIdentity,
  AgentSoul,
  ProgrammingPrefs,
  UserProfile,
} from "./identity-types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Shape of global-identity.json on disk */
export interface GlobalIdentityData {
  identity: AgentIdentity | null;
  soul: AgentSoul | null;
  user: UserProfile | null;
  programmingPrefs: ProgrammingPrefs | null;
  /** ISO timestamp of last save */
  updatedAt: string;
}

export type IdentityScope = "global" | "project";

// ─── Constants ───────────────────────────────────────────────────────────────

const GLOBAL_IDENTITY_FILE = "global-identity.json";
const GLOBAL_KNOWLEDGE_DIR = "knowledge";

// ─── Provider ────────────────────────────────────────────────────────────────

export class GlobalConfigProvider {
  private storagePath: string;
  private cache: GlobalIdentityData | undefined;
  private log: (msg: string) => void;

  constructor(globalStorageUri: vscode.Uri, log: (msg: string) => void) {
    this.storagePath = globalStorageUri.fsPath;
    this.log = log;
    this.ensureStorageDir();
  }

  // ─── Scope detection ─────────────────────────────────────────────

  /** Returns the configured identity scope (global or project) */
  getScope(): IdentityScope {
    const config = vscode.workspace.getConfiguration("projectBrain");
    return config.get<IdentityScope>("identityScope", "global");
  }

  /** Check if a global identity already exists on disk */
  hasGlobalIdentity(): boolean {
    const filePath = path.join(this.storagePath, GLOBAL_IDENTITY_FILE);
    if (!fs.existsSync(filePath)) return false;
    const data = this.loadData();
    return data.identity !== null;
  }

  // ─── Read operations ─────────────────────────────────────────────

  loadIdentity(): AgentIdentity | null {
    return this.loadData().identity;
  }

  loadSoul(): AgentSoul | null {
    return this.loadData().soul;
  }

  loadUser(): UserProfile | null {
    return this.loadData().user;
  }

  loadProgrammingPrefs(): ProgrammingPrefs | null {
    return this.loadData().programmingPrefs;
  }

  loadAll(): GlobalIdentityData {
    return this.loadData();
  }

  // ─── Write operations ────────────────────────────────────────────

  saveIdentity(identity: AgentIdentity): void {
    const data = this.loadData();
    data.identity = identity;
    this.saveData(data);
    this.log(`[GlobalConfig] Identity saved globally: "${identity.name}"`);
  }

  saveSoul(soul: AgentSoul): void {
    const data = this.loadData();
    data.soul = soul;
    this.saveData(data);
    this.log("[GlobalConfig] Soul saved globally");
  }

  saveUser(user: UserProfile): void {
    const data = this.loadData();
    data.user = user;
    this.saveData(data);
    this.log(`[GlobalConfig] User saved globally: "${user.name}"`);
  }

  saveProgrammingPrefs(prefs: ProgrammingPrefs): void {
    const data = this.loadData();
    data.programmingPrefs = prefs;
    this.saveData(data);
    this.log("[GlobalConfig] Programming preferences saved globally");
  }

  /** Save all fields at once (batch update) */
  saveAll(partial: Partial<GlobalIdentityData>): void {
    const data = this.loadData();
    if (partial.identity !== undefined) data.identity = partial.identity;
    if (partial.soul !== undefined) data.soul = partial.soul;
    if (partial.user !== undefined) data.user = partial.user;
    if (partial.programmingPrefs !== undefined) {
      data.programmingPrefs = partial.programmingPrefs;
    }
    this.saveData(data);
    this.log("[GlobalConfig] Bulk save completed");
  }

  // ─── Knowledge directory ─────────────────────────────────────────

  /** Path where global knowledge files (opinions, learnings, etc.) live */
  getKnowledgePath(): string {
    const knowledgePath = path.join(this.storagePath, GLOBAL_KNOWLEDGE_DIR);
    if (!fs.existsSync(knowledgePath)) {
      fs.mkdirSync(knowledgePath, { recursive: true });
    }
    return knowledgePath;
  }

  /** Get the root global storage path */
  getStoragePath(): string {
    return this.storagePath;
  }

  // ─── Cache invalidation ──────────────────────────────────────────

  invalidateCache(): void {
    this.cache = undefined;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
      this.log(`[GlobalConfig] Storage dir created: ${this.storagePath}`);
    }
  }

  private loadData(): GlobalIdentityData {
    if (this.cache) return this.cache;

    const filePath = path.join(this.storagePath, GLOBAL_IDENTITY_FILE);
    try {
      if (!fs.existsSync(filePath)) {
        this.cache = this.emptyData();
        return this.cache;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GlobalIdentityData>;
      this.cache = {
        identity: parsed.identity ?? null,
        soul: parsed.soul ?? null,
        user: parsed.user ?? null,
        programmingPrefs: parsed.programmingPrefs ?? null,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
      return this.cache;
    } catch (err) {
      this.log(`[GlobalConfig] Failed to load data: ${err}`);
      this.cache = this.emptyData();
      return this.cache;
    }
  }

  private saveData(data: GlobalIdentityData): void {
    this.ensureStorageDir();
    data.updatedAt = new Date().toISOString();
    const filePath = path.join(this.storagePath, GLOBAL_IDENTITY_FILE);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    this.cache = data;
  }

  private emptyData(): GlobalIdentityData {
    return {
      identity: null,
      soul: null,
      user: null,
      programmingPrefs: null,
      updatedAt: new Date().toISOString(),
    };
  }
}
