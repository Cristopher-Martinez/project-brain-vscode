/**
 * Dual Opinion Bank — Local + global opinion management with bidirectional sync.
 *
 * Extends the existing OpinionBank with cloud connectivity:
 * - Classifies opinions as local-only or global (using scope field)
 * - Syncs global opinions to/from the SaaS backend
 * - Resolves conflicts (higher confidence wins)
 * - Maintains local autonomy — works fully offline
 *
 * Scope classification:
 * - "project"       → stays local, specific to this workspace
 * - "stack_specific" → synced, relevant to same tech stack
 * - "cross_project"  → synced, general development knowledge
 * - "universal"      → synced, applies everywhere
 */

import type { OfflineManager } from "./offline-manager";
import type { Opinion, OpinionBank, OpinionDomain } from "./opinion-bank";
import type {
  MemoryResult,
  SaaSClient,
  SearchScope,
  SyncedOpinion,
  SyncResult,
} from "./saas-client";
import {
  UNIVERSAL_REGEXPS,
  STACK_REGEXPS,
  type DualOpinionBankOptions,
  type SyncSummary,
} from "./dual-opinion-bank-types";

export type { DualOpinion, SyncSummary, DualOpinionBankOptions } from "./dual-opinion-bank-types";
// ─── DualOpinionBank ────────────────────────────────────────────────────────

export class DualOpinionBank {
  private opinionBank: OpinionBank;
  private saasClient?: SaaSClient;
  private offlineManager?: OfflineManager;
  private log: (msg: string) => void;
  private scopeMap: Map<string, SearchScope> = new Map();
  private syncVersionMap: Map<string, number> = new Map();
  private cloudIdMap: Map<string, string> = new Map();
  private pendingSyncSet: Set<string> = new Set();
  private lastSyncVersion = 0;
  private _isSyncing = false;

  /** Whether a sync operation is currently in progress */
  get isSyncing(): boolean { return this._isSyncing; }

  constructor(options: DualOpinionBankOptions) {
    this.opinionBank = options.opinionBank;
    this.saasClient = options.saasClient;
    this.offlineManager = options.offlineManager;
    this.log = options.log;
  }

  // ─── Core API ─────────────────────────────────────────────────────

  /**
   * Add an opinion with automatic scope classification.
   * Global-scoped opinions are marked for sync.
   */
  addOpinion(
    statement: string,
    confidence: number,
    domain: OpinionDomain,
    evidence?: string,
    scopeOverride?: SearchScope,
  ): Opinion {
    const opinion = this.opinionBank.addOpinion(
      statement,
      confidence,
      domain,
      evidence,
    );

    // Classify scope
    const scope = scopeOverride ?? this.classifyScope(statement, domain);
    this.scopeMap.set(opinion.id, scope);
    this.syncVersionMap.set(opinion.id, 0);

    // Mark for sync if non-local
    if (scope !== "project") {
      this.pendingSyncSet.add(opinion.id);
    }

    return opinion;
  }

  /** Get the scope of an opinion. */
  getScope(opinionId: string): SearchScope {
    return this.scopeMap.get(opinionId) ?? "project";
  }

  /** Set the scope of an opinion manually. */
  setScope(opinionId: string, scope: SearchScope): void {
    this.scopeMap.set(opinionId, scope);
    if (scope !== "project") {
      this.pendingSyncSet.add(opinionId);
    } else {
      this.pendingSyncSet.delete(opinionId);
    }
  }

  /** Get opinions filtered by scope. */
  getByScope(scope: SearchScope): Opinion[] {
    return this.opinionBank
      .getOpinions()
      .filter((o) => this.getScope(o.id) === scope);
  }

  /** Get all opinions that need syncing. */
  getPendingSync(): Opinion[] {
    return this.opinionBank
      .getOpinions()
      .filter((o) => this.pendingSyncSet.has(o.id));
  }

  /** Get a status snapshot. */
  get status(): {
    total: number;
    local: number;
    global: number;
    pendingSync: number;
    lastSyncVersion: number;
  } {
    const total = this.opinionBank.count;
    const globalCount = Array.from(this.scopeMap.values()).filter(
      (s) => s !== "project",
    ).length;
    return {
      total,
      local: total - globalCount,
      global: globalCount,
      pendingSync: this.pendingSyncSet.size,
      lastSyncVersion: this.lastSyncVersion,
    };
  }

  // ─── Sync ─────────────────────────────────────────────────────────

  /** Bidirectional sync: push local globals → cloud, pull cloud → local. */
  async sync(): Promise<SyncSummary> {
    if (!this.saasClient) {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: ["Not connected"] };
    }

    if (this._isSyncing) {
      return {
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        errors: ["Sync already in progress"],
      };
    }

    this._isSyncing = true;
    const errors: string[] = [];

    try {
      // Prepare local opinions for push
      const toPush = this.getPendingSync().map((o) => this.toSyncedOpinion(o));

      let result: SyncResult;

      try {
        result = await this.saasClient.syncOpinions(
          toPush,
          this.lastSyncVersion,
        );
      } catch (e) {
        // If offline, queue for later
        if (this.offlineManager && toPush.length > 0) {
          await this.offlineManager.enqueue({
            type: "sync_opinions",
            payload: {
              opinions: toPush,
              lastSyncVersion: this.lastSyncVersion,
            },
          });
          this.log(
            `[DualOpinionBank] Queued ${toPush.length} opinions for offline sync`,
          );
        }
        return {
          pushed: 0,
          pulled: 0,
          conflicts: 0,
          errors: [`Sync failed: ${e}`],
        };
      }

      // Process pushed — clear pending flags
      for (const opinion of toPush) {
        this.pendingSyncSet.delete(opinion.id);
      }

      // Process pulled — merge into local bank
      let pulled = 0;
      for (const remote of result.pulled) {
        this.mergeRemoteOpinion(remote);
        pulled++;
      }

      // Process conflicts — higher confidence wins
      for (const conflict of result.conflicts) {
        this.resolveConflict(conflict.opinionId);
      }

      // Update sync version
      this.lastSyncVersion = result.syncVersion;

      const summary: SyncSummary = {
        pushed: result.pushed,
        pulled,
        conflicts: result.conflicts.length,
        errors,
      };

      this.log(
        `[DualOpinionBank] Sync: pushed=${summary.pushed}, pulled=${summary.pulled}, conflicts=${summary.conflicts}`,
      );
      return summary;
    } finally {
      this._isSyncing = false;
    }
  }

  /** Search the global memory via the SaaS backend. */
  async searchGlobal(
    query: string,
    scope?: SearchScope,
    limit?: number,
  ): Promise<MemoryResult[]> {
    if (!this.saasClient) {
      // Fallback to local search
      const localResults = this.opinionBank.search(query);
      return localResults.slice(0, limit ?? 10).map((o) => ({
        id: o.id,
        statement: o.statement,
        confidence: o.confidence,
        scope: this.getScope(o.id),
      }));
    }

    try {
      return await this.saasClient.searchGlobalMemory(query, scope, limit);
    } catch {
      // Fallback to local
      const localResults = this.opinionBank.search(query);
      return localResults.slice(0, limit ?? 10).map((o) => ({
        id: o.id,
        statement: o.statement,
        confidence: o.confidence,
        scope: this.getScope(o.id),
      }));
    }
  }

  /** Force save the underlying OpinionBank. */
  save(): void {
    this.opinionBank.save();
  }

  // ─── Scope Classification ─────────────────────────────────────────

  /** Automatically classify an opinion's scope based on content and domain. */
  classifyScope(statement: string, domain: OpinionDomain): SearchScope {
    const lower = statement.toLowerCase();

    // Domain-based classification
    if (domain === "workflow" || domain === "preferences") {
      // Workflow/preferences tend to be universal
      if (UNIVERSAL_REGEXPS.some((re) => re.test(lower))) {
        return "universal";
      }
      return "cross_project";
    }

    // Check for universal indicators (word boundary to avoid 'never' matching 'whenever')
    if (UNIVERSAL_REGEXPS.some((re) => re.test(lower))) {
      return "universal";
    }

    // Check for stack-specific indicators (word boundary to avoid 'go' matching 'hexagonal')
    if (STACK_REGEXPS.some((re) => re.test(lower))) {
      return "stack_specific";
    }

    // Architecture and patterns insights often transfer across projects
    if (domain === "architecture" || domain === "patterns") {
      return "cross_project";
    }

    // Debugging insights are often project-specific
    if (domain === "debugging") {
      return "project";
    }

    // Tools insights are usually universal
    if (domain === "tools") {
      return "cross_project";
    }

    // Default: project-local
    return "project";
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private toSyncedOpinion(opinion: Opinion): SyncedOpinion {
    let cloudId = this.cloudIdMap.get(opinion.id);
    if (!cloudId) {
      cloudId = crypto.randomUUID();
      this.cloudIdMap.set(opinion.id, cloudId);
    }
    return {
      id: cloudId,
      statement: opinion.statement,
      category: opinion.domain,
      confidence: opinion.confidence,
      scope: this.getScope(opinion.id),
      syncVersion: this.syncVersionMap.get(opinion.id) ?? 0,
      updatedAt: opinion.lastUpdated
        ? new Date(opinion.lastUpdated).toISOString()
        : new Date().toISOString(),
    };
  }

  private mergeRemoteOpinion(remote: SyncedOpinion): void {
    // Check if we already have this locally
    const existing = this.opinionBank.search(remote.statement);
    const match = existing.find(
      (o) => this.wordOverlap(o.statement, remote.statement) > 0.6,
    );

    if (match) {
      // Conflict resolution — higher confidence wins
      if (remote.confidence > match.confidence) {
        // Remote wins: update local
        this.opinionBank.reinforce(
          match.id,
          `Synced from cloud (c=${remote.confidence})`,
        );
      }
      this.cloudIdMap.set(match.id, remote.id);
      this.syncVersionMap.set(match.id, remote.syncVersion);
      this.scopeMap.set(match.id, remote.scope);
    } else {
      // New opinion from cloud
      const opinion = this.opinionBank.addOpinion(
        remote.statement,
        remote.confidence,
        remote.category as OpinionDomain,
        "Pulled from global memory",
      );
      this.cloudIdMap.set(opinion.id, remote.id);
      this.syncVersionMap.set(opinion.id, remote.syncVersion);
      this.scopeMap.set(opinion.id, remote.scope);
    }
  }

  private resolveConflict(opinionId: string): void {
    // For now, we keep both versions — cloud version merged above
    // The server decides which wins (higher confidence, newer timestamp)
    this.log(`[DualOpinionBank] Conflict resolved for opinion ${opinionId}`);
  }

  /** Calculate word overlap ratio between two statements. */
  private wordOverlap(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    return overlap / Math.min(wordsA.size, wordsB.size);
  }
}
