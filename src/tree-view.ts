import * as path from "path";
import * as vscode from "vscode";
import { listCronJobs, type CronJob } from "./cron-engine";
import type { McpGateway } from "./mcp-gateway";
import { isWorkspaceEnabled } from "./project-lifecycle-utils";
import { getSLState, onDidChangeSLState } from "./self-learning-state";
import { getSwarmState, onDidChangeSwarmState } from "./swarm-state";

// ─── Tree Items ──────────────────────────────────────────────────────────────

export class BrainTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType:
      | "status"
      | "doc"
      | "section"
      | "action"
      | "ecosystem"
      | "reminder",
    public readonly contextValue?: string,
    public readonly cronJobId?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue || itemType;
  }
}

// ─── Memory doc descriptor ───────────────────────────────────────────────────

interface MemoryDocInfo {
  filename: string;
  label: string;
  icon: string;
  description: string;
}

const MEMORY_DOCS_MAP = new Map<string, MemoryDocInfo>([
  ["00_PROJECT_OVERVIEW.md", { filename: "00_PROJECT_OVERVIEW.md", label: "Project Overview", icon: "file-text", description: "What this project does" }],
  ["01_ARCHITECTURE.md", { filename: "01_ARCHITECTURE.md", label: "Architecture", icon: "symbol-structure", description: "How it's built" }],
  ["02_CODE_MAP.md", { filename: "02_CODE_MAP.md", label: "Code Map", icon: "map", description: "Where things are" }],
  ["03_DEPENDENCIES.md", { filename: "03_DEPENDENCIES.md", label: "Dependencies", icon: "package", description: "What it uses" }],
  ["04_LEARNINGS.md", { filename: "04_LEARNINGS.md", label: "Learnings", icon: "mortar-board", description: "Lessons learned" }],
  ["05_TROUBLESHOOTING.md", { filename: "05_TROUBLESHOOTING.md", label: "Troubleshooting", icon: "bug", description: "Past issues & fixes" }],
  ["06_GIT_INSIGHTS.md", { filename: "06_GIT_INSIGHTS.md", label: "Git Insights", icon: "git-commit", description: "Git history & hotspots" }],
  ["07_CODE_INTELLIGENCE.md", { filename: "07_CODE_INTELLIGENCE.md", label: "Code Intelligence", icon: "symbol-class", description: "Semantic analysis" }],
  ["07_SESSION_HANDOFF.md", { filename: "07_SESSION_HANDOFF.md", label: "Session Handoff", icon: "history", description: "Last session state" }],
  ["08_AGENT_IDENTITY.md", { filename: "08_AGENT_IDENTITY.md", label: "Agent Identity", icon: "person", description: "Agent persona config" }],
  ["09_AGENT_SOUL.md", { filename: "09_AGENT_SOUL.md", label: "Agent Soul", icon: "heart", description: "Tone & behavior rules" }],
  ["10_USER_PROFILE.md", { filename: "10_USER_PROFILE.md", label: "User Profile", icon: "account", description: "User preferences" }],
  ["11_PROGRAMMING_PREFS.md", { filename: "11_PROGRAMMING_PREFS.md", label: "Programming Prefs", icon: "code", description: "Coding conventions" }],
  ["12_API_REFERENCE.md", { filename: "12_API_REFERENCE.md", label: "API Reference", icon: "references", description: "API documentation" }],
  ["13_ADR.md", { filename: "13_ADR.md", label: "ADR", icon: "milestone", description: "Architecture decisions" }],
  ["13_ERROR_INDEX.md", { filename: "13_ERROR_INDEX.md", label: "Error Index", icon: "warning", description: "Known error patterns" }],
  ["14_OPINIONS.md", { filename: "14_OPINIONS.md", label: "Opinions", icon: "comment-discussion", description: "Agent opinions & confidence" }],
  ["15_BACKLOG.md", { filename: "15_BACKLOG.md", label: "Backlog", icon: "checklist", description: "Task backlog" }],
  ["16_SESSION_DIARY.md", { filename: "16_SESSION_DIARY.md", label: "Session Diary", icon: "notebook", description: "Session log" }],
  ["BOOT.md", { filename: "BOOT.md", label: "Boot", icon: "rocket", description: "Ultra-compact project snapshot" }],
  ["TASK_QUEUE.md", { filename: "TASK_QUEUE.md", label: "Task Queue", icon: "tasklist", description: "Pending tasks" }],
  ["SKILLS_CATALOG.md", { filename: "SKILLS_CATALOG.md", label: "Skills Catalog", icon: "book", description: "Available skills index" }],
]);

/** Auto-generate a label from a filename like "04_LEARNINGS_ARCHIVE.md" → "Learnings Archive" */
function labelFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/^\d+_/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Known folder icons for subdirectories inside .project-brain/memory/ */
const MEMORY_FOLDER_ICONS: Record<string, string> = {
  skills: "lightbulb",
  sessions: "clock",
  conversations: "comment-discussion",
  reports: "graph",
};

// ─── Data Provider ───────────────────────────────────────────────────────────

export class BrainTreeDataProvider implements vscode.TreeDataProvider<BrainTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    BrainTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private memoryActive = false;
  private ragReady = false;
  private autoVecActive = false;
  private isAdmin = false;
  private indexStats: {
    chunks: number;
    files: number;
    lastUpdated: number;
  } | null = null;
  private workspaceFolder: vscode.WorkspaceFolder | undefined;
  private disposables: vscode.Disposable[] = [];
  private gateway: McpGateway | null = null;

  constructor() {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    this.disposables.push(
      onDidChangeSwarmState(() => {
        this.refresh();
      }),
      onDidChangeSLState(() => {
        this.refresh();
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setGatewayRef(gw: McpGateway | null): void {
    this.gateway = gw;
    this.refresh();
  }

  updateStatus(opts: {
    memoryActive?: boolean;
    ragReady?: boolean;
    autoVecActive?: boolean;
    isAdmin?: boolean;
    indexStats?: { chunks: number; files: number; lastUpdated: number } | null;
    workspaceFolder?: vscode.WorkspaceFolder;
  }): void {
    if (opts.memoryActive !== undefined) this.memoryActive = opts.memoryActive;
    if (opts.ragReady !== undefined) this.ragReady = opts.ragReady;
    if (opts.autoVecActive !== undefined)
      this.autoVecActive = opts.autoVecActive;
    if (opts.isAdmin !== undefined) this.isAdmin = opts.isAdmin;
    if (opts.indexStats !== undefined) this.indexStats = opts.indexStats;
    if (opts.workspaceFolder) this.workspaceFolder = opts.workspaceFolder;
    this.refresh();
  }

  getTreeItem(element: BrainTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BrainTreeItem): Promise<BrainTreeItem[]> {
    // When workspace is not enabled, return empty so viewsWelcome shows
    if (!this.workspaceFolder || !isWorkspaceEnabled(this.workspaceFolder)) {
      return [];
    }

    // Root level
    if (!element) {
      return this.getRootItems();
    }

    // Children based on section
    if (element.label === "Memory Documents") {
      return this.getDocumentItems();
    }

    if (element.label === "Status") {
      return this.getStatusItems();
    }

    if (element.label === "RAG Index") {
      return this.getIndexItems();
    }

    if (element.label === "Quick Actions") {
      return this.getActionItems();
    }

    if (element.label === "Batch Commands") {
      return this.getBatchItems();
    }

    if (element.label === "Agent Ecosystem") {
      return this.getEcosystemItems();
    }

    if (element.label === "Skills") {
      return this.getSkillItems();
    }

    if (element.label === "Prompt Commands") {
      return this.getPromptItems();
    }

    if (element.label === "Hooks") {
      return this.getHookItems();
    }

    if (element.label === "Agents") {
      return this.getAgentItems();
    }

    if (element.label === "Reminders") {
      return this.getReminderItems();
    }

    if (element.label === "Admin Tools") {
      return this.getAdminItems();
    }

    if (element.label === "Strategies") {
      return this.getStrategyItems();
    }

    if (element.label === "Swarm") {
      return this.getSwarmItems();
    }

    if (element.label === "MCP Gateway") {
      return this.getGatewayItems();
    }

    if (element.label === "Self-Learning") {
      return this.getSelfLearningItems();
    }

    // Memory subfolders (dynamic)
    if (element.contextValue?.startsWith("memoryFolder:")) {
      const folderUriStr = element.contextValue.slice("memoryFolder:".length);
      const folderUri = vscode.Uri.parse(folderUriStr);
      return this.getMemoryFolderItems(folderUri);
    }

    return [];
  }

  // ─── Root ──────────────────────────────────────────────────────────

  private getRootItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    // Status section
    const statusIcon = this.memoryActive ? "pass" : "circle-slash";
    const statusItem = new BrainTreeItem(
      "Status",
      vscode.TreeItemCollapsibleState.Expanded,
      "section",
    );
    statusItem.iconPath = new vscode.ThemeIcon(statusIcon);
    items.push(statusItem);

    // Swarm section (always visible)
    const swarm = getSwarmState();
    const swarmIcon = swarm.running
      ? "sync"
      : swarm.summary
        ? "rocket"
        : "symbol-misc";
    const swarmItem = new BrainTreeItem(
      "Swarm",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
    );
    swarmItem.iconPath = new vscode.ThemeIcon(swarmIcon);
    items.push(swarmItem);

    // Self-Learning section (visible when any operation is active)
    const slState = getSLState();
    if (slState.repos.size > 0) {
      const hasActive = [...slState.repos.values()].some(
        (r) => r.phase !== "done" && r.phase !== "error",
      );
      const slItem = new BrainTreeItem(
        "Self-Learning",
        vscode.TreeItemCollapsibleState.Expanded,
        "section",
      );
      slItem.iconPath = new vscode.ThemeIcon(hasActive ? "sync~spin" : "book");
      slItem.tooltip = `${slState.repos.size} repo(s) tracked`;
      items.push(slItem);
    }

    // Reminders section (always visible when memory is active)
    if (this.memoryActive) {
      const remindersItem = new BrainTreeItem(
        "Reminders",
        vscode.TreeItemCollapsibleState.Collapsed,
        "section",
        "reminders-section",
      );
      remindersItem.iconPath = new vscode.ThemeIcon("bell");
      remindersItem.tooltip = "Cron reminders — active, snoozed, completed";
      items.push(remindersItem);
    }

    // Memory Documents section
    if (this.memoryActive) {
      const docsItem = new BrainTreeItem(
        "Memory Documents",
        vscode.TreeItemCollapsibleState.Expanded,
        "section",
      );
      docsItem.iconPath = new vscode.ThemeIcon("folder-library");
      items.push(docsItem);
    }

    // RAG Index section
    if (this.ragReady) {
      const indexItem = new BrainTreeItem(
        "RAG Index",
        vscode.TreeItemCollapsibleState.Collapsed,
        "section",
      );
      indexItem.iconPath = new vscode.ThemeIcon("database");
      items.push(indexItem);
    }

    // Batch Commands section
    const batchItem = new BrainTreeItem(
      "Batch Commands",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
    );
    batchItem.iconPath = new vscode.ThemeIcon("list-ordered");
    batchItem.tooltip = "Credit-saving batch mode: 1 message = N actions";
    items.push(batchItem);

    // Agent Ecosystem
    const ecoItem = new BrainTreeItem(
      "Agent Ecosystem",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
    );
    ecoItem.iconPath = new vscode.ThemeIcon("extensions");
    ecoItem.tooltip = "Skills, prompts, hooks & agents";
    items.push(ecoItem);

    // Quick Actions
    const actionsItem = new BrainTreeItem(
      "Quick Actions",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
    );
    actionsItem.iconPath = new vscode.ThemeIcon("zap");
    items.push(actionsItem);

    // Strategies toggles
    const stratItem = new BrainTreeItem(
      "Strategies",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
    );
    stratItem.iconPath = new vscode.ThemeIcon("beaker");
    stratItem.tooltip = "Configuración del closing protocol de estrategias";
    items.push(stratItem);

    // MCP Gateway section
    const gwRunning = this.gateway?.isRunning() ?? false;
    const gwItem = new BrainTreeItem(
      "MCP Gateway",
      vscode.TreeItemCollapsibleState.Collapsed,
      "section",
      "gateway-section",
    );
    gwItem.iconPath = new vscode.ThemeIcon(
      gwRunning ? "plug" : "debug-disconnect",
    );
    gwItem.tooltip = gwRunning
      ? `Gateway activo en puerto ${this.gateway?.getPort()}`
      : "Gateway detenido — click en Toggle para iniciar";
    items.push(gwItem);

    // Admin Tools (conditionally shown)
    if (this.isAdmin) {
      const adminItem = new BrainTreeItem(
        "Admin Tools",
        vscode.TreeItemCollapsibleState.Collapsed,
        "section",
      );
      adminItem.iconPath = new vscode.ThemeIcon("shield");
      items.push(adminItem);
    }

    return items;
  }

  // ─── MCP Gateway ───────────────────────────────────────────────────

  private getGatewayItems(): BrainTreeItem[] {
    const running = this.gateway?.isRunning() ?? false;
    const port = this.gateway?.getPort();
    const items: BrainTreeItem[] = [];

    // Status indicator
    const statusItem = new BrainTreeItem(
      running ? `Running on :${port}` : "Stopped",
      vscode.TreeItemCollapsibleState.None,
      "status",
    );
    statusItem.iconPath = new vscode.ThemeIcon(
      running ? "pass" : "circle-slash",
    );
    statusItem.tooltip = running
      ? `MCP Gateway escuchando en http://127.0.0.1:${port}`
      : "Gateway no iniciado";
    items.push(statusItem);

    // Toggle action
    const toggleItem = new BrainTreeItem(
      running ? "Stop Gateway" : "Start Gateway",
      vscode.TreeItemCollapsibleState.None,
      "action",
      "action",
    );
    toggleItem.iconPath = new vscode.ThemeIcon(running ? "debug-stop" : "play");
    toggleItem.command = {
      command: "projectBrain.gateway.toggle",
      title: running ? "Stop Gateway" : "Start Gateway",
    };
    items.push(toggleItem);

    if (running) {
      // Health check shortcut
      const healthItem = new BrainTreeItem(
        `http://127.0.0.1:${port}/health`,
        vscode.TreeItemCollapsibleState.None,
        "status",
      );
      healthItem.iconPath = new vscode.ThemeIcon("link");
      healthItem.tooltip = "Endpoint de salud del gateway";
      items.push(healthItem);
    }

    return items;
  }

  // ─── Self-Learning ─────────────────────────────────────────────────

  private getSelfLearningItems(): BrainTreeItem[] {
    const slState = getSLState();
    if (slState.repos.size === 0) {
      return [this.makeItem("No active operations", "info", "status")];
    }

    const items: BrainTreeItem[] = [];
    for (const repo of slState.repos.values()) {
      const icon = this.slPhaseIcon(repo.phase);
      const elapsed = this.formatElapsed(repo.startedAt);
      const pct = repo.percent !== undefined ? ` ${repo.percent}%` : "";
      const label = `${repo.name}${pct}`;

      const item = new BrainTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        "status",
      );
      item.iconPath = new vscode.ThemeIcon(
        icon,
        repo.phase === "error"
          ? new vscode.ThemeColor("testing.iconFailed")
          : repo.phase === "done"
            ? new vscode.ThemeColor("testing.iconPassed")
            : undefined,
      );
      item.description = repo.detail;
      item.tooltip = `${repo.phase} — ${repo.detail} (${elapsed})`;
      items.push(item);
    }
    return items;
  }

  private slPhaseIcon(phase: string): string {
    switch (phase) {
      case "cloning":
        return "cloud-download";
      case "vectorizing":
        return "database";
      case "analyzing":
        return "beaker";
      case "done":
        return "pass-filled";
      case "error":
        return "error";
      default:
        return "circle-outline";
    }
  }

  private formatElapsed(startMs: number): string {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${min}m${rem}s`;
  }

  // ─── Swarm ─────────────────────────────────────────────────────────

  private getSwarmItems(): BrainTreeItem[] {
    const swarm = getSwarmState();

    if (!swarm.goal && swarm.workers.length === 0 && !swarm.summary) {
      const empty = this.makeItem("No swarm runs yet", "info", "status");
      empty.tooltip = "Run a swarm task (toolbox.swarm) to see results here.";
      return [empty];
    }

    const headerLabel = swarm.running
      ? `Running: ${swarm.goal ?? "(no goal)"}`
      : `Last run: ${swarm.goal ?? "(no goal)"}`;

    const header = new BrainTreeItem(
      headerLabel,
      vscode.TreeItemCollapsibleState.None,
      "status",
    );
    header.iconPath = new vscode.ThemeIcon(swarm.running ? "sync" : "check");
    header.tooltip =
      swarm.concurrency !== undefined
        ? `Concurrency: ${swarm.concurrency}`
        : undefined;

    const items: BrainTreeItem[] = [header];

    if (swarm.summary) {
      const open = new BrainTreeItem(
        "Open last swarm report",
        vscode.TreeItemCollapsibleState.None,
        "action",
        "action",
      );
      open.iconPath = new vscode.ThemeIcon("open-preview");
      open.command = {
        command: "projectBrain.swarm.openLastReport",
        title: "Open last swarm report",
      };
      items.push(open);
    }

    for (const w of swarm.workers) {
      const statusIcon =
        w.success === true
          ? "pass"
          : w.success === false
            ? "error"
            : "circle-outline";
      const tokenInfo =
        w.estimatedInputTokens || w.estimatedOutputTokens
          ? ` | ~${(((w.estimatedInputTokens ?? 0) + (w.estimatedOutputTokens ?? 0)) / 1000).toFixed(1)}K tok`
          : "";
      const durationInfo = w.durationMs
        ? ` | ${(w.durationMs / 1000).toFixed(1)}s`
        : "";
      const label = w.message ? `${w.taskId}: ${w.message}` : w.taskId;
      const workerItem = new BrainTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        "status",
      );
      workerItem.iconPath = new vscode.ThemeIcon(statusIcon);
      workerItem.tooltip = w.error
        ? w.error
        : w.model
          ? `${w.model} (${w.tier ?? "unknown"})${tokenInfo}${durationInfo}`
          : undefined;
      items.push(workerItem);
    }

    return items;
  }

  // ─── Status children ──────────────────────────────────────────────

  private getStatusItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    items.push(
      this.makeStatusItem(
        "Memory",
        this.memoryActive ? "Active" : "Not initialized",
        this.memoryActive,
      ),
    );

    items.push(
      this.makeStatusItem(
        "RAG Backend",
        this.ragReady ? "Ready (LM Tools)" : "Not configured",
        this.ragReady,
      ),
    );

    items.push(
      this.makeStatusItem(
        "Auto-Vectorization",
        this.autoVecActive ? "Active" : "Inactive",
        this.autoVecActive,
      ),
    );

    return items;
  }

  // ─── Document children ────────────────────────────────────────────

  private async getDocumentItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];

    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");

    // Show from the docs root (parent of memory folder) so ALL docs are visible,
    // not just the ones inside .project-brain/memory/. The memory/ subfolder appears
    // as a collapsible node inside.
    const parts = memoryFolder.replace(/\\/g, "/").split("/");
    const docsRoot = parts.length > 1
      ? parts.slice(0, -1).join("/")
      : memoryFolder;
    const docsPath = vscode.Uri.joinPath(this.workspaceFolder.uri, docsRoot);

    return this.getMemoryFolderItems(docsPath);
  }

  /** List files & subdirectories inside a memory folder */
  private async getMemoryFolderItems(
    folderUri: vscode.Uri,
  ): Promise<BrainTreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folderUri);
    } catch {
      return [this.makeItem("Folder not found", "warning", "status")];
    }

    const folders: BrainTreeItem[] = [];
    const files: BrainTreeItem[] = [];

    for (const [name, fileType] of entries) {
      // Skip hidden files/folders
      if (name.startsWith(".")) continue;

      if (fileType === vscode.FileType.Directory) {
        const dirItem = new BrainTreeItem(
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
          "section",
          `memoryFolder:${vscode.Uri.joinPath(folderUri, name).toString()}`,
        );
        const folderIcon = MEMORY_FOLDER_ICONS[name] ?? "folder";
        dirItem.iconPath = new vscode.ThemeIcon(folderIcon);
        dirItem.tooltip = `📂 ${name}/`;
        folders.push(dirItem);
        continue;
      }

      // Only show markdown and json files
      if (!name.endsWith(".md") && !name.endsWith(".json")) continue;

      const fileUri = vscode.Uri.joinPath(folderUri, name);
      const known = MEMORY_DOCS_MAP.get(name);
      const label = known?.label ?? labelFromFilename(name);
      const icon = known?.icon ?? (name.endsWith(".json") ? "json" : "markdown");
      const desc = known?.description ?? name;

      let size = 0;
      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        size = stat.size;
      } catch { /* noop */ }

      const sizeLabel = size > 1024
        ? `${(size / 1024).toFixed(1)}KB`
        : `${size}B`;

      const item = new BrainTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        "doc",
        "brainDoc",
      );
      item.description = sizeLabel;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${name}\n${desc}\nSize: ${sizeLabel}`;
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [fileUri],
      };

      files.push(item);
    }

    // Folders first, then files
    return [...folders, ...files];
  }

  // ─── Index children ───────────────────────────────────────────────

  private getIndexItems(): BrainTreeItem[] {
    if (!this.indexStats) {
      return [this.makeItem("No index data", "info", "status")];
    }

    return [
      this.makeItem(
        `Chunks: ${this.indexStats.chunks}`,
        "symbol-array",
        "status",
      ),
      this.makeItem(`Files: ${this.indexStats.files}`, "file", "status"),
      this.makeItem(
        `Updated: ${new Date(this.indexStats.lastUpdated).toLocaleDateString()}`,
        "calendar",
        "status",
      ),
    ];
  }

  // ─── Batch children ───────────────────────────────────────────────

  private getBatchItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    const newBatch = this.makeItem("➕ New Batch Command", "add", "action");
    newBatch.command = {
      command: "projectBrain.batch.newCommand",
      title: "New Batch Command",
    };
    items.push(newBatch);

    const editCommands = this.makeItem(
      "📝 Edit commands.txt",
      "edit",
      "action",
    );
    editCommands.command = {
      command: "projectBrain.batch.editCommands",
      title: "Edit Commands",
    };
    items.push(editCommands);

    const viewOutput = this.makeItem(
      "📄 View output.txt",
      "file-text",
      "action",
    );
    viewOutput.command = {
      command: "projectBrain.batch.viewOutput",
      title: "View Output",
    };
    items.push(viewOutput);

    const execute = this.makeItem("▶️ Execute Batch", "play", "action");
    execute.command = {
      command: "projectBrain.batch.execute",
      title: "Execute Batch",
    };
    execute.tooltip = "Sends 'batch' to @brain chat";
    items.push(execute);

    return items;
  }

  // ─── Reminder children ────────────────────────────────────────────

  private async getReminderItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];

    const config = vscode.workspace.getConfiguration("projectBrain");
    const memoryFolder = config.get<string>("memoryFolder", ".project-brain/memory");
    const memoryPath = path.join(this.workspaceFolder.uri.fsPath, memoryFolder);

    let jobs: CronJob[];
    try {
      jobs = await listCronJobs(memoryPath, () => {});
    } catch {
      return [this.makeItem("Error loading reminders", "warning", "status")];
    }

    if (jobs.length === 0) {
      const empty = this.makeItem("No reminders yet", "info", "status");
      empty.tooltip = "Use @brain or the QuickPick to create one";
      return [empty];
    }

    // Group by status
    const prioOrder: Record<string, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };
    const active = jobs
      .filter((j) => j.status === "active")
      .sort(
        (a, b) =>
          (prioOrder[a.priority ?? "info"] ?? 9) -
          (prioOrder[b.priority ?? "info"] ?? 9),
      );
    const snoozed = jobs.filter((j) => j.status === "snoozed");
    const done = jobs.filter((j) => j.status === "done");

    const items: BrainTreeItem[] = [];

    // Notification mute toggle (first item in list)
    const isMuted = vscode.workspace
      .getConfiguration("projectBrain")
      .get<boolean>("cron.notificationsMuted", false);
    const muteIcon = isMuted ? "bell-slash" : "bell";
    const muteLabel = isMuted
      ? "🔇 Notifications: OFF"
      : "🔔 Notifications: ON";
    const muteItem = new BrainTreeItem(
      muteLabel,
      vscode.TreeItemCollapsibleState.None,
      "action",
    );
    muteItem.iconPath = new vscode.ThemeIcon(
      muteIcon,
      new vscode.ThemeColor(isMuted ? "disabledForeground" : "charts.green"),
    );
    muteItem.tooltip = isMuted
      ? "Click to re-enable cron toast notifications"
      : "Click to mute cron toast notifications";
    muteItem.command = {
      command: "projectBrain.toggleCronNotifications",
      title: "Toggle Cron Notifications",
    };
    items.push(muteItem);

    // Active
    for (const job of active) {
      const prio =
        job.priority === "critical"
          ? "🚨"
          : job.priority === "warning"
            ? "⚠️"
            : "📌";
      const mutedBadge = job.muted ? " 🔇" : "";
      const retryBadge = (job.retryCount ?? 0) > 0 ? ` ⟳${job.retryCount}` : "";
      const item = new BrainTreeItem(
        `${prio} ${job.description}${mutedBadge}${retryBadge}`,
        vscode.TreeItemCollapsibleState.None,
        "reminder",
        "reminder-active",
        job.id,
      );
      item.iconPath = new vscode.ThemeIcon(
        job.muted ? "bell-slash" : "bell",
        (job.retryCount ?? 0) > 0
          ? new vscode.ThemeColor("editorWarning.foreground")
          : undefined,
      );

      // Rich tooltip with history, expiration, retry info
      const tooltipParts = [`${job.trigger.type} — ${job.id}`];
      if (job.lastActionResult) {
        tooltipParts.push(
          `Last result: ${job.lastActionResult.substring(0, 120)}`,
        );
      }
      if (job.lastTriggered) {
        tooltipParts.push(
          `Last fired: ${new Date(job.lastTriggered).toLocaleString()}`,
        );
      }
      if (job.runCount) {
        tooltipParts.push(
          `Runs: ${job.runCount}${job.maxRuns ? `/${job.maxRuns}` : ""}`,
        );
      }
      if (job.expiresAt) {
        tooltipParts.push(
          `Expires: ${new Date(job.expiresAt).toLocaleDateString()}`,
        );
      }
      if ((job.retryCount ?? 0) > 0) {
        tooltipParts.push(
          `⚠ Retry ${job.retryCount}/${job.maxRetries ?? 0}: ${job.lastError ?? "unknown"}`,
        );
      }
      if (job.muted) {
        tooltipParts.push("🔇 Muted — actions run but no notifications");
      }
      item.tooltip = tooltipParts.join("\n");

      // Description: show last result or trigger type
      item.description = job.lastActionResult
        ? job.lastActionResult.substring(0, 50)
        : job.trigger.type;
      items.push(item);
    }

    // Snoozed
    for (const job of snoozed) {
      const item = new BrainTreeItem(
        `😴 ${job.description}`,
        vscode.TreeItemCollapsibleState.None,
        "reminder",
        "reminder-snoozed",
        job.id,
      );
      item.iconPath = new vscode.ThemeIcon("bell-slash");
      item.tooltip = `Snoozed until ${job.snoozeUntil ?? "?"}`;
      item.description = job.snoozeUntil
        ? `until ${new Date(job.snoozeUntil).toLocaleDateString()}`
        : "snoozed";
      items.push(item);
    }

    // Done (collapsed feel — only show last 5)
    const recentDone = done.slice(-5);
    for (const job of recentDone) {
      const item = new BrainTreeItem(
        `✅ ${job.description}`,
        vscode.TreeItemCollapsibleState.None,
        "reminder",
        "reminder-done",
        job.id,
      );
      item.iconPath = new vscode.ThemeIcon("check");
      item.tooltip = `Completed — ${job.id}`;
      item.description = "done";
      items.push(item);
    }

    if (done.length > 5) {
      items.push(
        this.makeItem(
          `+${done.length - 5} more completed`,
          "ellipsis",
          "status",
        ),
      );
    }

    return items;
  }

  // ─── Strategy toggles ──────────────────────────────────────────────

  private getStrategyItems(): BrainTreeItem[] {
    const config = vscode.workspace.getConfiguration("projectBrain");
    const satisfactionOn = config.get<boolean>(
      "strategy.satisfactionCheck",
      true,
    );
    const autoCommitOn = config.get<boolean>("strategy.autoCommit", true);

    const satIcon = satisfactionOn ? "pass-filled" : "circle-slash";
    const satItem = new BrainTreeItem(
      "Satisfaction Check",
      vscode.TreeItemCollapsibleState.None,
      "action",
    );
    satItem.iconPath = new vscode.ThemeIcon(
      satIcon,
      new vscode.ThemeColor(
        satisfactionOn ? "testing.iconPassed" : "testing.iconFailed",
      ),
    );
    satItem.description = satisfactionOn ? "ON" : "OFF";
    satItem.tooltip = satisfactionOn
      ? "Preguntar si estás satisfecho al terminar una estrategia (click para desactivar)"
      : "Satisfaction check desactivado (click para activar)";
    satItem.command = {
      command: "projectBrain.strategy.toggleSatisfactionCheck",
      title: "Toggle Satisfaction Check",
    };

    const commitIcon = autoCommitOn ? "pass-filled" : "circle-slash";
    const commitItem = new BrainTreeItem(
      "Auto-Commit",
      vscode.TreeItemCollapsibleState.None,
      "action",
    );
    commitItem.iconPath = new vscode.ThemeIcon(
      commitIcon,
      new vscode.ThemeColor(
        autoCommitOn ? "testing.iconPassed" : "testing.iconFailed",
      ),
    );
    commitItem.description = autoCommitOn ? "ON" : "OFF";
    commitItem.tooltip = autoCommitOn
      ? "Ofrecer commit automático al terminar una estrategia (click para desactivar)"
      : "Auto-commit desactivado (click para activar)";
    commitItem.command = {
      command: "projectBrain.strategy.toggleAutoCommit",
      title: "Toggle Auto-Commit",
    };

    return [satItem, commitItem];
  }

  // ─── Action children ──────────────────────────────────────────────

  private getActionItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    if (!this.memoryActive) {
      const init = this.makeItem("Initialize Project Brain", "add", "action");
      init.command = {
        command: "projectBrain.init",
        title: "Initialize",
      };
      items.push(init);
    } else {
      const scan = this.makeItem("Scan & Update Docs", "sync", "action");
      scan.command = {
        command: "projectBrain.scan",
        title: "Scan",
      };
      items.push(scan);

      const open = this.makeItem(
        "Open Memory Folder",
        "folder-opened",
        "action",
      );
      open.command = {
        command: "projectBrain.openMemory",
        title: "Open",
      };
      items.push(open);

      const identityForm = this.makeItem(
        "Configure Identity",
        "person",
        "action",
      );
      identityForm.command = {
        command: "projectBrain.openIdentityForm",
        title: "Configure Identity",
      };
      identityForm.tooltip = "Open the identity configuration form (name, soul, user profile)";
      items.push(identityForm);

      const importChat = this.makeItem(
        "Import Chat from content.txt",
        "inbox",
        "action",
      );
      importChat.command = {
        command: "projectBrain.importContentTxt",
        title: "Import Chat",
      };
      importChat.tooltip =
        "Create a compact chat note from a manually selected content.txt file";
      items.push(importChat);

      if (!this.autoVecActive) {
        const start = this.makeItem(
          "Start Auto-Vectorization",
          "rocket",
          "action",
        );
        start.command = {
          command: "projectBrain.startAutoVectorization",
          title: "Start",
        };
        items.push(start);
      } else {
        const stop = this.makeItem(
          "Stop Auto-Vectorization",
          "debug-stop",
          "action",
        );
        stop.command = {
          command: "projectBrain.stopAutoVectorization",
          title: "Stop",
        };
        items.push(stop);
      }

      const exclude = this.makeItem("Exclude from Git", "git-commit", "action");
      exclude.command = {
        command: "projectBrain.excludeFromGit",
        title: "Exclude",
      };
      items.push(exclude);

      // Cloud purge (only if cloud sync could be active)
      const purge = this.makeItem(
        "\u2622\uFE0F Purge Cloud Files",
        "trash",
        "action",
      );
      purge.command = {
        command: "projectBrain.purgeCloudFiles",
        title: "Purge Cloud Files",
      };
      purge.tooltip =
        "Permanently delete ALL cloud-synced files for this project (local files untouched)";
      items.push(purge);
    }

    return items;
  }

  // ─── Admin section ──────────────────────────────────────────────────

  private getAdminItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    const panel = this.makeItem("Open Admin Panel", "shield", "action");
    panel.command = {
      command: "projectBrain.openAdminPanel",
      title: "Open Admin Panel",
    };
    items.push(panel);

    return items;
  }

  // ─── Ecosystem section ─────────────────────────────────────────────

  private getEcosystemItems(): BrainTreeItem[] {
    const items: BrainTreeItem[] = [];

    const skills = new BrainTreeItem(
      "Skills",
      vscode.TreeItemCollapsibleState.Collapsed,
      "ecosystem",
    );
    skills.iconPath = new vscode.ThemeIcon("lightbulb");
    skills.tooltip =
      "Agent skills from .project-brain/memory/skills/ and .github/skills/";
    items.push(skills);

    const prompts = new BrainTreeItem(
      "Prompt Commands",
      vscode.TreeItemCollapsibleState.Collapsed,
      "ecosystem",
    );
    prompts.iconPath = new vscode.ThemeIcon("terminal");
    prompts.tooltip = "Slash commands from .github/prompts/";
    items.push(prompts);

    const hooks = new BrainTreeItem(
      "Hooks",
      vscode.TreeItemCollapsibleState.Collapsed,
      "ecosystem",
    );
    hooks.iconPath = new vscode.ThemeIcon("plug");
    hooks.tooltip = "Lifecycle hooks from .project-brain/hooks/";
    items.push(hooks);

    const agents = new BrainTreeItem(
      "Agents",
      vscode.TreeItemCollapsibleState.Collapsed,
      "ecosystem",
    );
    agents.iconPath = new vscode.ThemeIcon("hubot");
    agents.tooltip = "Custom agents from .github/agents/";
    items.push(agents);

    return items;
  }

  private async getSkillItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];
    const items: BrainTreeItem[] = [];

    const skillPaths = [
      vscode.Uri.joinPath(this.workspaceFolder.uri, "docs", "memory", "skills"),
      vscode.Uri.joinPath(this.workspaceFolder.uri, ".github", "skills"),
    ];

    for (const base of skillPaths) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(base);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.Directory) continue;
          const skillFile = vscode.Uri.joinPath(base, name, "SKILL.md");
          let exists = false;
          try {
            await vscode.workspace.fs.stat(skillFile);
            exists = true;
          } catch {
            /* not found */
          }

          const isGithub = base.path.includes(".github");
          const item = new BrainTreeItem(
            name,
            vscode.TreeItemCollapsibleState.None,
            "ecosystem",
            "brainSkill",
          );
          item.description = isGithub ? ".github" : "memory";
          item.iconPath = new vscode.ThemeIcon(
            exists ? "lightbulb" : "lightbulb-autofix",
          );
          item.tooltip = `/${name} — ${isGithub ? ".github/skills/" : ".project-brain/memory/skills/"}${name}`;
          if (exists) {
            item.command = {
              command: "vscode.open",
              title: "Open",
              arguments: [skillFile],
            };
          }
          items.push(item);
        }
      } catch {
        /* dir not found */
      }
    }

    if (items.length === 0) {
      items.push(this.makeItem("No skills found", "info", "status"));
    }
    return items;
  }

  private async getPromptItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];
    const items: BrainTreeItem[] = [];
    const promptsDir = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ".github",
      "prompts",
    );

    try {
      const entries = await vscode.workspace.fs.readDirectory(promptsDir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".prompt.md"))
          continue;
        const slug = name.replace(".prompt.md", "");
        const fileUri = vscode.Uri.joinPath(promptsDir, name);
        const item = new BrainTreeItem(
          `/${slug}`,
          vscode.TreeItemCollapsibleState.None,
          "ecosystem",
          "brainPrompt",
        );
        item.iconPath = new vscode.ThemeIcon("terminal");
        item.tooltip = `Type /${slug} in chat to use this prompt`;
        item.command = {
          command: "vscode.open",
          title: "Open",
          arguments: [fileUri],
        };
        items.push(item);
      }
    } catch {
      /* dir not found */
    }

    if (items.length === 0) {
      items.push(this.makeItem("No prompts found", "info", "status"));
    }
    return items;
  }

  private async getHookItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];
    const items: BrainTreeItem[] = [];
    const hooksDir = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ".github",
      "hooks",
    );

    try {
      const entries = await vscode.workspace.fs.readDirectory(hooksDir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        const slug = name.replace(".json", "");
        const fileUri = vscode.Uri.joinPath(hooksDir, name);
        const item = new BrainTreeItem(
          slug,
          vscode.TreeItemCollapsibleState.None,
          "ecosystem",
          "brainHook",
        );
        item.iconPath = new vscode.ThemeIcon("plug");
        item.tooltip = `Hook: ${slug}\nClick to edit`;
        item.command = {
          command: "vscode.open",
          title: "Open",
          arguments: [fileUri],
        };
        items.push(item);
      }
    } catch {
      /* dir not found */
    }

    if (items.length === 0) {
      items.push(this.makeItem("No hooks configured", "info", "status"));
    }
    return items;
  }

  private async getAgentItems(): Promise<BrainTreeItem[]> {
    if (!this.workspaceFolder) return [];
    const items: BrainTreeItem[] = [];
    const agentsDir = vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      ".github",
      "agents",
    );

    try {
      const entries = await vscode.workspace.fs.readDirectory(agentsDir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".agent.md"))
          continue;
        const slug = name.replace(".agent.md", "");
        const fileUri = vscode.Uri.joinPath(agentsDir, name);
        const item = new BrainTreeItem(
          slug,
          vscode.TreeItemCollapsibleState.None,
          "ecosystem",
          "brainAgent",
        );
        item.iconPath = new vscode.ThemeIcon("hubot");
        item.tooltip = `Agent: ${slug}\nClick to edit`;
        item.command = {
          command: "vscode.open",
          title: "Open",
          arguments: [fileUri],
        };
        items.push(item);
      }
    } catch {
      /* dir not found */
    }

    if (items.length === 0) {
      items.push(this.makeItem("No agents found", "info", "status"));
    }
    return items;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private makeItem(
    label: string,
    icon: string,
    type: "status" | "doc" | "section" | "action",
  ): BrainTreeItem {
    const item = new BrainTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      type,
    );
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private makeStatusItem(
    label: string,
    value: string,
    active: boolean,
  ): BrainTreeItem {
    const item = new BrainTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      "status",
    );
    item.description = value;
    item.iconPath = new vscode.ThemeIcon(
      active ? "pass-filled" : "circle-slash",
      active
        ? new vscode.ThemeColor("testing.iconPassed")
        : new vscode.ThemeColor("testing.iconFailed"),
    );
    return item;
  }
}
