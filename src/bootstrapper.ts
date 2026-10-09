import * as vscode from "vscode";
import {
  AUTOGEN_END,
  AUTOGEN_START,
  MARKER_END,
  MARKER_START,
  TEMPLATES,
} from "./templates";

import type {
  AgentIdentity,
  AgentSoul,
  ProjectEssence,
  UserProfile,
} from "./agent-identity";
import {
  CodeIntelligenceAnalyzer,
  type CodeIntelligenceReport,
} from "./code-intelligence";
import type { GitInsights } from "./git-analyzer";
import { log } from "./logger";
import type { DetectedPatterns } from "./pattern-detector";

export interface ProjectDocs {
  overview: string;
  architecture: string;
  codeMap: string;
  dependencies: string[];
  projectType: string;
  gitInsights?: GitInsights;
  patterns?: DetectedPatterns;
  codeIntelligence?: CodeIntelligenceReport;
}

export class Bootstrapper {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private context: vscode.ExtensionContext,
  ) {}

  async hasMemoryStructure(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    // Check for BOOT.md marker — not just the directory.
    // ensureProjectBrainDirs() creates the empty dir on activation,
    // so checking the dir alone would always return true for new users.
    const bootPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      memoryFolder,
      "BOOT.md",
    );

    try {
      await vscode.workspace.fs.stat(bootPath);
      return true;
    } catch {
      // Fallback: check legacy docs/memory/BOOT.md for upgraded users
      if (memoryFolder !== "docs/memory") {
        const legacyBoot = vscode.Uri.joinPath(
          this.workspaceFolder.uri,
          "docs/memory",
          "BOOT.md",
        );
        try {
          await vscode.workspace.fs.stat(legacyBoot);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async createMemoryStructure(): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const memoryPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      memoryFolder,
    );

    // Create memory folder
    await vscode.workspace.fs.createDirectory(memoryPath);

    // Create archive folder
    const archivePath = vscode.Uri.joinPath(memoryPath, "archive");
    await vscode.workspace.fs.createDirectory(archivePath);

    // Create skills folder (agents create skills here at runtime)
    const skillsPath = vscode.Uri.joinPath(memoryPath, "skills");
    try {
      await vscode.workspace.fs.stat(skillsPath);
    } catch {
      await vscode.workspace.fs.createDirectory(skillsPath);
    }

    // Create agents diary folder (per-mode learning journals)
    const agentsPath = vscode.Uri.joinPath(memoryPath, "agents");
    try {
      await vscode.workspace.fs.stat(agentsPath);
    } catch {
      await vscode.workspace.fs.createDirectory(agentsPath);
    }

    // Create .vscode folder if not exists
    const vscodePath = vscode.Uri.joinPath(this.workspaceFolder.uri, ".vscode");
    try {
      await vscode.workspace.fs.stat(vscodePath);
    } catch {
      await vscode.workspace.fs.createDirectory(vscodePath);
    }

    log("Memory structure created");
  }

  /**
   * Non-destructive injection: if the file exists, only replace the
   * PROJECT_BRAIN section between markers. If markers don't exist yet,
   * append the section. If the file doesn't exist, create it.
   */
  private async injectOrCreate(
    fileUri: vscode.Uri,
    content: string,
  ): Promise<void> {
    let existing: string | null = null;
    try {
      const raw = await vscode.workspace.fs.readFile(fileUri);
      existing = Buffer.from(raw).toString("utf-8");
    } catch {
      // File doesn't exist — will create
    }

    if (existing === null) {
      // File doesn't exist → create with full content
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(content, "utf-8"),
      );
      return;
    }

    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Markers found → replace the section between them (inclusive)
      const before = existing.substring(0, startIdx);
      const after = existing.substring(endIdx + MARKER_END.length);
      const updated = before + content + after;
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(updated, "utf-8"),
      );
    } else {
      // File exists but no markers → append section at the end
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      const updated = existing + separator + content + "\n";
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(updated, "utf-8"),
      );
    }
  }

  /**
   * Progressive memory doc update: only replaces the auto-generated section
   * (between AUTOGEN_START / AUTOGEN_END markers) while preserving all user
   * content outside those markers. If the file doesn't exist, creates it
   * with the full template. If the file exists but has no markers (legacy),
   * replaces it with the full new template (one-time migration).
   * Always runs a deduplication pass to strip sections after AUTOGEN_END
   * that duplicate headings from inside the AUTOGEN block.
   */
  private async updateMemoryDoc(
    fileUri: vscode.Uri,
    newFullContent: string,
  ): Promise<void> {
    // Extract the auto-generated section from the new template
    const newAutoStart = newFullContent.indexOf(AUTOGEN_START);
    const newAutoEnd = newFullContent.indexOf(AUTOGEN_END);

    if (newAutoStart === -1 || newAutoEnd === -1) {
      // Template has no markers — fallback to full write
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(newFullContent, "utf-8"),
      );
      return;
    }

    const newAutoSection = newFullContent.substring(
      newAutoStart,
      newAutoEnd + AUTOGEN_END.length,
    );

    // Try to read existing file
    let existing: string | null = null;
    try {
      const raw = await vscode.workspace.fs.readFile(fileUri);
      existing = Buffer.from(raw).toString("utf-8");
    } catch {
      // File doesn't exist
    }

    if (existing === null) {
      // Create with full template (auto + user placeholder sections)
      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(newFullContent, "utf-8"),
      );
      return;
    }

    // Check if existing file has auto-generated markers
    const existAutoStart = existing.indexOf(AUTOGEN_START);
    const existAutoEnd = existing.indexOf(AUTOGEN_END);

    let updated: string;

    if (
      existAutoStart !== -1 &&
      existAutoEnd !== -1 &&
      existAutoEnd > existAutoStart
    ) {
      // Markers found → replace ONLY the auto section, preserve everything else
      const before = existing.substring(0, existAutoStart);
      const after = existing.substring(existAutoEnd + AUTOGEN_END.length);
      updated = before + newAutoSection + after;
      log(`Progressive update: ${fileUri.fsPath} (auto section replaced)`);
    } else {
      // Legacy file without markers → replace with full new template
      // (old file was fully auto-generated; one-time migration)
      updated = newFullContent;
      log(
        `Legacy migration: ${fileUri.fsPath} (replaced with marker-enabled template)`,
      );
    }

    // Deduplication pass: strip sections after AUTOGEN_END whose headings
    // duplicate content inside the AUTOGEN block (legacy migration artifact)
    updated = this.stripDuplicateContent(updated);

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, "utf-8"));
  }

  /**
   * Remove duplicate sections that appear after AUTOGEN_END but share
   * the same ## headings or **Key**: metadata as the auto-generated block.
   * This cleans up artifacts from the initial legacy migration.
   */
  private stripDuplicateContent(content: string): string {
    const autoStartIdx = content.indexOf(AUTOGEN_START);
    const autoEndIdx = content.indexOf(AUTOGEN_END);
    if (autoStartIdx === -1 || autoEndIdx === -1) {
      return content;
    }

    const autoContent = content.substring(
      autoStartIdx + AUTOGEN_START.length,
      autoEndIdx,
    );
    const beforeAuto = content.substring(0, autoEndIdx + AUTOGEN_END.length);
    const afterAuto = content.substring(autoEndIdx + AUTOGEN_END.length);

    if (!afterAuto.trim()) {
      return content; // Nothing after markers
    }

    // Collect ## headings from auto section
    const autoHeadings = new Set(
      [...autoContent.matchAll(/^(##\s+.+)/gm)].map((m) => m[1].trim()),
    );

    // Collect **Key**: metadata patterns from auto section
    const autoMetaKeys = new Set(
      [...autoContent.matchAll(/^\*\*([^*]+)\*\*:/gm)].map((m) => m[1].trim()),
    );

    if (autoHeadings.size === 0 && autoMetaKeys.size === 0) {
      return content;
    }

    // Split afterAuto into sections by ## headings
    const parts = afterAuto.split(/(?=\n##\s)/g);

    const kept: string[] = [];
    for (const part of parts) {
      const headingMatch = part.match(/^\n?(##\s+.+)/);
      if (headingMatch && autoHeadings.has(headingMatch[1].trim())) {
        continue; // Skip — duplicate of auto section
      }

      // For preamble/non-heading chunks, check if ALL significant lines
      // are duplicate metadata (e.g. **Tags**:, **Total commits**:)
      if (!headingMatch) {
        const lines = part.split("\n");
        const significantLines = lines.filter((l) => {
          const trimmed = l.trim();
          if (!trimmed) {
            return false;
          }
          // Check if line is a duplicate metadata key
          const metaMatch = trimmed.match(/^\*\*([^*]+)\*\*:/);
          if (metaMatch && autoMetaKeys.has(metaMatch[1].trim())) {
            return false;
          }
          // Check if line is *Auto-generated* footer
          if (trimmed.startsWith("*Auto-generated")) {
            return false;
          }
          // Check if line is just a horizontal rule
          if (trimmed === "---") {
            return false;
          }
          return true;
        });
        if (significantLines.length === 0) {
          continue; // All lines were duplicate metadata or boilerplate
        }
      }

      kept.push(part);
    }

    const result = beforeAuto + kept.join("");
    // Clean up excessive blank lines
    return result.replace(/\n{4,}/g, "\n\n\n");
  }

  /**
   * Generate all agent instruction files for maximum AI integration.
   * Uses non-destructive injection: existing user content is preserved,
   * only the Project Brain section is updated.
   *
   * Respects the `projectBrain.generateInstructionFiles` setting:
   * - "none": Skip all file generation outside .project-brain/
   * - "minimal": Only copilot-instructions.md + projectbrain.agent.md
   * - "full": All instruction files (current behavior)
   */
  async generateAgentInstructions(
    projectType: string,
    identity?: AgentIdentity | null,
    soul?: AgentSoul | null,
    user?: UserProfile | null,
    essence?: ProjectEssence | null,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const instrLevel = config.get<string>("generateInstructionFiles", "none");

    // "none" = skip all file generation outside .project-brain/
    if (instrLevel === "none") {
      log("Instruction file generation skipped (setting: none)");
      return;
    }

    // "full" generates everything; "minimal" skips root-level files
    const isFull = instrLevel === "full";

    // 1. AGENTS.md (root) — Generic agent instructions (full only)
    if (isFull) {
    const agentsPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      "AGENTS.md",
    );
    await this.injectOrCreate(
      agentsPath,
      TEMPLATES.AGENTS_MD(
        projectType,
        memoryFolder,
        identity,
        soul,
        user,
        essence,
      ),
    );
    } // end if (isFull) — AGENTS.md

    // 2. .github/copilot-instructions.md — Auto-injected by Copilot Chat
    const githubDir = vscode.Uri.joinPath(this.workspaceFolder.uri, ".github");
    try {
      await vscode.workspace.fs.stat(githubDir);
    } catch {
      await vscode.workspace.fs.createDirectory(githubDir);
    }
    const copilotPath = vscode.Uri.joinPath(
      githubDir,
      "copilot-instructions.md",
    );
    await this.injectOrCreate(
      copilotPath,
      TEMPLATES.COPILOT_INSTRUCTIONS(
        projectType,
        memoryFolder,
        identity,
        soul,
        user,
        essence,
      ),
    );

    // 2b. .github/brain.prompt.md — Custom Chat Mode (appears in mode dropdown)
    const brainPromptPath = vscode.Uri.joinPath(githubDir, "brain.prompt.md");
    // Only create if doesn't exist — preserve user's customizations
    try {
      await vscode.workspace.fs.stat(brainPromptPath);
      log("brain.prompt.md already exists — preserving user config");
    } catch {
      // File doesn't exist — create with template
      await vscode.workspace.fs.writeFile(
        brainPromptPath,
        Buffer.from(TEMPLATES.BRAIN_PROMPT(memoryFolder, identity), "utf-8"),
      );
      log("brain.prompt.md created with default prompt");
    }

    // 2c. .github/agents/projectbrain.agent.md — Agent Mode (full agent definition with tools)
    const agentsDir = vscode.Uri.joinPath(githubDir, "agents");
    try {
      await vscode.workspace.fs.stat(agentsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(agentsDir);
    }
    // Clean up old filename if it exists
    const oldBrainAgentPath = vscode.Uri.joinPath(agentsDir, "brain.agent.md");
    try {
      await vscode.workspace.fs.stat(oldBrainAgentPath);
      await vscode.workspace.fs.delete(oldBrainAgentPath);
    } catch {
      /* doesn't exist — fine */
    }
    const brainAgentPath = vscode.Uri.joinPath(
      agentsDir,
      "projectbrain.agent.md",
    );
    // Only create if doesn't exist — preserve user's tool configuration
    try {
      await vscode.workspace.fs.stat(brainAgentPath);
      log("projectbrain.agent.md already exists — preserving user config");
    } catch {
      // File doesn't exist — create with template
      await vscode.workspace.fs.writeFile(
        brainAgentPath,
        Buffer.from(TEMPLATES.BRAIN_AGENT(memoryFolder, identity), "utf-8"),
      );
      log("projectbrain.agent.md created with default tools");
    }

    // 3. CLAUDE.md — Claude Code / Claude AI instructions (full only)
    if (isFull) {
    const claudePath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      "CLAUDE.md",
    );
    await this.injectOrCreate(
      claudePath,
      TEMPLATES.CLAUDE_MD(
        projectType,
        memoryFolder,
        identity,
        soul,
        user,
        essence,
      ),
    );

    // 4. .cursorrules — Cursor IDE instructions
    const cursorPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ".cursorrules",
    );
    await this.injectOrCreate(
      cursorPath,
      TEMPLATES.CURSORRULES(
        projectType,
        memoryFolder,
        identity,
        soul,
        user,
        essence,
      ),
    );
    } // end if (isFull) — CLAUDE.md + .cursorrules

    log(
      "Agent instruction files generated/updated (non-destructive injection)",
    );

    // Deploy hooks, subagents, prompts, and skills from static/
    // Only in "full" mode — hooks pollute .github/ in shared repos
    if (isFull) {
      await this.generateHooksAndAssets();
    }
  }

  /**
   * Deploy hooks, subagents, prompts, and skills from the extension's
   * static/ directory into the target project.
   *
   * Hook scripts + libs go to .project-brain/hooks/ (contained).
   * hooks.json goes to .github/hooks/ (required for VS Code Copilot discovery).
   * Subagents, prompts, skills go to .github/ (required for VS Code discovery).
   *
   * - Hook scripts: always overwrite (extension-managed)
   * - hooks.json: smart merge (dedup by _source tag)
   * - Subagents, prompts, skills: create-only-if-not-exists
   */
  async generateHooksAndAssets(): Promise<void> {
    const extensionUri = vscode.Uri.file(this.context.extensionPath);
    const staticUri = vscode.Uri.joinPath(extensionUri, "static");
    const githubDir = vscode.Uri.joinPath(this.workspaceFolder.uri, ".github");
    const brainDir = vscode.Uri.joinPath(this.workspaceFolder.uri, ".project-brain");

    // Ensure .github exists (for agents/prompts/skills + hooks.json)
    try {
      await vscode.workspace.fs.stat(githubDir);
    } catch {
      await vscode.workspace.fs.createDirectory(githubDir);
    }

    // ─── Hooks (scripts to .project-brain/hooks/, manifest to .github/hooks/) ───
    const hooksDir = vscode.Uri.joinPath(brainDir, "hooks");
    const hooksScriptsDir = vscode.Uri.joinPath(hooksDir, "scripts");
    const githubHooksDir = vscode.Uri.joinPath(githubDir, "hooks");
    try {
      await vscode.workspace.fs.stat(hooksDir);
    } catch {
      await vscode.workspace.fs.createDirectory(hooksDir);
    }
    try {
      await vscode.workspace.fs.stat(hooksScriptsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(hooksScriptsDir);
    }
    try {
      await vscode.workspace.fs.stat(githubHooksDir);
    } catch {
      await vscode.workspace.fs.createDirectory(githubHooksDir);
    }

    // Copy hook scripts (always overwrite — hooks are extension-managed)
    const hookScripts = [
      "session-start.mjs",
      "session-stop.mjs",
      "pre-tool-security.mjs",
      "post-tool-capture.mjs",
      "pre-compact.mjs",
      "subagent-start.mjs",
      "subagent-stop.mjs",
      "user-prompt-writer.mjs",
    ];
    for (const script of hookScripts) {
      const srcUri = vscode.Uri.joinPath(
        staticUri,
        "hooks",
        "scripts",
        script,
      );
      const destUri = vscode.Uri.joinPath(hooksScriptsDir, script);
      try {
        const content = await vscode.workspace.fs.readFile(srcUri);
        await vscode.workspace.fs.writeFile(destUri, content);
      } catch {
        log(`[Bootstrapper] Warning: could not deploy hook ${script}`);
      }
    }

    // Copy hook libs (always overwrite — libs are internal, not user-customizable)
    await this.deployHookLibs(staticUri, hooksScriptsDir);

    // Deploy discipline.json (always overwrite — new rules must propagate on reload)
    const disciplineSrc = vscode.Uri.joinPath(staticUri, "hooks", "discipline.json");
    const disciplineDest = vscode.Uri.joinPath(hooksDir, "discipline.json");
    try {
      const dcContent = await vscode.workspace.fs.readFile(disciplineSrc);
      await vscode.workspace.fs.writeFile(disciplineDest, dcContent);
    } catch {
      log("[Bootstrapper] Warning: could not deploy discipline.json");
    }

    // Smart merge hooks.json → .github/hooks/ (VS Code Copilot reads from here)
    await this.mergeHooksJson(staticUri, githubHooksDir);

    // Deploy hooks-version.json (version marker for auto-update detection)
    const versionSrc = vscode.Uri.joinPath(staticUri, "hooks", "hooks-version.json");
    const versionDest = vscode.Uri.joinPath(hooksDir, "hooks-version.json");
    try {
      const vContent = await vscode.workspace.fs.readFile(versionSrc);
      await vscode.workspace.fs.writeFile(versionDest, vContent);
    } catch {
      log("[Bootstrapper] Warning: could not deploy hooks-version.json");
    }

    // ─── Subagents ───────────────────────────────────────────────────
    const agentsDir = vscode.Uri.joinPath(githubDir, "agents");
    try {
      await vscode.workspace.fs.stat(agentsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(agentsDir);
    }

    const subagents = [
      "researcher.agent.md",
      "documenter.agent.md",
      "reviewer.agent.md",
      "onboard.agent.md",
      "planner.agent.md",
    ];
    for (const agent of subagents) {
      const destUri = vscode.Uri.joinPath(agentsDir, agent);
      try {
        await vscode.workspace.fs.stat(destUri);
      } catch {
        const srcUri = vscode.Uri.joinPath(staticUri, "agents", agent);
        const content = await vscode.workspace.fs.readFile(srcUri);
        await vscode.workspace.fs.writeFile(destUri, content);
      }
    }

    // ─── Prompts ─────────────────────────────────────────────────────
    const promptsDir = vscode.Uri.joinPath(githubDir, "prompts");
    try {
      await vscode.workspace.fs.stat(promptsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(promptsDir);
    }

    const prompts = [
      "ask-project.prompt.md",
      "explain-this.prompt.md",
      "find-expert.prompt.md",
      "recall.prompt.md",
      "recap.prompt.md",
      "recent-changes.prompt.md",
      "status.prompt.md",
      "strategy.prompt.md",
      "teach.prompt.md",
    ];
    for (const prompt of prompts) {
      const destUri = vscode.Uri.joinPath(promptsDir, prompt);
      try {
        await vscode.workspace.fs.stat(destUri);
      } catch {
        const srcUri = vscode.Uri.joinPath(staticUri, "prompts", prompt);
        const content = await vscode.workspace.fs.readFile(srcUri);
        await vscode.workspace.fs.writeFile(destUri, content);
      }
    }

    // ─── Skills ──────────────────────────────────────────────────────
    const skillsDir = vscode.Uri.joinPath(githubDir, "skills");
    try {
      await vscode.workspace.fs.stat(skillsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(skillsDir);
    }

    const skills = [
      "orchestration-strategy",
      "project-status",
      "remember-this",
      "teach-brain",
      "what-changed",
    ];
    for (const skill of skills) {
      const skillDir = vscode.Uri.joinPath(skillsDir, skill);
      try {
        await vscode.workspace.fs.stat(skillDir);
      } catch {
        await vscode.workspace.fs.createDirectory(skillDir);
      }

      const destUri = vscode.Uri.joinPath(skillDir, "SKILL.md");
      try {
        await vscode.workspace.fs.stat(destUri);
      } catch {
        const srcUri = vscode.Uri.joinPath(
          staticUri,
          "skills",
          skill,
          "SKILL.md",
        );
        const content = await vscode.workspace.fs.readFile(srcUri);
        await vscode.workspace.fs.writeFile(destUri, content);
      }
    }

    // ─── Skill Discovery ─────────────────────────────────────────
    // Configure chat.agentSkillsLocations so VS Code discovers skills
    // in .project-brain/memory/skills/ (where agents create custom skills).
    await this.ensureSkillDiscovery();

    log("Hooks, agents, prompts, and skills deployed from static/");
  }

  /**
   * Ensure VS Code can discover skills in .project-brain/memory/skills/.
   *
   * VS Code only auto-discovers skills from default locations (.github/skills/,
   * .claude/skills/, .agents/skills/). Custom paths like .project-brain/memory/skills/
   * require the chat.agentSkillsLocations setting.
   *
   * Uses smart merge: adds our paths without removing user-added ones.
   */
  private async ensureSkillDiscovery(): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const skillsRelPath = `${memoryFolder}/skills`;

    const chatConfig = vscode.workspace.getConfiguration(
      "chat",
      this.workspaceFolder,
    );
    const raw = chatConfig.get("agentSkillsLocations");
    const existing: Array<{ path: string }> = Array.isArray(raw) ? raw : [];

    // Paths we need present
    const requiredPaths = [skillsRelPath, ".github/skills"];
    const existingPaths = new Set(
      existing.map((e) => e.path?.replace(/\\/g, "/") ?? ""),
    );

    const toAdd = requiredPaths.filter(
      (p) => !existingPaths.has(p.replace(/\\/g, "/")),
    );

    if (toAdd.length > 0) {
      const merged = [...existing, ...toAdd.map((p) => ({ path: p }))];
      try {
        await chatConfig.update(
          "agentSkillsLocations",
          merged,
          vscode.ConfigurationTarget.Workspace,
        );
      } catch {
        // Silently skip if setting is not writable in this context
      }
    }
  }

  /**
   * Deploy hook lib modules from static/ to project's .project-brain/hooks/scripts/lib/.
   * Always overwrites — libs are internal dependencies, not user-customizable.
   */
  private async deployHookLibs(
    staticUri: vscode.Uri,
    hooksScriptsDir: vscode.Uri,
  ): Promise<void> {
    const srcLibDir = vscode.Uri.joinPath(staticUri, "hooks", "scripts", "lib");
    const destLibDir = vscode.Uri.joinPath(hooksScriptsDir, "lib");

    // Ensure lib dir exists
    try {
      await vscode.workspace.fs.stat(destLibDir);
    } catch {
      await vscode.workspace.fs.createDirectory(destLibDir);
    }

    // Read all files from the static lib dir
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(srcLibDir);
    } catch {
      // No lib dir in static — nothing to deploy
      return;
    }

    for (const [name, fileType] of entries) {
      if (fileType !== vscode.FileType.File) {
        continue;
      }
      const srcUri = vscode.Uri.joinPath(srcLibDir, name);
      const destUri = vscode.Uri.joinPath(destLibDir, name);
      const content = await vscode.workspace.fs.readFile(srcUri);
      await vscode.workspace.fs.writeFile(destUri, content);
    }
  }

  /**
   * Smart merge hooks.json:
   * - No existing file → create from static
   * - Existing has _source "project-brain" → overwrite entirely (our file)
   * - Existing has different/no source → merge per-event, dedup our entries
   */
  private async mergeHooksJson(
    staticUri: vscode.Uri,
    hooksDir: vscode.Uri,
  ): Promise<void> {
    const destUri = vscode.Uri.joinPath(hooksDir, "hooks.json");
    const srcUri = vscode.Uri.joinPath(staticUri, "hooks", "hooks.json");
    const srcContent = await vscode.workspace.fs.readFile(srcUri);
    const srcJson = JSON.parse(Buffer.from(srcContent).toString("utf-8"));

    let existingJson: Record<string, unknown> | null = null;
    try {
      const raw = await vscode.workspace.fs.readFile(destUri);
      existingJson = JSON.parse(Buffer.from(raw).toString("utf-8"));
    } catch {
      // File doesn't exist
    }

    if (!existingJson) {
      // No existing file — write static version
      await vscode.workspace.fs.writeFile(destUri, srcContent);
      return;
    }

    if ((existingJson as Record<string, unknown>)._source === "project-brain") {
      // Our file — safe to overwrite entirely
      await vscode.workspace.fs.writeFile(destUri, srcContent);
      return;
    }

    // Third-party hooks.json — merge per event, avoiding duplicates
    const merged: Record<string, unknown> = { ...existingJson };
    const mergedHooks = (merged.hooks || {}) as Record<string, unknown[]>;
    for (const [event, entries] of Object.entries(
      (srcJson.hooks || {}) as Record<string, unknown[]>,
    )) {
      if (!mergedHooks[event]) {
        mergedHooks[event] = entries;
      } else {
        // Filter out existing project-brain entries, then add ours
        const filtered = mergedHooks[event].filter(
          (e: unknown) =>
            !(e as Record<string, string>).command?.includes(
              ".project-brain/hooks/scripts/",
            ) &&
            !(e as Record<string, string>).command?.includes(
              ".github/hooks/scripts/",
            ),
        );
        mergedHooks[event] = [...filtered, ...entries];
      }
    }
    merged.hooks = mergedHooks;

    await vscode.workspace.fs.writeFile(
      destUri,
      Buffer.from(JSON.stringify(merged, null, 2), "utf-8"),
    );
  }

  async generateInitialDocs(docs: ProjectDocs): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const memoryPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      memoryFolder,
    );

    // 00_PROJECT_OVERVIEW.md — enriched with git + patterns if available
    const overviewPath = vscode.Uri.joinPath(
      memoryPath,
      "00_PROJECT_OVERVIEW.md",
    );
    const overviewContent =
      docs.gitInsights || docs.patterns
        ? TEMPLATES.PROJECT_OVERVIEW_ENRICHED(
            docs.overview,
            docs.projectType,
            docs.gitInsights,
            docs.patterns,
          )
        : TEMPLATES.PROJECT_OVERVIEW(docs.overview, docs.projectType);
    await vscode.workspace.fs.writeFile(
      overviewPath,
      Buffer.from(overviewContent, "utf-8"),
    );

    // 01_ARCHITECTURE.md — enriched with patterns if available
    const archPath = vscode.Uri.joinPath(memoryPath, "01_ARCHITECTURE.md");
    const archContent = docs.patterns
      ? TEMPLATES.ARCHITECTURE_ENRICHED(docs.architecture, docs.patterns)
      : TEMPLATES.ARCHITECTURE(docs.architecture);
    await vscode.workspace.fs.writeFile(
      archPath,
      Buffer.from(archContent, "utf-8"),
    );

    // 02_CODE_MAP.md — enriched with hotspots if git available
    const codeMapPath = vscode.Uri.joinPath(memoryPath, "02_CODE_MAP.md");
    const codeMapContent = docs.gitInsights
      ? TEMPLATES.CODE_MAP_ENRICHED(docs.codeMap, docs.gitInsights)
      : TEMPLATES.CODE_MAP(docs.codeMap);
    await vscode.workspace.fs.writeFile(
      codeMapPath,
      Buffer.from(codeMapContent, "utf-8"),
    );

    // 03_DEPENDENCIES.md
    const depsPath = vscode.Uri.joinPath(memoryPath, "03_DEPENDENCIES.md");
    await vscode.workspace.fs.writeFile(
      depsPath,
      Buffer.from(TEMPLATES.DEPENDENCIES(docs.dependencies), "utf-8"),
    );

    // 04_LEARNINGS.md (only create if it doesn't exist — preserve user entries)
    const learningsPath = vscode.Uri.joinPath(memoryPath, "04_LEARNINGS.md");
    try {
      await vscode.workspace.fs.stat(learningsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        learningsPath,
        Buffer.from(TEMPLATES.LEARNINGS(), "utf-8"),
      );
    }

    // 05_TROUBLESHOOTING.md (only create if it doesn't exist — preserve user entries)
    const troubleshootingPath = vscode.Uri.joinPath(
      memoryPath,
      "05_TROUBLESHOOTING.md",
    );
    try {
      await vscode.workspace.fs.stat(troubleshootingPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        troubleshootingPath,
        Buffer.from(TEMPLATES.TROUBLESHOOTING(), "utf-8"),
      );
    }

    // 06_GIT_INSIGHTS.md — only if git analysis was performed
    if (docs.gitInsights) {
      const gitInsightsPath = vscode.Uri.joinPath(
        memoryPath,
        "06_GIT_INSIGHTS.md",
      );
      await vscode.workspace.fs.writeFile(
        gitInsightsPath,
        Buffer.from(TEMPLATES.GIT_INSIGHTS(docs.gitInsights), "utf-8"),
      );
    }

    // 07_CODE_INTELLIGENCE.md — only if code analysis was performed
    if (docs.codeIntelligence) {
      const codeIntelPath = vscode.Uri.joinPath(
        memoryPath,
        "07_CODE_INTELLIGENCE.md",
      );
      const analyzer = new CodeIntelligenceAnalyzer(this.workspaceFolder);
      const formatted = analyzer.formatReport(docs.codeIntelligence);
      await vscode.workspace.fs.writeFile(
        codeIntelPath,
        Buffer.from(
          TEMPLATES.CODE_INTELLIGENCE(docs.codeIntelligence, formatted),
          "utf-8",
        ),
      );
    }

    // BOOT.md (only create if it doesn't exist — preserve user content)
    const bootPath = vscode.Uri.joinPath(memoryPath, "BOOT.md");
    try {
      await vscode.workspace.fs.stat(bootPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        bootPath,
        Buffer.from(TEMPLATES.BOOT_MD(docs.projectType), "utf-8"),
      );
    }

    // TASK_QUEUE.md (only create if it doesn't exist)
    const taskQueuePath = vscode.Uri.joinPath(memoryPath, "TASK_QUEUE.md");
    try {
      await vscode.workspace.fs.stat(taskQueuePath);
    } catch {
      await vscode.workspace.fs.writeFile(
        taskQueuePath,
        Buffer.from(TEMPLATES.TASK_QUEUE_MD(), "utf-8"),
      );
    }

    // 11_PROGRAMMING_PREFS.md (only create if it doesn't exist — agent fills over time)
    const prefsPath = vscode.Uri.joinPath(
      memoryPath,
      "11_PROGRAMMING_PREFS.md",
    );
    try {
      await vscode.workspace.fs.stat(prefsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        prefsPath,
        Buffer.from(TEMPLATES.PROGRAMMING_PREFS(), "utf-8"),
      );
    }

    // 13_ADR.md (only create if it doesn't exist — agent populates decisions)
    const adrPath = vscode.Uri.joinPath(memoryPath, "13_ADR.md");
    try {
      await vscode.workspace.fs.stat(adrPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        adrPath,
        Buffer.from(TEMPLATES.ADR(), "utf-8"),
      );
    }

    // 13_ERROR_INDEX.md (only create if it doesn't exist — agent catalogs errors)
    const errorIndexPath = vscode.Uri.joinPath(memoryPath, "13_ERROR_INDEX.md");
    try {
      await vscode.workspace.fs.stat(errorIndexPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        errorIndexPath,
        Buffer.from(TEMPLATES.ERROR_INDEX(), "utf-8"),
      );
    }

    // 15_BACKLOG.md (only create if it doesn't exist — user manages priorities)
    const backlogPath = vscode.Uri.joinPath(memoryPath, "15_BACKLOG.md");
    try {
      await vscode.workspace.fs.stat(backlogPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        backlogPath,
        Buffer.from(TEMPLATES.BACKLOG(), "utf-8"),
      );
    }

    // 14_OPINIONS.md (only create if it doesn't exist — OpinionBank populates)
    const opinionsPath = vscode.Uri.joinPath(memoryPath, "14_OPINIONS.md");
    try {
      await vscode.workspace.fs.stat(opinionsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        opinionsPath,
        Buffer.from(TEMPLATES.OPINIONS(), "utf-8"),
      );
    }

    // 12_API_REFERENCE.md (only create if it doesn't exist — scanner populates)
    const apiRefPath = vscode.Uri.joinPath(memoryPath, "12_API_REFERENCE.md");
    try {
      await vscode.workspace.fs.stat(apiRefPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        apiRefPath,
        Buffer.from(TEMPLATES.API_REFERENCE(), "utf-8"),
      );
    }

    // 16_SESSION_DIARY.md (only create if it doesn't exist — agent logs sessions)
    const diaryPath = vscode.Uri.joinPath(memoryPath, "16_SESSION_DIARY.md");
    try {
      await vscode.workspace.fs.stat(diaryPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        diaryPath,
        Buffer.from(TEMPLATES.SESSION_DIARY(), "utf-8"),
      );
    }

    // pipeline-config.json (only create if it doesn't exist — hooks auto-refresh commands)
    const pipelineConfigPath = vscode.Uri.joinPath(
      memoryPath,
      "pipeline-config.json",
    );
    try {
      await vscode.workspace.fs.stat(pipelineConfigPath);
    } catch {
      const pipelineConfig = this.buildInitialPipelineConfig();
      await vscode.workspace.fs.writeFile(
        pipelineConfigPath,
        Buffer.from(JSON.stringify(pipelineConfig, null, 2) + "\n", "utf-8"),
      );
    }

    log("Initial documentation generated");
  }

  /**
   * Build a starter pipeline-config.json.
   * Commands are auto-detected by hooks on each session start via
   * refreshPipelineCommands(). This just seeds the structure.
   */
  private buildInitialPipelineConfig(): Record<string, unknown> {
    return {
      version: 1,
      commands: { build: "", deploy: "", test: "" },
      gapAction: { onBuild: "warn", onDeploy: "deny" },
      pipelines: [],
    };
  }

  async updateDocs(docs: ProjectDocs): Promise<void> {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const memoryPath = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      memoryFolder,
    );

    // Progressive update: only the auto-generated sections are replaced.
    // All user-written content outside AUTOGEN markers is preserved.

    // 00_PROJECT_OVERVIEW.md
    const overviewPath = vscode.Uri.joinPath(
      memoryPath,
      "00_PROJECT_OVERVIEW.md",
    );
    const overviewContent =
      docs.gitInsights || docs.patterns
        ? TEMPLATES.PROJECT_OVERVIEW_ENRICHED(
            docs.overview,
            docs.projectType,
            docs.gitInsights,
            docs.patterns,
          )
        : TEMPLATES.PROJECT_OVERVIEW(docs.overview, docs.projectType);
    await this.updateMemoryDoc(overviewPath, overviewContent);

    // 01_ARCHITECTURE.md
    const archPath = vscode.Uri.joinPath(memoryPath, "01_ARCHITECTURE.md");
    const archContent = docs.patterns
      ? TEMPLATES.ARCHITECTURE_ENRICHED(docs.architecture, docs.patterns)
      : TEMPLATES.ARCHITECTURE(docs.architecture);
    await this.updateMemoryDoc(archPath, archContent);

    // 02_CODE_MAP.md
    const codeMapPath = vscode.Uri.joinPath(memoryPath, "02_CODE_MAP.md");
    const codeMapContent = docs.gitInsights
      ? TEMPLATES.CODE_MAP_ENRICHED(docs.codeMap, docs.gitInsights)
      : TEMPLATES.CODE_MAP(docs.codeMap);
    await this.updateMemoryDoc(codeMapPath, codeMapContent);

    // 03_DEPENDENCIES.md
    const depsPath = vscode.Uri.joinPath(memoryPath, "03_DEPENDENCIES.md");
    await this.updateMemoryDoc(
      depsPath,
      TEMPLATES.DEPENDENCIES(docs.dependencies),
    );

    // 06_GIT_INSIGHTS.md — only if git analysis was performed
    if (docs.gitInsights) {
      const gitInsightsPath = vscode.Uri.joinPath(
        memoryPath,
        "06_GIT_INSIGHTS.md",
      );
      await this.updateMemoryDoc(
        gitInsightsPath,
        TEMPLATES.GIT_INSIGHTS(docs.gitInsights),
      );
    }

    // 07_CODE_INTELLIGENCE.md — only if code analysis was performed
    if (docs.codeIntelligence) {
      const codeIntelPath = vscode.Uri.joinPath(
        memoryPath,
        "07_CODE_INTELLIGENCE.md",
      );
      const analyzer = new CodeIntelligenceAnalyzer(this.workspaceFolder);
      const formatted = analyzer.formatReport(docs.codeIntelligence);
      await this.updateMemoryDoc(
        codeIntelPath,
        TEMPLATES.CODE_INTELLIGENCE(docs.codeIntelligence, formatted),
      );
    }

    // 04_LEARNINGS.md and 05_TROUBLESHOOTING.md are NEVER overwritten
    // (create only if they don't exist)
    const learningsPath = vscode.Uri.joinPath(memoryPath, "04_LEARNINGS.md");
    try {
      await vscode.workspace.fs.stat(learningsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        learningsPath,
        Buffer.from(TEMPLATES.LEARNINGS(), "utf-8"),
      );
    }

    const troubleshootingPath = vscode.Uri.joinPath(
      memoryPath,
      "05_TROUBLESHOOTING.md",
    );
    try {
      await vscode.workspace.fs.stat(troubleshootingPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        troubleshootingPath,
        Buffer.from(TEMPLATES.TROUBLESHOOTING(), "utf-8"),
      );
    }

    // 11_PROGRAMMING_PREFS.md (create if missing)
    const prefsPath = vscode.Uri.joinPath(
      memoryPath,
      "11_PROGRAMMING_PREFS.md",
    );
    try {
      await vscode.workspace.fs.stat(prefsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        prefsPath,
        Buffer.from(TEMPLATES.PROGRAMMING_PREFS(), "utf-8"),
      );
    }

    // 13_ADR.md (create if missing)
    const adrPath = vscode.Uri.joinPath(memoryPath, "13_ADR.md");
    try {
      await vscode.workspace.fs.stat(adrPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        adrPath,
        Buffer.from(TEMPLATES.ADR(), "utf-8"),
      );
    }

    // 13_ERROR_INDEX.md (create if missing)
    const errorIndexPath = vscode.Uri.joinPath(memoryPath, "13_ERROR_INDEX.md");
    try {
      await vscode.workspace.fs.stat(errorIndexPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        errorIndexPath,
        Buffer.from(TEMPLATES.ERROR_INDEX(), "utf-8"),
      );
    }

    // 15_BACKLOG.md (create if missing)
    const backlogPath = vscode.Uri.joinPath(memoryPath, "15_BACKLOG.md");
    try {
      await vscode.workspace.fs.stat(backlogPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        backlogPath,
        Buffer.from(TEMPLATES.BACKLOG(), "utf-8"),
      );
    }

    // 14_OPINIONS.md (create if missing — OpinionBank populates)
    const opinionsPath = vscode.Uri.joinPath(memoryPath, "14_OPINIONS.md");
    try {
      await vscode.workspace.fs.stat(opinionsPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        opinionsPath,
        Buffer.from(TEMPLATES.OPINIONS(), "utf-8"),
      );
    }

    // 12_API_REFERENCE.md (create if missing — scanner populates)
    const apiRefPath = vscode.Uri.joinPath(memoryPath, "12_API_REFERENCE.md");
    try {
      await vscode.workspace.fs.stat(apiRefPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        apiRefPath,
        Buffer.from(TEMPLATES.API_REFERENCE(), "utf-8"),
      );
    }

    // 16_SESSION_DIARY.md (create if missing — agent logs sessions)
    const diaryPath = vscode.Uri.joinPath(memoryPath, "16_SESSION_DIARY.md");
    try {
      await vscode.workspace.fs.stat(diaryPath);
    } catch {
      await vscode.workspace.fs.writeFile(
        diaryPath,
        Buffer.from(TEMPLATES.SESSION_DIARY(), "utf-8"),
      );
    }

    log("Documentation updated progressively (user entries preserved)");
  }
}
