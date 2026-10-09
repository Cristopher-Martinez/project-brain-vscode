/**
 * Admin Panel — Webview-based skill usage dashboard.
 *
 * Shows:
 * - Recent skill executions (table with filters)
 * - Skill stats (aggregated usage per skill)
 * - Error log (filtered to failures/blocks)
 * - Trigger distribution (pie/bar chart of trigger types)
 *
 * Admin-gated: only accessible when license.isAdmin === true.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AdminDB, RecentExecution, SkillStats } from "./admin-db";

interface SkillMeta {
  description: string;
  folder: string;
}

export class AdminPanel {
  public static currentPanel: AdminPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly memoryPath: string;
  private disposables: vscode.Disposable[] = [];
  private adminDb: AdminDB;
  private log: (msg: string) => void;

  public static createOrShow(
    extensionUri: vscode.Uri,
    adminDb: AdminDB,
    log: (msg: string) => void,
    memoryPath?: string
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (AdminPanel.currentPanel) {
      AdminPanel.currentPanel.panel.reveal(column);
      AdminPanel.currentPanel.refresh();
      return;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      "projectBrain.adminPanel",
      "🔧 Project Brain Admin",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    AdminPanel.currentPanel = new AdminPanel(panel, extensionUri, adminDb, log, memoryPath ?? "");
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    adminDb: AdminDB,
    log: (msg: string) => void,
    memoryPath: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.adminDb = adminDb;
    this.log = log;
    this.memoryPath = memoryPath;

    // Set initial HTML
    this.refresh();

    // Listen for dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "refresh":
            await this.refresh();
            break;
          case "clearAll":
            await this.adminDb.clearAll();
            await this.refresh();
            vscode.window.showInformationMessage(
              "Admin DB cleared successfully"
            );
            break;
          case "filterByResult":
            await this.sendFilteredData(message.filter);
            break;
          case "filterBySkill":
            await this.sendSkillDetail(message.skillName);
            break;
          case "openSkillDoc": {
            const folder = this.resolveSkillFolder(message.skillName);
            if (folder) {
              const skillPath = path.join(this.memoryPath, "skills", folder, "SKILL.md");
              if (fs.existsSync(skillPath)) {
                const doc = await vscode.workspace.openTextDocument(skillPath);
                await vscode.window.showTextDocument(doc, { preview: true });
              } else {
                vscode.window.showWarningMessage(`Skill file not found: ${skillPath}`);
              }
            }
            break;
          }
        }
      },
      null,
      this.disposables
    );
  }

  /** Refresh the panel with latest data. */
  public async refresh(): Promise<void> {
    try {
      const [recent, stats, errors, triggers] = await Promise.all([
        this.adminDb.getRecent(100),
        this.adminDb.getSkillStats(),
        this.adminDb.getErrors(50),
        this.adminDb.getTriggerDistribution(),
      ]);
      const skillMeta = this.loadSkillMeta();
      this.panel.webview.html = this.getHtml(recent, stats, errors, triggers, skillMeta);
    } catch (err) {
      this.log(`[AdminPanel] refresh error: ${err}`);
      this.panel.webview.html = `<!DOCTYPE html><html><body style="padding:24px;font-family:sans-serif;color:#ccc;background:#1e1e1e;">
        <h2>⚠️ Admin Panel Error</h2>
        <p>Could not load data from AdminDB:</p>
        <pre style="color:#f14c4c;white-space:pre-wrap;">${String(err)}</pre>
        <p style="margin-top:16px;opacity:0.7;">Check Output Channel "Project Brain" for details.</p>
      </body></html>`;
    }
  }

  private async sendFilteredData(filter: string): Promise<void> {
    let data: RecentExecution[];
    if (filter === "errors") {
      data = await this.adminDb.getErrors(100);
    } else {
      data = await this.adminDb.getRecent(100);
    }
    await this.panel.webview.postMessage({ command: "updateTable", data });
  }

  private async sendSkillDetail(skillName: string): Promise<void> {
    const recent = await this.adminDb.getRecent(200);
    const filtered = recent.filter((r) => r.skillName === skillName);
    await this.panel.webview.postMessage({
      command: "updateTable",
      data: filtered,
    });
  }

  private getHtml(
    recent: RecentExecution[],
    stats: SkillStats[],
    errors: RecentExecution[],
    triggers: Array<{ trigger: string; count: number }>,
    skillMeta?: Map<string, SkillMeta>
  ): string {
    const totalExecs = stats.reduce((s, r) => s + r.totalExecutions, 0);
    const totalErrors = stats.reduce((s, r) => s + r.errorCount, 0);
    const totalBlocked = stats.reduce((s, r) => s + r.blockedCount, 0);
    const uniqueSkills = stats.length;

    const statsRows = stats
      .map(
        (s) => {
          const meta = skillMeta?.get(s.skillName);
          const desc = meta ? this.esc(meta.description).substring(0, 80) : "";
          return `
      <tr class="clickable" data-skill="${this.esc(s.skillName)}" data-folder="${meta ? this.esc(meta.folder) : ""}">
        <td><strong>${this.esc(s.skillName)}</strong></td>
        <td class="desc" title="${meta ? this.esc(meta.description) : ""}">${desc}${desc.length >= 80 ? "…" : ""}</td>
        <td class="num">${s.totalExecutions}</td>
        <td class="num success">${s.successCount}</td>
        <td class="num error">${s.errorCount}</td>
        <td class="num warning">${s.blockedCount}</td>
        <td class="num">${Math.round(s.avgDurationMs)}ms</td>
        <td class="dim">${this.formatDate(s.lastUsed)}</td>
      </tr>
    `;
        }
      )
      .join("");

    const recentRows = recent
      .slice(0, 50)
      .map(
        (r) => `
      <tr class="${this.resultClass(r.result)}">
        <td class="dim">${this.formatDate(r.timestamp)}</td>
        <td><strong>${this.esc(r.skillName)}</strong></td>
        <td><span class="badge badge-${r.trigger}">${r.trigger}</span></td>
        <td><span class="badge result-${r.result}">${r.result}</span></td>
        <td class="num">${r.matchScore != null ? r.matchScore.toFixed(1) : "-"}</td>
        <td class="query">${r.query ? this.esc(r.query).substring(0, 40) : "-"}</td>
        <td class="error-msg">${r.errorMessage ? this.esc(r.errorMessage).substring(0, 60) : "-"}</td>
      </tr>
    `
      )
      .join("");

    const errorRows = errors
      .slice(0, 20)
      .map(
        (r) => `
      <tr>
        <td class="dim">${this.formatDate(r.timestamp)}</td>
        <td><strong>${this.esc(r.skillName)}</strong></td>
        <td><span class="badge result-${r.result}">${r.result}</span></td>
        <td>${r.trigger}</td>
        <td class="error-msg">${r.errorMessage ? this.esc(r.errorMessage) : r.query ? `Query: ${this.esc(r.query)}` : "-"}</td>
      </tr>
    `
      )
      .join("");

    const triggerBars = triggers
      .map((t) => {
        const maxCount = Math.max(...triggers.map((x) => x.count), 1);
        const pct = Math.round((t.count / maxCount) * 100);
        return `
        <div class="trigger-row">
          <span class="trigger-label">${t.trigger}</span>
          <div class="trigger-bar-bg">
            <div class="trigger-bar" style="width: ${pct}%"></div>
          </div>
          <span class="trigger-count">${t.count}</span>
        </div>
      `;
      })
      .join("");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Brain Admin</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #333);
      --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
      --hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --success: #4ec9b0;
      --error: #f14c4c;
      --warning: #cca700;
      --info: #3794ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }
    h1 { font-size: 20px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    h2 { font-size: 15px; margin: 20px 0 10px; color: var(--accent); }
    
    /* Summary cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card {
      background: var(--header-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      text-align: center;
    }
    .card .value { font-size: 28px; font-weight: bold; }
    .card .label { font-size: 11px; opacity: 0.7; margin-top: 4px; }
    .card.success .value { color: var(--success); }
    .card.error .value { color: var(--error); }
    .card.warning .value { color: var(--warning); }
    .card.info .value { color: var(--info); }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: var(--header-bg); font-weight: 600; position: sticky; top: 0; }
    tr:hover { background: var(--hover); }
    tr.clickable { cursor: pointer; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .dim { opacity: 0.7; font-size: 12px; }
    .query { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .desc { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; opacity: 0.8; }
    .error-msg { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--error); font-size: 12px; }
    
    /* Result-colored rows */
    tr.row-error td:first-child { border-left: 3px solid var(--error); }
    tr.row-blocked td:first-child { border-left: 3px solid var(--warning); }
    tr.row-not-found td:first-child { border-left: 3px solid var(--warning); }

    /* Badges */
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 500;
    }
    .result-found, .result-executed, .result-injected { background: rgba(78,201,176,0.15); color: var(--success); }
    .result-error { background: rgba(241,76,76,0.15); color: var(--error); }
    .result-blocked_plan { background: rgba(204,167,0,0.15); color: var(--warning); }
    .result-not_found { background: rgba(204,167,0,0.15); color: var(--warning); }
    .badge-findSkill { background: rgba(55,148,255,0.15); color: var(--info); }
    .badge-searchMemory { background: rgba(78,201,176,0.15); color: var(--success); }
    .badge-autoRecall { background: rgba(204,167,0,0.15); color: var(--warning); }
    .badge-postToolHook { background: rgba(241,76,76,0.15); color: var(--error); }
    .badge-directLoad { background: rgba(150,150,150,0.15); color: #999; }
    .badge-canExecute { background: rgba(150,150,150,0.15); color: #999; }

    /* Trigger distribution bars */
    .trigger-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .trigger-label { width: 120px; font-size: 12px; text-align: right; }
    .trigger-bar-bg { flex: 1; height: 18px; background: var(--header-bg); border-radius: 4px; overflow: hidden; }
    .trigger-bar { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
    .trigger-count { width: 40px; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }

    /* Tabs */
    .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .tab {
      padding: 8px 16px; cursor: pointer; font-size: 13px;
      border-bottom: 2px solid transparent; opacity: 0.7;
      transition: all 0.15s;
    }
    .tab:hover { opacity: 1; }
    .tab.active { border-bottom-color: var(--accent); opacity: 1; font-weight: 600; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Toolbar */
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    button {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; padding: 6px 14px; border-radius: 4px;
      cursor: pointer; font-size: 12px;
    }
    button:hover { opacity: 0.85; }
    button.danger { background: var(--error); }
    .spacer { flex: 1; }

    /* Scroll container */
    .scroll-table { max-height: 400px; overflow-y: auto; }

    /* Empty state */
    .empty { text-align: center; padding: 40px; opacity: 0.5; }
    .empty .icon { font-size: 32px; margin-bottom: 8px; }

    .success { color: var(--success); }
    .error { color: var(--error); }
    .warning { color: var(--warning); }
  </style>
</head>
<body>
  <h1>🔧 Project Brain Admin</h1>

  <!-- Summary Cards -->
  <div class="cards">
    <div class="card info">
      <div class="value">${totalExecs}</div>
      <div class="label">Total Executions</div>
    </div>
    <div class="card success">
      <div class="value">${uniqueSkills}</div>
      <div class="label">Unique Skills</div>
    </div>
    <div class="card error">
      <div class="value">${totalErrors}</div>
      <div class="label">Errors</div>
    </div>
    <div class="card warning">
      <div class="value">${totalBlocked}</div>
      <div class="label">Plan Blocked</div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-tab="overview">📊 Overview</div>
    <div class="tab" data-tab="recent">🕐 Recent</div>
    <div class="tab" data-tab="errors">❌ Errors</div>
    <div class="tab" data-tab="triggers">🎯 Triggers</div>
  </div>

  <!-- Overview Tab -->
  <div id="tab-overview" class="tab-content active">
    <div class="toolbar">
      <button onclick="send('refresh')">🔄 Refresh</button>
      <div class="spacer"></div>
      <button class="danger" onclick="if(confirm('Clear all admin data?')) send('clearAll')">🗑️ Clear All</button>
    </div>
    ${
      stats.length === 0
        ? `<div class="empty"><div class="icon">📭</div>No skill executions recorded yet.<br>Use skills and come back!</div>`
        : `
    <div class="scroll-table">
      <table>
        <thead>
          <tr>
            <th>Skill</th>
            <th>Description</th>
            <th class="num">Total</th>
            <th class="num">✅ OK</th>
            <th class="num">❌ Err</th>
            <th class="num">🚫 Block</th>
            <th class="num">Avg ms</th>
            <th>Last Used</th>
          </tr>
        </thead>
        <tbody>${statsRows}</tbody>
      </table>
    </div>`
    }
  </div>

  <!-- Recent Tab -->
  <div id="tab-recent" class="tab-content">
    <div class="toolbar">
      <button onclick="send('refresh')">🔄 Refresh</button>
    </div>
    ${
      recent.length === 0
        ? `<div class="empty"><div class="icon">📭</div>No recent executions</div>`
        : `
    <div class="scroll-table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Skill</th>
            <th>Trigger</th>
            <th>Result</th>
            <th class="num">Score</th>
            <th>Query</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="recent-body">${recentRows}</tbody>
      </table>
    </div>`
    }
  </div>

  <!-- Errors Tab -->
  <div id="tab-errors" class="tab-content">
    <div class="toolbar">
      <button onclick="send('filterByResult', {filter: 'errors'})">🔄 Refresh Errors</button>
    </div>
    ${
      errors.length === 0
        ? `<div class="empty"><div class="icon">✅</div>No errors! Everything is running smoothly.</div>`
        : `
    <div class="scroll-table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Skill</th>
            <th>Result</th>
            <th>Trigger</th>
            <th>Error / Query</th>
          </tr>
        </thead>
        <tbody>${errorRows}</tbody>
      </table>
    </div>`
    }
  </div>

  <!-- Triggers Tab -->
  <div id="tab-triggers" class="tab-content">
    ${
      triggers.length === 0
        ? `<div class="empty"><div class="icon">🎯</div>No trigger data yet</div>`
        : `
    <h2>Trigger Distribution</h2>
    <div style="max-width: 500px;">${triggerBars}</div>`
    }
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function send(command, data) {
      vscode.postMessage({ command, ...data });
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Clickable skill rows → open SKILL.md
    document.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', () => {
        const skill = row.dataset.skill;
        if (skill) {
          send('openSkillDoc', { skillName: skill });
        }
      });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'updateTable') {
        // Re-render would need full refresh for simplicity
        send('refresh');
      }
    });
  </script>
</body>
</html>`;
  }

  private resultClass(result: string): string {
    switch (result) {
      case "error":
        return "row-error";
      case "blocked_plan":
        return "row-blocked";
      case "not_found":
        return "row-not-found";
      default:
        return "";
    }
  }

  private formatDate(iso: string): string {
    if (!iso) return "-";
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Load skill metadata (name → description + folder) from the skills directory. */
  private loadSkillMeta(): Map<string, SkillMeta> {
    const map = new Map<string, SkillMeta>();
    const skillsDir = path.join(this.memoryPath, "skills");
    if (!fs.existsSync(skillsDir)) return map;
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const head = fs.readFileSync(skillFile, "utf-8").substring(0, 1000);
        const fmMatch = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let name = entry.name;
        let description = "";
        if (fmMatch) {
          const nm = fmMatch[1].match(/^name:\s*(.+)$/m);
          const desc = fmMatch[1].match(/^description:\s*(.+)$/m);
          if (nm) name = nm[1].trim().replace(/^["']|["']$/g, "");
          if (desc) description = desc[1].trim().replace(/^["']|["']$/g, "");
        }
        map.set(name, { description, folder: entry.name });
      }
    } catch (e) {
      this.log(`[AdminPanel] loadSkillMeta error: ${e}`);
    }
    return map;
  }

  /** Resolve a skill name to its folder in .project-brain/memory/skills/. */
  private resolveSkillFolder(skillName: string): string | undefined {
    const skillsDir = path.join(this.memoryPath, "skills");
    if (!fs.existsSync(skillsDir)) return undefined;
    // Direct match by folder name
    if (fs.existsSync(path.join(skillsDir, skillName, "SKILL.md"))) return skillName;
    // Search by frontmatter name
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const head = fs.readFileSync(skillFile, "utf-8").substring(0, 500);
        const nm = head.match(/^name:\s*(.+)$/m);
        if (nm && nm[1].trim().replace(/^["']|["']$/g, "") === skillName) return entry.name;
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private dispose(): void {
    AdminPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
