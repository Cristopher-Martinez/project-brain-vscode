import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AutoCapture } from "./auto-capture";
import type { SessionDB } from "./session-db";
import {
  PENDING_FILE,
  buildSessionContext,
  buildSummarizationMessages,
  writePendingContext,
  type PendingSession,
} from "./session-summarizer-helpers";

// ─── Session Summarizer ─────────────────────────────────────────────────
// Uses VS Code's Language Model API (Copilot) to summarize sessions.
// No external dependencies — works with whatever Copilot model the user has.
//
// Flow:
// 1. session-stop hook writes `.session-pending.json` with raw context
// 2. On next activation, SessionSummarizer picks it up
// 3. Calls vscode.lm (gpt-4o-mini) for structured summary
// 4. Writes results to 04_LEARNINGS.md + sessions/
// 5. Deletes the pending file
// ─────────────────────────────────────────────────────────────────────────

export class SessionSummarizer {
  private memoryPath: string;
  private workspacePath: string;
  private autoCapture: AutoCapture | null;
  private sessionDbRef: { get: () => SessionDB | null } | null;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
    autoCapture?: AutoCapture | null,
    sessionDbRef?: { get: () => SessionDB | null } | null,
  ) {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>(
      "memoryFolder",
      ".project-brain/memory",
    );
    this.workspacePath = workspaceFolder.uri.fsPath;
    this.memoryPath = path.join(this.workspacePath, memoryFolder);
    this.autoCapture = autoCapture ?? null;
    this.sessionDbRef = sessionDbRef ?? null;
  }

  /**
   * Check for pending session and summarize if found.
   * Call this on extension activation.
   */
  async checkAndSummarize(): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    if (!config.get<boolean>("sessionSummary", true)) {
      this.log("[SessionSummarizer] Disabled via settings");
      return;
    }

    const pendingPath = path.join(this.memoryPath, PENDING_FILE);
    if (!fs.existsSync(pendingPath)) {
      return; // No pending session — nothing to do
    }

    this.log(
      "[SessionSummarizer] Found pending session — starting summarization",
    );

    try {
      const raw = fs.readFileSync(pendingPath, "utf8");
      const pending: PendingSession = JSON.parse(raw);

      const summary = await this.summarize(pending);
      if (summary) {
        await this.saveResults(pending, summary);
        this.log("[SessionSummarizer] Summary saved successfully");
      } else {
        this.log(
          "[SessionSummarizer] No summary generated (model unavailable or empty response)",
        );
      }

      // Delete pending file regardless — don't re-process
      fs.unlinkSync(pendingPath);
    } catch (e) {
      this.log(`[SessionSummarizer] Error: ${e}`);
      // Delete the pending file to avoid infinite retry loops
      try {
        fs.unlinkSync(pendingPath);
      } catch {
        /* ignore */
      }
    }
  }

  /** Delegates to standalone helper (backward-compat for static callers). */
  static writePendingContext(memoryPath: string, cwd: string): void {
    writePendingContext(memoryPath, cwd);
  }

  /**
   * Use vscode.lm (Copilot) to generate a structured session summary.
   */
  private async summarize(pending: PendingSession): Promise<string | null> {
    // Select a lightweight model — gpt-4o-mini is fast and cheap
    let models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o-mini",
    });

    // Fallback: try any copilot model
    if (!models.length) {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    }

    if (!models.length) {
      this.log("[SessionSummarizer] No Copilot models available");
      return null;
    }

    const model = models[0];
    this.log(
      `[SessionSummarizer] Using model: ${model.name} (${model.family})`,
    );

    const context = buildSessionContext(this.memoryPath, this.log, pending);
    const messages = buildSummarizationMessages(context, this.memoryPath);

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      // Auto-cancel after 60s
      const timer = setTimeout(() => tokenSource.cancel(), 60000);

      const response = await model.sendRequest(messages, {}, tokenSource.token);

      let result = "";
      for await (const fragment of response.text) {
        result += fragment;
      }

      clearTimeout(timer);
      tokenSource.dispose();

      return result.trim() || null;
    } catch (e) {
      if (e instanceof vscode.LanguageModelError) {
        this.log(`[SessionSummarizer] LM Error: ${e.message} (${e.code})`);
      } else {
        this.log(`[SessionSummarizer] Request error: ${e}`);
      }
      return null;
    }
  }

  /**
   * Save the AI-generated summary to memory files.
   */
  private async waitForSessionDb(
    timeoutMs = 10_000,
    pollMs = 250,
  ): Promise<SessionDB | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const db = this.sessionDbRef?.get() ?? null;
      if (db) return db;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  private async saveResults(
    pending: PendingSession,
    summary: string,
  ): Promise<void> {
    const dateStr = pending.date
      .slice(0, 16)
      .replace("T", "_")
      .replace(":", "-");

    // 1. Save full session summary to sessions/
    const sessionsDir = path.join(this.memoryPath, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const sessionFile = [
      `# Session Summary — ${dateStr}`,
      "",
      `**Branch**: \`${pending.branch}\``,
      `**Commit**: \`${pending.lastCommit}\``,
      `**Summarized by**: Copilot (vscode.lm)`,
      "",
      "---",
      "",
      summary,
      "",
    ].join("\n");

    // Write to SQLite if available, otherwise fallback to .md file
    let sessionDb = this.sessionDbRef?.get() ?? null;
    if (!sessionDb) {
      this.log(
        "[SessionSummarizer] SessionDB not ready yet; waiting briefly before falling back to .md",
      );
      sessionDb = await this.waitForSessionDb();
    }
    if (sessionDb) {
      try {
        await sessionDb.saveSummary({
          date: pending.date,
          branch: pending.branch,
          lastCommit: pending.lastCommit,
          summaryMarkdown: sessionFile,
        });
        this.log(`[SessionSummarizer] Saved summary to SQLite (${dateStr})`);
      } catch (e) {
        this.log(
          `[SessionSummarizer] SQLite save failed, falling back to .md: ${e}`,
        );
        fs.writeFileSync(
          path.join(sessionsDir, `${dateStr}-summary.md`),
          sessionFile,
          "utf8",
        );
      }
    } else {
      fs.writeFileSync(
        path.join(sessionsDir, `${dateStr}-summary.md`),
        sessionFile,
        "utf8",
      );
    }

    // 2. Extract learnings and append to 04_LEARNINGS.md
    // Match both ES and EN headers from bilingual LLM output
    const learningsMatch = summary.match(
      /## (?:Aprendizajes|Learnings)\n([\s\S]*?)(?=\n## |$)/,
    );
    const decisionsMatch = summary.match(
      /## (?:Decisiones Tomadas|Decisions Made)\n([\s\S]*?)(?=\n## |$)/,
    );
    const errorsMatch = summary.match(
      /## (?:Errores Resueltos|Errors Resolved)\n([\s\S]*?)(?=\n## |$)/,
    );

    const hasContent = learningsMatch || decisionsMatch || errorsMatch;
    if (hasContent) {
      const entry = [
        "",
        `## Auto-Summary (${dateStr})`,
        "",
        `**Date**: ${pending.date.slice(0, 10)}`,
        `**Tags**: auto-summary, session-end, ${pending.branch}`,
        `**Category**: process`,
        "",
      ];

      if (learningsMatch?.[1]?.trim()) {
        entry.push(`### Learnings`, learningsMatch[1].trim(), "");
      }
      if (decisionsMatch?.[1]?.trim()) {
        entry.push(`### Decisions`, decisionsMatch[1].trim(), "");
      }
      if (errorsMatch?.[1]?.trim()) {
        entry.push(`### Errors Resolved`, errorsMatch[1].trim(), "");
      }

      const learningsPath = path.join(this.memoryPath, "04_LEARNINGS.md");
      if (fs.existsSync(learningsPath)) {
        const content = fs.readFileSync(learningsPath, "utf8");
        // Insert after the header section
        const secondH2 = content.indexOf("\n## ", content.indexOf("\n## ") + 1);
        if (secondH2 > 0) {
          const updated =
            content.slice(0, secondH2) +
            "\n" +
            entry.join("\n") +
            "\n" +
            content.slice(secondH2);
          fs.writeFileSync(learningsPath, updated, "utf8");
        } else {
          fs.appendFileSync(learningsPath, entry.join("\n") + "\n", "utf8");
        }
      }
    }

    // 3. Append considerations to 05_TROUBLESHOOTING.md
    const considerationsMatch = summary.match(
      /## (?:Consideraciones|Considerations)\n([\s\S]*?)(?=\n## |$)/,
    );
    if (considerationsMatch?.[1]?.trim()) {
      const tsPath = path.join(this.memoryPath, "05_TROUBLESHOOTING.md");
      if (fs.existsSync(tsPath)) {
        const note = `\n## Session Considerations (${dateStr})\n\n${considerationsMatch[1].trim()}\n`;
        fs.appendFileSync(tsPath, note, "utf8");
      }
    }

    // 4. Feed learnings/decisions to OpinionBank via AutoCapture
    if (this.autoCapture) {
      const sections = [
        learningsMatch?.[1],
        decisionsMatch?.[1],
        errorsMatch?.[1],
      ].filter(Boolean);
      for (const section of sections) {
        if (section && section.trim().length >= 15) {
          await this.autoCapture.capture(section.trim(), "session-summary");
        }
      }
      this.log(
        `[SessionSummarizer] Fed ${sections.length} sections to AutoCapture for OpinionBank`,
      );
    }
  }
}
