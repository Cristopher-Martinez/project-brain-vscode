/**
 * Learning Router — Secondary persistence for captured learnings.
 *
 * Companion to AutoCapture — handles file-level persistence to
 * 04_LEARNINGS.md and 05_TROUBLESHOOTING.md that OpinionBank doesn't cover.
 *
 * All auto-captured entries get `verified: false` to prevent
 * feedback loop poisoning (C3 from audit).
 */

import * as fs from "fs";
import * as path from "path";
import type { OpinionDomain } from "./opinion-types";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max size for memory files before rotation (500KB). */
const MEMORY_FILE_MAX_BYTES = 512_000;

/** Max entries to keep when rotating. */
const MEMORY_FILE_KEEP_ENTRIES = 200;

// ─── LearningRouter ────────────────────────────────────────────────────────

export class LearningRouter {
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  /** Route a captured learning to the appropriate memory file. */
  routeLearning(
    statement: string,
    domain: OpinionDomain,
    source: string,
  ): void {
    try {
      const entry = this.formatEntry(statement, domain, source);
      const targetFile = this.getTargetFile(domain);
      const filePath = path.join(this.memoryPath, targetFile);

      this.rotateIfNeeded(filePath);
      fs.appendFileSync(filePath, entry + "\n", "utf8");
    } catch (err) {
      this.log(`[LearningRouter] Write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Generate the knowledge summary file for hook injection.
   * Pre-computes a ~2KB summary from learnings + troubleshooting + prefs.
   */
  generateKnowledgeSummary(): void {
    try {
      const sessionsDir = path.join(this.memoryPath, "sessions");
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }

      const parts: string[] = [];

      // Programming prefs (small, always include)
      const prefsPath = path.join(this.memoryPath, "11_PROGRAMMING_PREFS.md");
      if (fs.existsSync(prefsPath)) {
        const prefs = fs.readFileSync(prefsPath, "utf8").slice(0, 600);
        if (prefs.trim()) parts.push(`## Preferences\n${prefs.trim()}`);
      }

      // Recent verified learnings (last 5 ## entries)
      const learningsPath = path.join(this.memoryPath, "04_LEARNINGS.md");
      if (fs.existsSync(learningsPath)) {
        const content = fs.readFileSync(learningsPath, "utf8");
        const sections = content.split(/^## /m).filter(Boolean);
        const verified = sections.filter((s) => !s.includes("verified: false"));
        const recent = (verified.length > 0 ? verified : sections).slice(-5);
        const compact = recent
          .map((s) => `• ${s.split("\n")[0]?.slice(0, 100) || ""}`)
          .join("\n");
        if (compact.trim()) parts.push(`## Recent Learnings\n${compact}`);
      }

      // Recent troubleshooting (last 3 ## entries)
      const troublePath = path.join(this.memoryPath, "05_TROUBLESHOOTING.md");
      if (fs.existsSync(troublePath)) {
        const content = fs.readFileSync(troublePath, "utf8");
        const sections = content.split(/^## /m).filter(Boolean).slice(-3);
        const compact = sections
          .map((s) => `• ${s.split("\n")[0]?.slice(0, 100) || ""}`)
          .join("\n");
        if (compact.trim()) parts.push(`## Known Issues\n${compact}`);
      }

      const summary = parts.join("\n\n").slice(0, 2000);
      const summaryPath = path.join(sessionsDir, "knowledge-summary.txt");
      fs.writeFileSync(summaryPath, summary, "utf8");
      this.log(
        `[LearningRouter] Knowledge summary generated (${summary.length} chars)`,
      );
    } catch (err) {
      this.log(
        `[LearningRouter] Summary generation failed: ${(err as Error).message}`,
      );
    }
  }

  private formatEntry(
    statement: string,
    domain: OpinionDomain,
    source: string,
  ): string {
    const date = new Date().toISOString().split("T")[0];
    return [
      `## ${statement.slice(0, 80)}`,
      `**Date**: ${date}  **Domain**: ${domain}  **Source**: ${source}  **verified**: false`,
      ``,
      statement,
      ``,
    ].join("\n");
  }

  private getTargetFile(domain: OpinionDomain): string {
    switch (domain) {
      case "debugging":
        return "05_TROUBLESHOOTING.md";
      case "architecture":
      case "patterns":
      case "tools":
      case "workflow":
      case "preferences":
        return "04_LEARNINGS.md";
      default:
        return "04_LEARNINGS.md";
    }
  }

  private rotateIfNeeded(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size < MEMORY_FILE_MAX_BYTES) return;

      const content = fs.readFileSync(filePath, "utf8");
      const sections = content.split(/^## /m);
      const header = sections[0] || "";
      const entries = sections.slice(1);

      if (entries.length <= MEMORY_FILE_KEEP_ENTRIES) return;

      const kept = entries.slice(-MEMORY_FILE_KEEP_ENTRIES);
      const rotated = header + kept.map((e) => `## ${e}`).join("");
      fs.writeFileSync(filePath, rotated, "utf8");
      this.log(
        `[LearningRouter] Rotated ${filePath}: ${entries.length} → ${kept.length} entries`,
      );
    } catch (err) {
      this.log(`[LearningRouter] Rotation failed: ${(err as Error).message}`);
    }
  }
}
