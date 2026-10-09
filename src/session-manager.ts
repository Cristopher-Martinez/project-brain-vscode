import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { SessionDB } from "./session-db";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionData {
  timestamp: string;
  workspaceFolder: string;
  goals: string[];
  completed: string[];
  pending: string[];
  decisions: string[];
  activeFiles: string[];
  keyContext: string[];
  recentCommits: string[];
  uncommittedChanges: string[];
  notes: string;
}

/** Fingerprint of .project-brain/memory/ state for change detection */
export interface MemoryFingerprint {
  /** Map of filename → "mtime:size" for quick comparison */
  files: Record<string, string>;
  /** Combined hash of all file fingerprints */
  hash: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_FILENAME = "07_SESSION_HANDOFF.md";
const SESSION_QUICK_FILENAME = ".project-brain-session.json";
const FINGERPRINT_FILENAME = ".project-brain-fingerprint.json";

// ─── Session Manager ─────────────────────────────────────────────────────────

export class SessionManager {
  private memoryPath: string;
  private workspacePath: string;
  private sessionDbRef: { get: () => SessionDB | null } | null = null;

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    this.workspacePath = workspaceFolder.uri.fsPath;
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>(
      "memoryFolder",
      ".project-brain/memory",
    );
    this.memoryPath = path.join(this.workspacePath, memoryFolder);
  }

  setSessionDbRef(ref: { get: () => SessionDB | null }): void {
    this.sessionDbRef = ref;
  }

  // ─── Save Session ────────────────────────────────────────────────────

  async saveSession(data: SessionData): Promise<string> {
    // Ensure memory dir exists
    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }

    // 1. Write the full Markdown handoff (RAG-indexed)
    const mdContent = this.generateMarkdown(data);
    const mdPath = path.join(this.memoryPath, SESSION_FILENAME);
    fs.writeFileSync(mdPath, mdContent, "utf-8");

    // 2. Write compact JSON for quick machine loading
    const jsonPath = path.join(
      this.workspacePath,
      ".vscode",
      SESSION_QUICK_FILENAME,
    );
    const vscodePath = path.join(this.workspacePath, ".vscode");
    if (!fs.existsSync(vscodePath)) {
      fs.mkdirSync(vscodePath, { recursive: true });
    }
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");

    // 3. Persist to session history (OpenClaw session-memory hook pattern)
    //    Creates memory/sessions/YYYY-MM-DD-<slug>.md — never overwritten
    this.persistSessionHistory(data);

    return mdPath;
  }

  // ─── Session History (persistent, append-only) ───────────────────────

  /**
   * Persist a session snapshot to memory/sessions/YYYY-MM-DD-<slug>.md.
   * Inspired by OpenClaw's session-memory hook: each session gets a
   * permanent record, unlike 07_SESSION_HANDOFF.md which is overwritten.
   *
   * The slug is generated from goals or decisions to make filenames descriptive.
   */
  private persistSessionHistory(data: SessionData): void {
    const sessionsDir = path.join(this.memoryPath, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const date = data.timestamp.split("T")[0]; // YYYY-MM-DD
    const time =
      data.timestamp.split("T")[1]?.substring(0, 5)?.replace(":", "") || "0000"; // HHmm
    const slug = this.generateSlug(data);
    const filename = `${date}-${slug}.md`;
    const filePath = path.join(sessionsDir, filename);

    // Don't overwrite if already exists (e.g. multiple saves in same session)
    if (fs.existsSync(filePath)) return;

    const lines: string[] = [
      `# Session: ${data.timestamp}`,
      "",
      `- **Workspace**: ${data.workspaceFolder}`,
      `- **Branch**: ${this.getCurrentBranch()}`,
      `- **Time**: ${time}`,
      "",
    ];

    if (data.goals.length > 0) {
      lines.push("## Goals", "");
      data.goals.forEach((g) => lines.push(`- ${g}`));
      lines.push("");
    }

    if (data.completed.length > 0) {
      lines.push("## Completed", "");
      data.completed.forEach((c) => lines.push(`- ✅ ${c}`));
      lines.push("");
    }

    if (data.pending.length > 0) {
      lines.push("## Pending", "");
      data.pending.forEach((p) => lines.push(`- ⬜ ${p}`));
      lines.push("");
    }

    if (data.decisions.length > 0) {
      lines.push("## Key Decisions", "");
      data.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push("");
    }

    if (data.recentCommits.length > 0) {
      lines.push("## Recent Commits", "");
      data.recentCommits.slice(0, 3).forEach((c) => lines.push(`- \`${c}\``));
      lines.push("");
    }

    if (data.notes) {
      lines.push("## Notes", "", data.notes, "");
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  }

  /**
   * Generate a descriptive slug from session data.
   * Uses goals/decisions keywords, falls back to timestamp.
   */
  private generateSlug(data: SessionData): string {
    // Combine goals + decisions into source text
    const source = [...data.goals, ...data.decisions].join(" ");
    if (!source || source.length < 5) {
      // Fallback: use HHmm timestamp
      const time =
        data.timestamp.split("T")[1]?.substring(0, 5)?.replace(":", "") ||
        "0000";
      return time;
    }

    // Extract meaningful words (skip common ones)
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "el",
      "la",
      "los",
      "las",
      "de",
      "en",
      "con",
      "por",
      "que",
      "del",
      "un",
      "una",
      "es",
      "son",
      "al",
      "se",
      "no",
      "si",
      "como",
      "más",
      "esta",
      "este",
      "esto",
      "y",
      "o",
      "e",
    ]);

    const words = source
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .slice(0, 4);

    if (words.length === 0) {
      const time =
        data.timestamp.split("T")[1]?.substring(0, 5)?.replace(":", "") ||
        "0000";
      return time;
    }

    return words.join("-");
  }

  /**
   * Get the current git branch name.
   */
  private getCurrentBranch(): string {
    try {
      return execFileSync("git", ["branch", "--show-current"], {
        cwd: this.workspacePath,
        timeout: 3000,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "unknown";
    }
  }

  /**
   * List all persisted session files with metadata.
   * Returns newest-first, up to `limit` entries.
   */
  listSessionHistory(
    limit = 20,
  ): { filename: string; date: string; path: string }[] {
    const sessionsDir = path.join(this.memoryPath, "sessions");
    if (!fs.existsSync(sessionsDir)) return [];

    return fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((filename) => ({
        filename,
        date: filename.substring(0, 10), // YYYY-MM-DD
        path: path.join(sessionsDir, filename),
      }));
  }

  /**
   * List session summaries from SQLite (preferred) or fall back to .md files.
   */
  async listSessionHistoryAsync(
    limit = 20,
  ): Promise<
    { filename: string; date: string; path: string; summaryMarkdown?: string }[]
  > {
    const db = this.sessionDbRef?.get();
    if (db) {
      try {
        const rows = await db.listSummaries(limit);
        return rows.map((r) => ({
          filename: r.sourceFile || `${r.date}-summary`,
          date: r.date.substring(0, 10),
          path: "",
          summaryMarkdown: r.summaryMarkdown,
        }));
      } catch {
        // Fallback to .md if DB fails
      }
    }
    return this.listSessionHistory(limit);
  }

  /**
   * Get recent session history as a compact context string.
   * Reads filenames only (not content) for injection into AutoRecall.
   */
  getRecentSessionSummary(days = 2): string {
    // Try SQLite first
    const db = this.sessionDbRef?.get();
    if (db) {
      try {
        // Note: sync wrapper — getRecentSummaries is async but we need sync here
        // Use the sync .md fallback for now; async callers should use getRecentSessionSummaryAsync
      } catch {
        /* fall through */
      }
    }

    const history = this.listSessionHistory(10);
    if (history.length === 0) return "";

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const recent = history.filter((h) => h.date >= cutoffStr);
    if (recent.length === 0) return "";

    return recent.map((h) => `- ${h.filename}`).join("\n");
  }

  /**
   * Async version: get recent session summaries from SQLite or .md.
   */
  async getRecentSessionSummaryAsync(days = 2): Promise<string> {
    const db = this.sessionDbRef?.get();
    if (db) {
      try {
        const rows = await db.getRecentSummaries(days);
        if (rows.length > 0) {
          return rows.map((r) => `- ${r.sourceFile || r.date}`).join("\n");
        }
      } catch {
        /* fall through */
      }
    }
    return this.getRecentSessionSummary(days);
  }

  // ─── Load Last Session ───────────────────────────────────────────────

  async loadSession(): Promise<SessionData | null> {
    const jsonPath = path.join(
      this.workspacePath,
      ".vscode",
      SESSION_QUICK_FILENAME,
    );
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  // ─── Check if Session Exists ─────────────────────────────────────────

  hasSession(): boolean {
    return fs.existsSync(path.join(this.memoryPath, SESSION_FILENAME));
  }

  // ─── Get Session Age (minutes) ───────────────────────────────────────

  getSessionAge(): number | null {
    const jsonPath = path.join(
      this.workspacePath,
      ".vscode",
      SESSION_QUICK_FILENAME,
    );
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(raw) as SessionData;
      const sessionTime = new Date(data.timestamp).getTime();
      return Math.round((Date.now() - sessionTime) / 60000);
    } catch {
      return null;
    }
  }

  // ─── Generate Summary for Context Injection ──────────────────────────

  generateCompactSummary(data: SessionData): string {
    const lines: string[] = [];
    lines.push(`# Session Handoff — ${data.workspaceFolder}`);
    lines.push(`**Saved**: ${data.timestamp}`);
    lines.push("");

    if (data.goals.length > 0) {
      lines.push("## Goals");
      data.goals.forEach((g) => lines.push(`- ${g}`));
      lines.push("");
    }

    if (data.completed.length > 0) {
      lines.push("## Completed");
      data.completed.forEach((c) => lines.push(`- ✅ ${c}`));
      lines.push("");
    }

    if (data.pending.length > 0) {
      lines.push("## Pending");
      data.pending.forEach((p) => lines.push(`- ⬜ ${p}`));
      lines.push("");
    }

    if (data.decisions.length > 0) {
      lines.push("## Key Decisions");
      data.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push("");
    }

    if (data.activeFiles.length > 0) {
      lines.push("## Active Files");
      data.activeFiles.forEach((f) => lines.push(`- ${f}`));
      lines.push("");
    }

    if (data.keyContext.length > 0) {
      lines.push("## Key Context");
      data.keyContext.forEach((k) => lines.push(`- ${k}`));
      lines.push("");
    }

    if (data.notes) {
      lines.push("## Notes");
      lines.push(data.notes);
    }

    return lines.join("\n");
  }

  // ─── Interactive Save (via Quick Pick) ───────────────────────────────

  private getLanguage(): string {
    try {
      const idPath = path.join(this.memoryPath, "08_AGENT_IDENTITY.md");
      const raw = fs.readFileSync(idPath, "utf-8");
      return raw.match(/\*\*Language\*\*:\s*(.+)/)?.[1]?.trim() ?? "English";
    } catch {
      return "English";
    }
  }

  async interactiveSave(): Promise<string | null> {
    const lang = this.getLanguage();
    const isEs = /espa[nñ]ol|spanish/i.test(lang);

    // Gather goals
    const goalsInput = await vscode.window.showInputBox({
      prompt: isEs
        ? "¿Cuáles son los objetivos actuales? (separados por ;)"
        : "What are the current goals? (separated by ;)",
      placeHolder: isEs
        ? "ej: Implementar feature X; Corregir bug Y"
        : "e.g.: Implement feature X; Fix bug Y",
      ignoreFocusOut: true,
    });
    if (goalsInput === undefined) return null;

    // Gather completed work
    const completedInput = await vscode.window.showInputBox({
      prompt: isEs
        ? "¿Qué se completó en esta sesión? (separados por ;)"
        : "What was completed this session? (separated by ;)",
      placeHolder: isEs
        ? "ej: Fase 1 build portability; Fase 2 scanner"
        : "e.g.: Phase 1 build portability; Phase 2 scanner",
      ignoreFocusOut: true,
    });
    if (completedInput === undefined) return null;

    // Gather pending work
    const pendingInput = await vscode.window.showInputBox({
      prompt: isEs
        ? "¿Qué queda pendiente? (separados por ;)"
        : "What's pending? (separated by ;)",
      placeHolder: isEs
        ? "ej: Tests para scanner; Documentar API"
        : "e.g.: Tests for scanner; Document API",
      ignoreFocusOut: true,
    });
    if (pendingInput === undefined) return null;

    // Gather key decisions
    const decisionsInput = await vscode.window.showInputBox({
      prompt: isEs
        ? "¿Decisiones técnicas importantes? (separados por ;)"
        : "Important technical decisions? (separated by ;)",
      placeHolder: isEs
        ? "ej: Usar esbuild dual-pass; Embeddings con fallback 3-tier"
        : "e.g.: Use esbuild dual-pass; Embeddings with 3-tier fallback",
      ignoreFocusOut: true,
    });

    // Gather extra notes
    const notesInput = await vscode.window.showInputBox({
      prompt: isEs
        ? "Notas adicionales o contexto clave (opcional)"
        : "Additional notes or key context (optional)",
      placeHolder: isEs
        ? "ej: El error de CORS se resolvió cambiando headers..."
        : "e.g.: The CORS error was resolved by changing headers...",
      ignoreFocusOut: true,
    });

    // Collect currently open files
    const activeFiles = this.getOpenEditorFiles();

    // Detect key context from workspace
    const keyContext = await this.detectKeyContext();

    const splitTrim = (s: string | undefined): string[] =>
      (s || "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean);

    const data: SessionData = {
      timestamp: new Date().toISOString(),
      workspaceFolder: this.workspaceFolder.name,
      goals: splitTrim(goalsInput),
      completed: splitTrim(completedInput),
      pending: splitTrim(pendingInput),
      decisions: splitTrim(decisionsInput),
      activeFiles,
      keyContext,
      recentCommits: this.getRecentCommits(),
      uncommittedChanges: this.getUncommittedChanges(),
      notes: notesInput?.trim() || "",
    };

    const savedPath = await this.saveSession(data);
    return savedPath;
  }

  // ─── Auto-Save (non-interactive, gathers context automatically) ──────

  async autoSave(
    goals?: string[],
    completed?: string[],
    pending?: string[],
    decisions?: string[],
    notes?: string,
  ): Promise<string> {
    const activeFiles = this.getOpenEditorFiles();
    const keyContext = await this.detectKeyContext();
    const recentCommits = this.getRecentCommits();
    const uncommittedChanges = this.getUncommittedChanges();

    const data: SessionData = {
      timestamp: new Date().toISOString(),
      workspaceFolder: this.workspaceFolder.name,
      goals: goals || [],
      completed: completed || [],
      pending: pending || [],
      decisions: decisions || [],
      activeFiles,
      keyContext,
      recentCommits,
      uncommittedChanges,
      notes: notes || "",
    };

    return this.saveSession(data);
  }

  // ─── Memory Change Detection ─────────────────────────────────────────

  /**
   * Take a fingerprint of all .md files in .project-brain/memory/.
   * Uses mtime + size for speed (no need to read file contents).
   */
  takeFingerprint(): MemoryFingerprint {
    const files: Record<string, string> = {};

    if (!fs.existsSync(this.memoryPath)) {
      return { files, hash: "empty" };
    }

    const entries = fs
      .readdirSync(this.memoryPath)
      .filter((f) => f.endsWith(".md"));
    for (const entry of entries) {
      // Skip the session file itself — it changes every save
      if (entry === SESSION_FILENAME) continue;
      try {
        const stat = fs.statSync(path.join(this.memoryPath, entry));
        files[entry] = `${stat.mtimeMs}:${stat.size}`;
      } catch {
        /* skip */
      }
    }

    // Hash the fingerprint for quick comparison
    const raw = Object.entries(files)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("|");
    const hash = crypto.createHash("md5").update(raw).digest("hex");
    return { files, hash };
  }

  /**
   * Load the last saved fingerprint from .vscode/
   */
  loadFingerprint(): MemoryFingerprint | null {
    const fpPath = path.join(
      this.workspacePath,
      ".vscode",
      FINGERPRINT_FILENAME,
    );
    if (!fs.existsSync(fpPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(fpPath, "utf-8")) as MemoryFingerprint;
    } catch {
      return null;
    }
  }

  /**
   * Save the current fingerprint to .vscode/
   */
  saveFingerprint(fp: MemoryFingerprint): void {
    const vscodePath = path.join(this.workspacePath, ".vscode");
    if (!fs.existsSync(vscodePath)) {
      fs.mkdirSync(vscodePath, { recursive: true });
    }
    fs.writeFileSync(
      path.join(vscodePath, FINGERPRINT_FILENAME),
      JSON.stringify(fp),
      "utf-8",
    );
  }

  /**
   * Check if .project-brain/memory/ has changed since last vectorization.
   * Returns true if vectorization is needed.
   */
  needsVectorization(): boolean {
    const current = this.takeFingerprint();
    const previous = this.loadFingerprint();

    if (!previous) return true; // Never vectorized
    return current.hash !== previous.hash;
  }

  /**
   * Mark current state as vectorized (save fingerprint).
   */
  markVectorized(): void {
    const fp = this.takeFingerprint();
    this.saveFingerprint(fp);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private getOpenEditorFiles(): string[] {
    const files: string[] = [];
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      if (tab.input && typeof (tab.input as any).uri !== "undefined") {
        const uri = (tab.input as any).uri as vscode.Uri;
        if (uri.scheme === "file") {
          const rel = vscode.workspace.asRelativePath(uri, false);
          files.push(rel);
        }
      }
    }
    return [...new Set(files)]; // deduplicate
  }

  /**
   * Get the last 5 git commits (one-line format).
   */
  private getRecentCommits(count = 5): string[] {
    try {
      const output = execFileSync(
        "git",
        ["log", `--oneline`, `-${count}`, "--no-decorate"],
        { cwd: this.workspacePath, timeout: 5000, encoding: "utf-8" },
      );
      return output
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Get uncommitted changes (staged + unstaged).
   */
  private getUncommittedChanges(): string[] {
    try {
      const output = execFileSync("git", ["status", "--short"], {
        cwd: this.workspacePath,
        timeout: 5000,
        encoding: "utf-8",
      });
      return output
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private async detectKeyContext(): Promise<string[]> {
    const context: string[] = [];

    // Detect package.json info
    const pkgPath = path.join(this.workspacePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        context.push(`Project: ${pkg.name}@${pkg.version}`);
        if (pkg.scripts) {
          const scriptList = Object.keys(pkg.scripts).join(", ");
          context.push(`Scripts: ${scriptList}`);
        }
      } catch {
        /* ignore */
      }
    }

    // Detect git branch
    try {
      const gitHeadPath = path.join(this.workspacePath, ".git", "HEAD");
      if (fs.existsSync(gitHeadPath)) {
        const head = fs.readFileSync(gitHeadPath, "utf-8").trim();
        const match = head.match(/ref: refs\/heads\/(.+)/);
        if (match) {
          context.push(`Git branch: ${match[1]}`);
        }
      }
    } catch {
      /* ignore */
    }

    // Detect memory file count
    if (fs.existsSync(this.memoryPath)) {
      const memFiles = fs
        .readdirSync(this.memoryPath)
        .filter((f) => f.endsWith(".md"));
      context.push(
        `Memory docs: ${memFiles.length} files in ${this.memoryPath}`,
      );
    }

    // Detect recent errors from Problems panel
    const diagnostics = vscode.languages.getDiagnostics();
    let errorCount = 0;
    let warnCount = 0;
    for (const [, diags] of diagnostics) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
        if (d.severity === vscode.DiagnosticSeverity.Warning) warnCount++;
      }
    }
    if (errorCount > 0 || warnCount > 0) {
      context.push(`Diagnostics: ${errorCount} errors, ${warnCount} warnings`);
    }

    return context;
  }

  // ─── Markdown Generation ─────────────────────────────────────────────

  private generateMarkdown(data: SessionData): string {
    const lines: string[] = [];

    lines.push("# Session Handoff");
    lines.push("");
    lines.push(
      "<!-- Auto-generated by Project Brain. Gives agents instant context. -->",
    );
    lines.push("");
    lines.push(`**Date**: ${data.timestamp}`);
    lines.push(`**Tags**: session, handoff, continuity, context, progress`);
    lines.push(`**Workspace**: ${data.workspaceFolder}`);
    lines.push("");

    // Environment Context — always present
    lines.push("## Environment");
    lines.push("");
    data.keyContext.forEach((k) => lines.push(`- ${k}`));
    lines.push("");

    // Recent Commits — most useful for "what were we doing?"
    if (data.recentCommits.length > 0) {
      lines.push("## Recent Commits");
      lines.push("");
      data.recentCommits.forEach((c) => lines.push(`- \`${c}\``));
      lines.push("");
    }

    // Uncommitted Changes
    if (data.uncommittedChanges.length > 0) {
      lines.push("## Uncommitted Changes");
      lines.push("");
      data.uncommittedChanges.forEach((c) => lines.push(`- \`${c}\``));
      lines.push("");
    }

    // Active Files — only if any
    if (data.activeFiles.length > 0) {
      lines.push("## Active Files");
      lines.push("");
      data.activeFiles.forEach((f) => lines.push(`- \`${f}\``));
      lines.push("");
    }

    // Only show goals/completed/pending/decisions if they have content
    if (data.goals.length > 0) {
      lines.push("## Goals");
      lines.push("");
      data.goals.forEach((g) => lines.push(`- ${g}`));
      lines.push("");
    }

    if (data.completed.length > 0) {
      lines.push("## Completed");
      lines.push("");
      data.completed.forEach((c) => lines.push(`- ✅ ${c}`));
      lines.push("");
    }

    if (data.pending.length > 0) {
      lines.push("## Pending");
      lines.push("");
      data.pending.forEach((p) => lines.push(`- ⬜ ${p}`));
      lines.push("");
    }

    if (data.decisions.length > 0) {
      lines.push("## Decisions");
      lines.push("");
      data.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push("");
    }

    if (data.notes) {
      lines.push("## Notes");
      lines.push("");
      lines.push(data.notes);
      lines.push("");
    }

    return lines.join("\n");
  }
}
