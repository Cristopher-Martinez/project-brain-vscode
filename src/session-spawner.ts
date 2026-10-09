import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AutoCapture } from "./auto-capture";
import { OpinionBank } from "./opinion-bank";
import { SessionManager } from "./session-manager";

/**
 * SessionSpawner — The "third hand" of Project Brain.
 *
 * Enables context window continuity by spawning fresh chat sessions
 * with task state preserved in TASK_QUEUE.md. When context runs low,
 * the agent writes its state and the spawner opens a new session
 * that boots fresh and continues from TASK_QUEUE.
 *
 * Features:
 *   - Explicit user confirmation form before every spawn
 *   - Full context snapshot: files, cursor, commits, diffs, terminals, diagnostics
 *   - Conversation summary via LM API
 *   - Spawn chain history (Session 1 → 2 → 3 traceable)
 *   - Auto-spawn detection via context pressure counter
 *   - Opens in 🧠 Brain mode (not generic Agent)
 */

export interface SpawnOptions {
  /** Why the spawn is happening */
  reason: string;
  /** Description of the task to continue */
  currentTask?: string;
  /** Items still pending */
  pendingItems?: string[];
  /** Items already completed */
  completedItems?: string[];
  /** Specific instructions for the new session */
  instructions?: string;
  /** Whether to auto-submit the prompt (default: true) */
  autoSubmit?: boolean;
  /** Conversation summary (auto-generated if not provided) */
  conversationSummary?: string;
}

/** Full workspace snapshot captured before spawn */
interface ContextSnapshot {
  activeFiles: string[];
  cursorPosition: string | null;
  recentCommits: string[];
  uncommittedChanges: string[];
  diffSummary: string[];
  currentBranch: string;
  diagnosticSummary: string;
  activeTerminals: string[];
  spawnHistory: SpawnHistoryEntry[];
}

interface SpawnHistoryEntry {
  timestamp: string;
  reason: string;
  task?: string;
}

// ─── Session Spawner ───────────────────────────────────────────────────

export class SessionSpawner {
  private memoryPath: string;
  private workspacePath: string;
  private autoCapture: AutoCapture | null = null;
  private opinionBank: OpinionBank | null = null;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>(
      "memoryFolder",
      ".project-brain/memory",
    );
    this.workspacePath = workspaceFolder.uri.fsPath;
    this.memoryPath = path.join(this.workspacePath, memoryFolder);
  }

  /** Attach neuroplasticity layer for pre-spawn flush. */
  setNeuroplasticity(autoCapture: AutoCapture, opinionBank: OpinionBank): void {
    this.autoCapture = autoCapture;
    this.opinionBank = opinionBank;
  }

  // ─── Core Spawn ──────────────────────────────────────────────────────

  async spawn(opts: SpawnOptions): Promise<void> {
    this.log(`[Spawn] Initiating — reason: ${opts.reason}`);

    const confirmed = await this.requestSpawnConfirmationForm(opts);
    if (!confirmed) {
      this.log("[Spawn] Cancelled — confirmation form not approved by user");
      return;
    }
    opts = confirmed;

    // 0. Pre-compaction memory flush (OpenClaw pattern)
    //    Flush all pending captures + force-save opinions BEFORE we lose context
    if (this.autoCapture) {
      try {
        const flushed = await this.autoCapture.flushPending();
        this.log(`[Spawn] Pre-compaction flush: ${flushed} captures saved`);
      } catch (err) {
        this.log(`[Spawn] Pre-compaction flush failed (non-fatal): ${err}`);
      }
    } else if (this.opinionBank) {
      // Fallback: at least save opinions directly
      this.opinionBank.flush();
    }

    // 1. Auto-gather full context from workspace
    const snapshot = this.gatherContextSnapshot();

    // 2. Use agent-provided summary, or build factual fallback from snapshot
    if (!opts.conversationSummary) {
      this.log(
        "[Spawn] No agent summary provided — using factual snapshot summary",
      );
      opts.conversationSummary = this.buildSnapshotSummary(snapshot);
    } else {
      this.log(
        `[Spawn] Using agent-provided conversation summary (${opts.conversationSummary.length} chars)`,
      );
    }

    // 3. Write enriched TASK_QUEUE.md (context + task + summary + history)
    await this.writeTaskQueue(opts, snapshot);

    // 4. Auto-save session state
    await this.saveSessionState(opts);

    // 5. Open new chat session in Brain mode
    await this.openNewSession(opts);

    this.log("[Spawn] Complete — new session opened in Brain mode");
  }

  private getLanguage(): string {
    try {
      const idPath = path.join(this.memoryPath, "08_AGENT_IDENTITY.md");
      const raw = fs.readFileSync(idPath, "utf-8");
      return raw.match(/\*\*Language\*\*:\s*(.+)/)?.[1]?.trim() ?? "English";
    } catch {
      return "English";
    }
  }

  private getSpawnStrings(lang: string): Record<string, string> {
    const isEs = /espa[nñ]ol|spanish/i.test(lang);
    return isEs
      ? {
          confirmYes:
            "$(check) Sí, cerrar esta conversación y spawnear nueva sesión",
          confirmNo: "$(x) No, cancelar",
          confirmTitle: "Project Brain: Confirmación obligatoria",
          confirmPlaceholder:
            "Ningún agente puede cerrar/spawnear sin tu instrucción explícita",
          phrase: "CONFIRMO CERRAR SESIÓN",
          phraseTitle: "Project Brain: Formulario de confirmación",
          phrasePrompt: "Escribe exactamente:",
          phraseMismatch:
            "La frase no coincide. Esto evita cierres automáticos no autorizados.",
          reasonTitle: "Project Brain: Motivo del spawn",
          reasonPrompt: "Confirma o ajusta el motivo del cierre/spawn",
          reasonEmpty: "El motivo no puede quedar vacío.",
          taskTitle: "Project Brain: Tarea a continuar",
          taskPrompt: "Tarea para la nueva sesión (opcional)",
        }
      : {
          confirmYes:
            "$(check) Yes, close this conversation and spawn new session",
          confirmNo: "$(x) No, cancel",
          confirmTitle: "Project Brain: Mandatory Confirmation",
          confirmPlaceholder:
            "No agent can close/spawn without your explicit instruction",
          phrase: "CONFIRM CLOSE SESSION",
          phraseTitle: "Project Brain: Confirmation Form",
          phrasePrompt: "Type exactly:",
          phraseMismatch:
            "Phrase does not match. This prevents unauthorized automatic closures.",
          reasonTitle: "Project Brain: Spawn Reason",
          reasonPrompt: "Confirm or adjust the reason for closing/spawning",
          reasonEmpty: "Reason cannot be empty.",
          taskTitle: "Project Brain: Task to Continue",
          taskPrompt: "Task for the new session (optional)",
        };
  }

  private async requestSpawnConfirmationForm(
    opts: SpawnOptions,
  ): Promise<SpawnOptions | null> {
    const s = this.getSpawnStrings(this.getLanguage());

    const decision = await vscode.window.showQuickPick(
      [
        {
          label: s.confirmYes,
          value: "confirm",
        },
        {
          label: s.confirmNo,
          value: "cancel",
        },
      ],
      {
        title: s.confirmTitle,
        placeHolder: s.confirmPlaceholder,
      },
    );

    if (!decision || decision.value !== "confirm") {
      return null;
    }

    const phrase = s.phrase;
    const typedConfirmation = await vscode.window.showInputBox({
      title: s.phraseTitle,
      prompt: `${s.phrasePrompt} ${phrase}`,
      placeHolder: phrase,
      validateInput: (value) =>
        value.trim() === phrase ? null : s.phraseMismatch,
      ignoreFocusOut: true,
    });

    if (!typedConfirmation || typedConfirmation.trim() !== phrase) {
      return null;
    }

    const reason = await vscode.window.showInputBox({
      title: s.reasonTitle,
      prompt: s.reasonPrompt,
      value: opts.reason,
      validateInput: (value) =>
        value.trim().length > 0 ? null : s.reasonEmpty,
      ignoreFocusOut: true,
    });

    if (!reason || !reason.trim()) {
      return null;
    }

    const task = await vscode.window.showInputBox({
      title: s.taskTitle,
      prompt: s.taskPrompt,
      value: opts.currentTask ?? "",
      ignoreFocusOut: true,
    });

    return {
      ...opts,
      reason: reason.trim(),
      currentTask: task?.trim() ? task.trim() : opts.currentTask,
    };
  }

  // ─── Context Snapshot (full capture) ─────────────────────────────────

  private gatherContextSnapshot(): ContextSnapshot {
    this.log("[Spawn] Gathering full context snapshot...");

    const activeFiles = this.getOpenEditorFiles();
    const cursorPosition = this.getCursorPosition();
    const recentCommits = this.getRecentCommits(5);
    const uncommittedChanges = this.getUncommittedChanges();
    const diffSummary = this.getDiffSummary();
    const currentBranch = this.getCurrentBranch();
    const diagnosticSummary = this.getDiagnosticSummary();
    const activeTerminals = this.getActiveTerminals();
    const spawnHistory = this.loadSpawnHistory();

    this.log(
      `[Spawn] Snapshot: ${activeFiles.length} files, cursor=${cursorPosition || "none"}, ` +
        `${recentCommits.length} commits, ${uncommittedChanges.length} changes, ` +
        `${activeTerminals.length} terminals, ${spawnHistory.length} prior spawns`,
    );

    return {
      activeFiles,
      cursorPosition,
      recentCommits,
      uncommittedChanges,
      diffSummary,
      currentBranch,
      diagnosticSummary,
      activeTerminals,
      spawnHistory,
    };
  }

  // #1: Active files
  private getOpenEditorFiles(): string[] {
    const files: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && typeof tab.input === "object" && "uri" in tab.input) {
          const uri = (tab.input as { uri: vscode.Uri }).uri;
          if (uri.scheme === "file") {
            files.push(vscode.workspace.asRelativePath(uri, false));
          }
        }
      }
    }
    return [...new Set(files)];
  }

  // #5: Cursor position + selection
  private getCursorPosition(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const file = vscode.workspace.asRelativePath(editor.document.uri, false);
    const sel = editor.selection;
    if (sel.isEmpty) {
      return `${file}:L${sel.active.line + 1}:C${sel.active.character + 1}`;
    }
    return `${file}:L${sel.start.line + 1}-L${sel.end.line + 1} (selected)`;
  }

  // Git: recent commits
  private getRecentCommits(count = 5): string[] {
    try {
      const output = execFileSync(
        "git",
        ["log", "--oneline", `-${count}`, "--no-decorate"],
        { cwd: this.workspacePath, timeout: 5000, encoding: "utf-8" },
      );
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // Git: uncommitted changes
  private getUncommittedChanges(): string[] {
    try {
      const output = execFileSync("git", ["status", "--short"], {
        cwd: this.workspacePath,
        timeout: 5000,
        encoding: "utf-8",
      });
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // #3: Diff snapshot (stat + first 60 lines of actual diff)
  private getDiffSummary(): string[] {
    const lines: string[] = [];
    try {
      const stat = execFileSync("git", ["diff", "--stat"], {
        cwd: this.workspacePath,
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (stat) lines.push(stat);
    } catch {
      /* ignore */
    }

    try {
      const diff = execFileSync("git", ["diff", "--no-color"], {
        cwd: this.workspacePath,
        timeout: 8000,
        encoding: "utf-8",
        maxBuffer: 50_000,
      }).trim();
      if (diff) {
        // Take first 60 lines to keep TASK_QUEUE reasonable
        const truncated = diff.split("\n").slice(0, 60);
        if (diff.split("\n").length > 60) {
          truncated.push("... (truncated, run `git diff` for full output)");
        }
        lines.push(...truncated);
      }
    } catch {
      /* ignore — diff too large or no changes */
    }

    return lines;
  }

  // Git: current branch
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

  // Diagnostics summary
  private getDiagnosticSummary(): string {
    let errors = 0;
    let warnings = 0;
    for (const [, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
    }
    return `${errors} errors, ${warnings} warnings`;
  }

  // #6: Active terminals
  private getActiveTerminals(): string[] {
    return vscode.window.terminals.map((t) => {
      const name = t.name;
      const state = t.state?.isInteractedWith ? "active" : "idle";
      return `${name} (${state})`;
    });
  }

  // #4: Spawn chain history
  private loadSpawnHistory(): SpawnHistoryEntry[] {
    const historyPath = path.join(this.memoryPath, ".spawn-history.json");
    try {
      if (fs.existsSync(historyPath)) {
        const data = JSON.parse(fs.readFileSync(historyPath, "utf8"));
        return Array.isArray(data) ? data.slice(-10) : []; // keep last 10
      }
    } catch {
      /* ignore corrupt file */
    }
    return [];
  }

  private appendSpawnHistory(entry: SpawnHistoryEntry): void {
    const historyPath = path.join(this.memoryPath, ".spawn-history.json");
    const history = this.loadSpawnHistory();
    history.push(entry);
    // Keep only last 10 entries
    const trimmed = history.slice(-10);
    fs.writeFileSync(historyPath, JSON.stringify(trimmed, null, 2), "utf8");
  }

  // ─── Snapshot Summary (deterministic, no LM) ────────────────────────

  /**
   * Build a factual summary from the context snapshot.
   * No LM involved — only real data. Used as fallback when the agent
   * doesn't provide its own conversation summary.
   */
  private buildSnapshotSummary(ctx: ContextSnapshot): string {
    const parts: string[] = [];

    if (ctx.activeFiles.length) {
      parts.push(`**Active files**: ${ctx.activeFiles.join(", ")}`);
    }
    if (ctx.cursorPosition) {
      parts.push(`**Cursor**: ${ctx.cursorPosition}`);
    }
    if (ctx.recentCommits.length) {
      parts.push(
        `**Recent work** (from commits):\n${ctx.recentCommits.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (ctx.uncommittedChanges.length) {
      parts.push(
        `**In progress** (uncommitted):\n${ctx.uncommittedChanges.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    parts.push(`**Branch**: ${ctx.currentBranch}`);
    parts.push(`**Diagnostics**: ${ctx.diagnosticSummary}`);

    return parts.join("\n\n") || "No additional context available.";
  }

  // ─── SECURITY: Conversation Summary Sanitization ─────────────────────

  /**
   * HIGH-08: Sanitize conversation summary before writing to TASK_QUEUE.md.
   * Strips prompt injection patterns, system commands, and suspicious directives
   * that could be interpreted by the next LLM session reading the file.
   */
  private sanitizeConversationSummary(raw: string): string {
    const MAX_SUMMARY_LENGTH = 8000;

    // Patterns that could inject instructions into the next session
    const INJECTION_PATTERNS: RegExp[] = [
      /^(system|assistant|user)\s*:/gim,
      /\b(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?))/gi,
      /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you)/gi,
      /\b(override|bypass|disable|skip)\s+(security|auth|validation|checks?|rules?)/gi,
      /<\/?script\b[^>]*>/gi,
      /\beval\s*\(/gi,
      /\b(exec|execFile|spawn|fork)\s*\(/gi,
      /\bprocess\.env\b/gi,
      /\brequire\s*\(\s*['"`](child_process|fs|net|http|os)/gi,
      /\bimport\s+.*from\s+['"`](child_process|fs|net|http|os)/gi,
      /```\s*(bash|sh|powershell|cmd|bat)\b/gi,
      /\b(rm\s+-rf|del\s+\/[fqs]|format\s+[a-z]:)/gi,
    ];

    let sanitized = raw;

    // Strip injection patterns, replacing with [REDACTED]
    for (const pattern of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }

    // Truncate to max length
    if (sanitized.length > MAX_SUMMARY_LENGTH) {
      sanitized =
        sanitized.slice(0, MAX_SUMMARY_LENGTH) +
        "\n\n[...truncated at 8000 chars for context safety]";
    }

    return sanitized;
  }

  // ─── Task Queue (enriched) ───────────────────────────────────────────

  private async writeTaskQueue(
    opts: SpawnOptions,
    ctx: ContextSnapshot,
  ): Promise<void> {
    const taskQueuePath = path.join(this.memoryPath, "TASK_QUEUE.md");
    const timestamp = new Date().toISOString();

    const lines: string[] = [
      "# Task Queue — Spawn Continuation",
      "",
      `**Spawned**: ${timestamp}`,
      `**Reason**: ${opts.reason}`,
      `**Branch**: ${ctx.currentBranch}`,
      `**Diagnostics**: ${ctx.diagnosticSummary}`,
      "",
    ];

    // ── Conversation Summary (the soul of continuity) ──
    if (opts.conversationSummary) {
      // SECURITY (HIGH-08): Sanitize summary to prevent injection via TASK_QUEUE.md
      const sanitizedSummary = this.sanitizeConversationSummary(
        opts.conversationSummary,
      );
      lines.push("## Conversation Summary", "", sanitizedSummary, "");
    }

    // ── Spawn Chain History ──
    if (ctx.spawnHistory.length > 0) {
      lines.push("## Spawn Chain", "");
      for (const entry of ctx.spawnHistory) {
        const taskStr = entry.task ? ` — ${entry.task}` : "";
        lines.push(`- \`${entry.timestamp}\`: ${entry.reason}${taskStr}`);
      }
      lines.push(`- \`${timestamp}\`: ${opts.reason} ← **current**`, "");
    }

    // ── Active Files + Cursor ──
    if (ctx.activeFiles.length > 0) {
      lines.push("## Active Files", "");
      for (const f of ctx.activeFiles) {
        lines.push(`- ${f}`);
      }
      if (ctx.cursorPosition) {
        lines.push("", `**Cursor**: ${ctx.cursorPosition}`);
      }
      lines.push("");
    }

    // ── Recent Commits ──
    if (ctx.recentCommits.length > 0) {
      lines.push("## Recent Commits", "");
      for (const c of ctx.recentCommits) {
        lines.push(`- \`${c}\``);
      }
      lines.push("");
    }

    // ── Uncommitted Changes ──
    if (ctx.uncommittedChanges.length > 0) {
      lines.push("## Uncommitted Changes", "");
      for (const c of ctx.uncommittedChanges) {
        lines.push(`- ${c}`);
      }
      lines.push("");
    }

    // ── Diff Snapshot ──
    if (ctx.diffSummary.length > 0) {
      lines.push("## Diff Snapshot", "", "```diff");
      lines.push(...ctx.diffSummary);
      lines.push("```", "");
    }

    // ── Active Terminals ──
    if (ctx.activeTerminals.length > 0) {
      lines.push("## Active Terminals", "");
      for (const t of ctx.activeTerminals) {
        lines.push(`- ${t}`);
      }
      lines.push("");
    }

    // ── Task state ──
    if (opts.currentTask) {
      lines.push("## Current Task", "", opts.currentTask, "");
    }

    if (opts.pendingItems?.length) {
      lines.push("## Pending", "");
      for (const item of opts.pendingItems) {
        lines.push(`- [ ] ${item}`);
      }
      lines.push("");
    }

    if (opts.completedItems?.length) {
      lines.push("## Completed", "");
      for (const item of opts.completedItems) {
        lines.push(`- [x] ${item}`);
      }
      lines.push("");
    }

    if (opts.instructions) {
      lines.push("## Instructions for New Session", "", opts.instructions, "");
    }

    lines.push(
      "## Boot Instructions",
      "",
      "1. Read this TASK_QUEUE.md — it has your full context snapshot + conversation summary",
      "2. The Conversation Summary above tells you WHAT was being discussed and WHY",
      "3. 🔁 **LOOP GATE CHECK**: If the summary mentions an ACTIVE LOOP (Loop session ID, loopAwaitInput, sessionId) → ALL output MUST go through `loopAwaitInput(sessionId, synthesis)`. NEVER respond directly to the user. This overrides all other response rules.",
      "4. Search memory ONLY for the specific current task mentioned above",
      "5. Continue from where the previous session left off",
      "6. Do NOT re-read identity/soul/overview — focus on the task",
      "",
    );

    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }

    fs.writeFileSync(taskQueuePath, lines.join("\n"), "utf8");

    // Save to spawn chain history
    this.appendSpawnHistory({
      timestamp,
      reason: opts.reason,
      task: opts.currentTask,
    });

    this.log(
      "[Spawn] TASK_QUEUE written with full context + summary + history",
    );
  }

  // ─── Session Save ────────────────────────────────────────────────────

  private async saveSessionState(opts: SpawnOptions): Promise<void> {
    try {
      const sm = new SessionManager(this.workspaceFolder);
      await sm.autoSave(
        opts.currentTask ? [opts.currentTask] : ["Continue from spawn"],
        opts.completedItems,
        opts.pendingItems,
        [`Spawned new session: ${opts.reason}`],
        `Auto-spawn at ${new Date().toISOString()}. Reason: ${opts.reason}`,
      );
      this.log("[Spawn] Session state saved");
    } catch (err) {
      this.log(`[Spawn] Session save failed (non-fatal): ${err}`);
    }
  }

  // ─── New Session Opener ──────────────────────────────────────────────

  private async openNewSession(opts: SpawnOptions): Promise<void> {
    const isPartial = opts.autoSubmit === false;
    const prompt = this.buildContinuationPrompt(opts);

    const config = vscode.workspace.getConfiguration("projectBrain");
    const brainModeName = config.get<string>("chatModeName", "🧠 Brain");

    // Strategy 1: newChat → delay → open in Brain mode
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newChat");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: prompt,
        mode: brainModeName,
        isPartialQuery: isPartial,
      });
      this.log(`[Spawn] New session opened in "${brainModeName}" mode`);
      return;
    } catch (err) {
      this.log(`[Spawn] Strategy 1 failed: ${err}, trying fallback...`);
    }

    // Strategy 2: newChat with agentMode
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newChat", {
        inputValue: prompt,
        agentMode: true,
        isPartialQuery: isPartial,
      });
      this.log("[Spawn] Fallback: generic agent mode");
      return;
    } catch (err) {
      this.log(`[Spawn] Strategy 2 failed: ${err}`);
    }

    // Strategy 3: bare new chat
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newChat");
      vscode.window.showInformationMessage(
        "Session spawned! Switch to Brain mode and paste: " +
          prompt.substring(0, 60) +
          "...",
      );
    } catch (err) {
      this.log(`[Spawn] All strategies failed: ${err}`);
      vscode.window.showErrorMessage(
        "Failed to spawn. Open chat → Brain mode → say: Resume from TASK_QUEUE.md",
      );
    }
  }

  // ─── Prompt Builder ──────────────────────────────────────────────────

  private buildContinuationPrompt(opts: SpawnOptions): string {
    const parts: string[] = [
      "SESSION_SPAWN: Resume work from TASK_QUEUE.md.",
      `Reason: ${opts.reason}.`,
    ];

    if (opts.currentTask) {
      parts.push(`Task: ${opts.currentTask}.`);
    }

    if (opts.instructions) {
      parts.push(`Instructions: ${opts.instructions}`);
    }

    return parts.join(" ");
  }

  // ─── Quick Spawn (still requires confirmation form) ──────────────────

  async quickSpawn(
    reason?: string,
    task?: string,
    conversationSummary?: string,
  ): Promise<void> {
    await this.spawn({
      reason: reason || "Context window running low",
      currentTask: task || undefined,
      conversationSummary: conversationSummary || undefined,
      autoSubmit: true,
    });
  }

  // ─── Interactive Spawn (via Quick Pick) ──────────────────────────────

  async interactiveSpawn(): Promise<void> {
    const reason = await vscode.window.showQuickPick(
      [
        {
          label: "$(warning) Context window running low",
          value: "Context window running low",
        },
        {
          label: "$(split-horizontal) Switching task focus",
          value: "Switching to different task",
        },
        {
          label: "$(debug-restart) Clean restart",
          value: "Clean restart requested",
        },
        { label: "$(edit) Custom reason...", value: "__custom__" },
      ],
      {
        placeHolder: "Why spawn a new session?",
        title: "Project Brain: Spawn Session",
      },
    );

    if (!reason) return;

    let reasonText = (reason as { value: string }).value;
    if (reasonText === "__custom__") {
      const custom = await vscode.window.showInputBox({
        prompt: "Enter spawn reason",
      });
      if (!custom) return;
      reasonText = custom;
    }

    const task = await vscode.window.showInputBox({
      prompt: "What task should the new session continue? (optional)",
      placeHolder: "Describe the task or press Enter to skip",
    });

    await this.spawn({
      reason: reasonText,
      currentTask: task || undefined,
      autoSubmit: true,
    });
  }
}
