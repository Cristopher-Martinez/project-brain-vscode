/**
 * Skill Discovery LM Tool — extracted from lm-tools.ts
 *
 * FindSkillTool: Bridges SkillManager → Toolbox with fuzzy matching + graph boost
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AdminDB } from "./admin-db";
import {
  getHomeDir,
  getProjectIdForTools,
  graphBoostSkills,
  skillMatchScore,
  stemWord,
} from "./lm-tools-shared";
import type { SkillManager } from "./skill-manager";

// ═══════════════════════════════════════════════════════════════════════
// FIND SKILL TOOL (bridges SkillManager → Toolbox)
// ═══════════════════════════════════════════════════════════════════════

export interface FindSkillInput {
  query: string;
}

export class FindSkillTool implements vscode.LanguageModelTool<FindSkillInput> {
  private adminDbRef?: { get: () => AdminDB | null };

  constructor(
    private memoryPath: string,
    private extensionPath: string,
    private log: (msg: string) => void,
    private skillManagerRef?: { get: () => SkillManager | null },
  ) {}

  setAdminDbRef(ref: { get: () => AdminDB | null }): void {
    this.adminDbRef = ref;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindSkillInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const query = (options.input.query ?? "").toLowerCase().trim();
    if (!query) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Provide a query to search skills. Example: findSkill({ query: "deployment" })',
        ),
      ]);
    }

    this.log(`[LM Tool] findSkill: "${query}"`);

    // Split query into individual words for fuzzy matching
    const queryWords = query.split(/[\s\-_,]+/).filter((w) => w.length > 1);

    // Try SkillManager first (if initialized)
    const sm = this.skillManagerRef?.get();
    if (sm) {
      const all = sm.getAll();
      const scored = all
        .map((s) => {
          let score = 0;
          let coverage = 0;
          const name = s.manifest.name.toLowerCase();
          const desc = s.manifest.description.toLowerCase();
          for (const word of queryWords) {
            const ns = skillMatchScore(word, name, true);
            const ds = skillMatchScore(word, desc, false);
            score += ns + ds;
            if (ns > 0 || ds > 0) coverage++;
          }
          return { skill: s, score, coverage, graphBoost: 0 };
        })
        .filter((s) => s.score > 0);

      // Apply graph-based semantic boost before sorting
      const homeDir = getHomeDir();
      const projectPath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      if (homeDir && projectPath) {
        const projectId = getProjectIdForTools(projectPath);
        graphBoostSkills(scored, query, homeDir, projectId, this.log);
      }

      scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage);

      if (scored.length > 0) {
        // Lazy-load content for remote skills that have empty content
        const topMatches = scored.slice(0, 5);
        for (const match of topMatches) {
          if (
            match.skill.source === "remote" &&
            !match.skill.content &&
            sm.loadSkillContent
          ) {
            try {
              const loaded = await sm.loadSkillContent(
                match.skill.manifest.name,
              );
              if (loaded?.content) match.skill.content = loaded.content;
            } catch {
              /* skip — show description instead */
            }
          }
        }

        const results = topMatches.map((s) => {
          const content =
            s.skill.content ||
            `*Description:* ${s.skill.manifest.description}\n\n_(Remote skill — content requires installation)_`;
          return `## ${s.skill.manifest.name} (${s.skill.source})\n${content}`;
        });

        // Admin logging: log each matched skill
        const db = this.adminDbRef?.get();
        if (db) {
          for (const s of topMatches) {
            db.logExecution({
              skillName: s.skill.manifest.name,
              trigger: "findSkill",
              result: "found",
              matchScore: s.score,
              query,
            }).catch(() => {});
          }
        }

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Found ${scored.length} skill(s) matching "${query}":\n\n${results.join("\n\n---\n\n")}`,
          ),
        ]);
      }
    }

    // Fallback: direct filesystem scan (works without SaaS/SkillManager)
    const skillDirs = [
      path.join(this.memoryPath, "skills"),
      path.join(this.extensionPath, "static", "skills"),
    ];

    const found: {
      name: string;
      content: string;
      source: string;
      score: number;
    }[] = [];

    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      const source = dir.includes("static") ? "bundled" : "local";
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillPath = path.join(dir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillPath)) continue;

          const content = fs.readFileSync(skillPath, "utf-8");
          let nameScore = 0;
          let contentScore = 0;
          const nameLower = entry.name.toLowerCase();
          const contentLower = content.toLowerCase();
          for (const word of queryWords) {
            nameScore += skillMatchScore(word, nameLower, true);
            const stemmed = stemWord(word);
            if (contentLower.includes(word) || contentLower.includes(stemmed))
              contentScore++;
          }
          const score = nameScore + contentScore;

          if (score > 0) {
            found.push({ name: entry.name, content, source, score });
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    }

    found.sort((a, b) => b.score - a.score);

    if (found.length === 0) {
      // Admin logging: not found
      const db = this.adminDbRef?.get();
      if (db) {
        db.logExecution({
          skillName: query,
          trigger: "findSkill",
          result: "not_found",
          query,
        }).catch(() => {});
      }

      // Return available skill names for discovery
      const available: string[] = [];
      for (const dir of skillDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) available.push(entry.name);
          }
        } catch {
          /* skip */
        }
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No skills found for "${query}". Available skills:\n${available.map((s) => `- ${s}`).join("\n")}\n\nTry: findSkill({ query: "deploy" }) or findSkill({ query: "refactor" })`,
        ),
      ]);
    }

    const results = found
      .slice(0, 3)
      .map((s) => `## ${s.name} (${s.source})\n${s.content}`);

    // Admin logging: filesystem fallback found
    const db2 = this.adminDbRef?.get();
    if (db2) {
      for (const s of found.slice(0, 3)) {
        db2
          .logExecution({
            skillName: s.name,
            trigger: "findSkill",
            result: "found",
            matchScore: s.score,
            query,
          })
          .catch(() => {});
      }
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Found ${found.length} skill(s) matching "${query}":\n\n${results.join("\n\n---\n\n")}`,
      ),
    ]);
  }
}
