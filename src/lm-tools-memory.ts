/**
 * Memory-related LM Tools for Project Brain.
 *
 * Extracted from lm-tools.ts for modularity:
 * - GetProjectContextTool — reads memory files by aspect
 * - WriteProjectMemoryTool — appends to allowed memory files
 * - ListMemoryFilesTool — lists memory folder tree
 * - ListProjectsTool — lists indexed projects
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { SaaSClient } from "./saas-client";
import type { MemoryFS } from "./memory-fs";
import {
  buildTree,
  getHomeDir,
  getPreferenceHint,
  PLAN_RANK,
} from "./lm-tools-shared";

// ——— GetContext ——————————————————————————————————————————————————

export interface GetContextInput {
  aspect?: string;
}

export class GetProjectContextTool implements vscode.LanguageModelTool<GetContextInput> {
  private saasClient: SaaSClient | null = null;

  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  setSaaSClient(client: SaaSClient | null): void {
    this.saasClient = client;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetContextInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const aspect = options.input.aspect || "overview";
    this.log(`[LM Tool] getContext: "${aspect}"`);

    // Gate identity/soul aspects to Pro plan
    const PRO_ASPECTS = ["identity", "soul"];
    const currentPlan = this.saasClient?.currentPlan ?? "free";
    if (
      PRO_ASPECTS.includes(aspect.toLowerCase()) &&
      PLAN_RANK[currentPlan] < PLAN_RANK["pro"]
    ) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ Reading ${aspect} context requires Pro plan (current: ${currentPlan}). Upgrade at https://projectbrain.dev/pricing`,
        ),
      ]);
    }

    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const memoryPath = path.join(this.workspaceFolder.uri.fsPath, memoryFolder);

    const fileMap: Record<string, string> = {
      overview: "00_PROJECT_OVERVIEW.md",
      architecture: "01_ARCHITECTURE.md",
      code: "02_CODE_MAP.md",
      codemap: "02_CODE_MAP.md",
      dependencies: "03_DEPENDENCIES.md",
      learnings: "04_LEARNINGS.md",
      troubleshooting: "05_TROUBLESHOOTING.md",
      git: "06_GIT_INSIGHTS.md",
      session: "07_SESSION_HANDOFF.md",
      identity: "08_AGENT_IDENTITY.md",
      soul: "09_AGENT_SOUL.md",
      user: "10_USER_PROFILE.md",
      bootstrap: "11_BOOTSTRAP.md",
    };

    const targetFile = fileMap[aspect.toLowerCase()] || fileMap.overview;
    const filePath = path.join(memoryPath, targetFile);

    try {
      if (!fs.existsSync(filePath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Memory file not found: ${targetFile}. Run "Project Brain: Initialize" first.`,
          ),
        ]);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const truncated =
        content.length > 8000
          ? content.slice(0, 8000) + "\n\n...(truncated)"
          : content;

      // Phase 5: Inject user preferences for narrative content
      const prefHint = getPreferenceHint();
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(prefHint + truncated),
      ]);
    } catch (err) {
      this.log(`[LM Tool] getContext error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to read project context: ${err}`,
        ),
      ]);
    }
  }
}

// ——— WriteMemory ————————————————————————————————————————————————

export interface WriteMemoryInput {
  file: string;
  content: string;
}

export class WriteProjectMemoryTool implements vscode.LanguageModelTool<WriteMemoryInput> {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
    private memoryFSRef?: { get: () => MemoryFS | null },
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WriteMemoryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    // No confirmationMessages — auto-documentation must be frictionless.
    // Security: whitelist + injection sanitization in invoke() still protect writes.
    return {
      invocationMessage: `Writing to memory: ${options.input.file}`,
    };
  }

  /**
   * Record documentation timestamp for autohydrate gate.
   * Writes to all active loop session states so the gate recognizes the doc.
   */
  private recordDocForAutohydrate(wsRoot: string): void {
    try {
      const loopsDir = path.join(wsRoot, ".project-brain", "loops");
      if (!fs.existsSync(loopsDir)) return;
      // Update all active session states (we don't know which session is current)
      const entries = fs.readdirSync(loopsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const statePath = path.join(loopsDir, entry.name, "autohydrate-state.json");
        try {
          const defaults: Record<string, unknown> = { lastDocTs: null, triggerCount: 0, autohydrateBypass: false, consecutiveDenies: 0 };
          let state = defaults;
          if (fs.existsSync(statePath)) {
            state = { ...defaults, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
          }
          state.lastDocTs = Date.now();
          state.triggerCount = ((state.triggerCount as number) || 0) + 1;
          state.consecutiveDenies = 0;
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        } catch { /* skip individual sessions */ }
      }
      this.log("[LM Tool] writeMemory: recorded doc for autohydrate gate");
    } catch { /* non-fatal */ }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WriteMemoryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { file, content } = options.input;
    this.log(`[LM Tool] writeMemory: "${file}"`);

    const allowedFiles = [
      "01_ARCHITECTURE.md",
      "02_CODE_MAP.md",
      "03_DEPENDENCIES.md",
      "04_LEARNINGS.md",
      "05_TROUBLESHOOTING.md",
    ];

    if (!allowedFiles.includes(file)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Cannot write to "${file}". Allowed files: ${allowedFiles.join(", ")}`,
        ),
      ]);
    }

    // SECURITY (MED-05): Validate content for prompt injection patterns
    const injectionPatterns: RegExp[] = [
      /^(system|assistant|user)\s*:/gim,
      /\b(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?))/gi,
      /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you)/gi,
      /\b(override|bypass|disable|skip)\s+(security|auth|validation|checks?|rules?)/gi,
      /<\/?script\b[^>]*>/gi,
      /\beval\s*\(/gi,
      /\b(exec|execFile|spawn|fork)\s*\(/gi,
      /\bprocess\.env\b/gi,
    ];

    let sanitizedContent = content;
    for (const pattern of injectionPatterns) {
      sanitizedContent = sanitizedContent.replace(pattern, "[REDACTED]");
    }

    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const filePath = path.join(
      this.workspaceFolder.uri.fsPath,
      memoryFolder,
      file,
    );

    try {
      let existing = "";
      const memFS = this.memoryFSRef?.get();

      if (memFS) {
        // Cloud-aware: reads from cloud if file was evicted locally
        const read = await memFS.readFile(file);
        if (read !== null) {
          existing = read;
        }
      } else {
        // Fallback: direct fs (no cloud sync available)
        if (fs.existsSync(filePath)) {
          existing = fs.readFileSync(filePath, "utf-8");
        }
      }

      const marker = "<!-- Add new entries below this line, newest first -->";
      const markerIdx = existing.indexOf(marker);

      let newContent: string;
      if (markerIdx !== -1) {
        const insertAt = markerIdx + marker.length;
        newContent =
          existing.slice(0, insertAt) +
          "\n\n" +
          sanitizedContent +
          "\n" +
          existing.slice(insertAt);
      } else {
        newContent = existing.trimEnd() + "\n\n" + sanitizedContent + "\n";
      }

      if (memFS) {
        // Cloud-aware: writes locally + enqueues cloud upload
        await memFS.writeFile(file, newContent);
      } else {
        fs.writeFileSync(filePath, newContent, "utf-8");
      }
      this.log(`[LM Tool] writeMemory: wrote to ${file}`);

      // If writing to learnings/troubleshooting, record as documentation done
      // so the autohydrate gate recognizes it and allows synthesis.
      const docFiles = ["04_LEARNINGS.md", "05_TROUBLESHOOTING.md"];
      if (docFiles.includes(file)) {
        this.recordDocForAutohydrate(this.workspaceFolder.uri.fsPath);
      }

      const msg = `Successfully wrote documentation entry to ${file}.`;
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(msg),
      ]);
    } catch (err) {
      this.log(`[LM Tool] writeMemory error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to write: ${err}`),
      ]);
    }
  }
}

// ——— ListMemoryFiles ————————————————————————————————————————————

export class ListMemoryFilesTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    this.log(`[LM Tool] listMemoryFiles`);

    try {
      const config = vscode.workspace.getConfiguration("projectBrain");
      const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
      const memoryPath = path.join(
        this.workspaceFolder.uri.fsPath,
        memoryFolder,
      );

      if (!fs.existsSync(memoryPath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Memory folder not found: ${memoryFolder}. Run "Project Brain: Initialize" first.`,
          ),
        ]);
      }

      const tree = buildTree(memoryPath, "");
      const output = `## Memory Files\n\n\`\`\`\n${memoryFolder}/\n${tree}\`\`\``;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] listMemoryFiles error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error listing memory files: ${err}`),
      ]);
    }
  }
}

// ——— ListProjects ———————————————————————————————————————————————

export class ListProjectsTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(private log: (msg: string) => void) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    this.log(`[LM Tool] listProjects`);

    try {
      const homeDir = getHomeDir();
      const storageDir = path.join(homeDir, ".mcp-rag-docs");

      if (!fs.existsSync(storageDir)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            "No indexed projects found. Storage directory does not exist.",
          ),
        ]);
      }

      const files = fs
        .readdirSync(storageDir)
        .filter(
          (f) =>
            f.endsWith(".json") &&
            !f.endsWith(".graph.json") &&
            !f.endsWith(".history.json"),
        );

      if (files.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("No indexed projects found."),
        ]);
      }

      const lines = [`## Indexed Projects (${files.length})`, ``];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(storageDir, file), "utf-8");
          const index = JSON.parse(raw);
          const projPath = index.projectPath || "(unknown)";
          const chunks = index.chunks?.length ?? 0;
          const lastUpdated = index.lastUpdated
            ? new Date(index.lastUpdated).toISOString()
            : "unknown";
          lines.push(`### ${path.basename(file, ".json")}`);
          lines.push(`- **Path:** ${projPath}`);
          lines.push(`- **Chunks:** ${chunks}`);
          lines.push(`- **Last Updated:** ${lastUpdated}`);
          lines.push(``);
        } catch {
          lines.push(`### ${path.basename(file, ".json")}`);
          lines.push(`- ⚠️ Could not read index file`);
          lines.push(``);
        }
      }

      const output = lines.join("\n");
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(output),
      ]);
    } catch (err) {
      this.log(`[LM Tool] listProjects error: ${err}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error listing projects: ${err}`),
      ]);
    }
  }
}
