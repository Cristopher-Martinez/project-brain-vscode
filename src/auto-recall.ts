/**
 * Auto-Recall — Inject relevant context without ceremony.
 *
 * Inspired by OpenClaw's memory-lancedb auto-recall hook.
 * Instead of enforcement blocks (awaken → search → heartbeat),
 * this module automatically prepends relevant context to tool
 * responses on the FIRST call of a session:
 *   - Boot context (from BOOT.md)
 *   - Relevant opinions (from OpinionBank)
 *   - Knowledge summary (from sessions/knowledge-summary.txt or memory files)
 *   - Available skills catalog
 *   - Recent session history
 *
 * The agent receives context automatically — no ceremony needed.
 * Data sources extracted to auto-recall-sources.ts for modularity.
 */

import * as path from "path";
import {
  assembleContext,
  readBootContext,
  readVaultSummary,
  readKnowledgeSummary,
  readRecentSessionsAsync,
  readRecentSessionsFromFs,
  readSkillCatalog,
  type BootCache,
  type ContextSection,
  type SessionDBLike,
  type SkillManagerLike,
} from "./auto-recall-sources";
import { readDiary } from "./agent-diary";
import { OpinionBank } from "./opinion-bank";
import type { SessionDB } from "./session-db";
import { logWarn } from "./logger";

// ─── AutoRecall ─────────────────────────────────────────────────────────────

export class AutoRecall {
  private hasInjectedThisSession = false;
  private bootCache: BootCache = { content: null, time: 0 };
  private skillManagerRef?: { get: () => SkillManagerLike | null };
  private adminDbRef?: { get: () => any };
  private sessionDbRef?: { get: () => SessionDB | null };
  private currentMode: string | null = null;

  constructor(
    private memoryPath: string,
    private opinionBank: OpinionBank,
    private log: (msg: string) => void,
  ) {}

  /** Set SkillManager reference for enriched skill catalog (includes remote skills). */
  setSkillManagerRef(ref: { get: () => any }): void {
    this.skillManagerRef = ref;
  }

  /** Set AdminDB reference for skill usage logging. */
  setAdminDbRef(ref: { get: () => any }): void {
    this.adminDbRef = ref;
  }

  /** Set SessionDB reference for SQLite-backed session queries. */
  setSessionDbRef(ref: { get: () => SessionDB | null }): void {
    this.sessionDbRef = ref;
  }

  /** Set current agent mode for diary injection. */
  setCurrentAgentMode(mode: string | null): void {
    this.currentMode = mode;
  }

  /**
   * Get context to prepend to the first tool response of the session.
   * Returns empty string on subsequent calls (context only injected once).
   *
   * @param forceRefresh - If true, re-inject even if already done this session.
   */
  getAutoRecallContext(forceRefresh = false): string {
    if (this.hasInjectedThisSession && !forceRefresh) return "";

    const sections = this.gatherSections(
      readRecentSessionsFromFs(this.memoryPath),
    );
    this.hasInjectedThisSession = true;

    if (sections.length === 0) return "";
    this.logInjection(sections);
    return assembleContext(sections);
  }

  /**
   * Async variant: can pull recent sessions from SessionDB (preferred)
   * rather than filesystem only. Used by async call sites (e.g., LM tools).
   */
  async getAutoRecallContextAsync(forceRefresh = false): Promise<string> {
    if (this.hasInjectedThisSession && !forceRefresh) return "";

    const sessionHistory = await readRecentSessionsAsync(
      this.memoryPath,
      this.sessionDbRef?.get() as SessionDBLike | null,
    );
    const sections = this.gatherSections(sessionHistory);
    this.hasInjectedThisSession = true;

    if (sections.length === 0) return "";
    this.logInjection(sections);
    return assembleContext(sections);
  }

  /**
   * Get relevant opinions for a specific query.
   * Can be called anytime — doesn't affect the once-per-session injection.
   */
  getRelevantOpinions(query: string, maxResults = 5): string {
    const results = this.opinionBank.search(query);
    if (results.length === 0) return "";

    return results
      .slice(0, maxResults)
      .map(
        (o) => `• [${o.domain}] (c=${o.confidence.toFixed(2)}) ${o.statement}`,
      )
      .join("\n");
  }

  /** Reset session state — call when a new session starts. */
  resetSession(): void {
    this.hasInjectedThisSession = false;
    this.bootCache = { content: null, time: 0 };
  }

  /** Check if auto-recall has fired this session. */
  get hasInjected(): boolean {
    return this.hasInjectedThisSession;
  }

  // ─── Private ──────────────────────────────────────────────────────

  /**
   * Gather all context sections. Shared between sync and async variants.
   * The only difference is how sessionHistory is obtained.
   */
  private gatherSections(sessionHistory: string | null): ContextSection[] {
    const sections: ContextSection[] = [];

    // 1. Boot context (compact project state)
    const bootResult = readBootContext(this.memoryPath, this.bootCache);
    this.bootCache = bootResult.cache;
    if (bootResult.content) {
      sections.push({ tag: "boot-context", content: bootResult.content });
    }

    // 2. Top opinions (strongest beliefs)
    const opinions = this.opinionBank.getContextString(8);
    if (opinions) {
      sections.push({ tag: "learned-opinions", content: opinions });
    }

    // 3. Knowledge summary (learnings + troubleshooting + prefs)
    const knowledge = readKnowledgeSummary(this.memoryPath);
    if (knowledge) {
      sections.push({ tag: "knowledge-summary", content: knowledge });
    }

    // 4. Available skills catalog
    const skillManager = this.skillManagerRef?.get() ?? null;
    const skills = readSkillCatalog(this.memoryPath, skillManager);
    if (skills) {
      sections.push({ tag: "available-skills", content: skills });
    }

    // 5. Recent session history
    if (sessionHistory) {
      sections.push({ tag: "recent-sessions", content: sessionHistory });
    }

    // 6. Agent diary (if a mode is active)
    if (this.currentMode) {
      const diary = readDiary(this.memoryPath, this.currentMode);
      if (diary) {
        sections.push({ tag: "agent-diary", content: diary });
      }
    }

    // 7. Vault summary (labels + instructions, no secrets)
    // memoryPath = <wsRoot>/.project-brain/memory → dirname twice = wsRoot
    const wsRoot = path.dirname(path.dirname(this.memoryPath));
    const vaultCtx = readVaultSummary(wsRoot);
    if (vaultCtx) {
      sections.push({ tag: "vault-context", content: vaultCtx });
    }

    return sections;
  }

  /** Log injection details + admin tracking. */
  private logInjection(sections: ContextSection[]): void {
    const hasKnowledge = sections.some((s) => s.tag === "knowledge-summary");
    const hasSkills = sections.some((s) => s.tag === "available-skills");

    this.log(
      `[AutoRecall] Injected boot context + ${this.opinionBank.count} opinions` +
        `${hasKnowledge ? " + knowledge summary" : ""}` +
        `${hasSkills ? " + skill catalog" : ""}`,
    );

    // Admin logging: log skill catalog injection
    if (hasSkills) {
      const db = this.adminDbRef?.get();
      if (db) {
        db.logExecution({
          skillName: "_auto_recall_catalog",
          trigger: "autoRecall",
          result: "injected",
          query: "session-start",
        }).catch((e: unknown) => logWarn(`[AutoRecall] logExecution failed: ${e}`));
      }
    }
  }
}
