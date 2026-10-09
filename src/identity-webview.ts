// ─── Identity Configuration Webview ─────────────────────────────────────────
// Single-page form for agent identity, soul, and user profile configuration.
// Replaces the sequential InputBox/QuickPick flow with a unified form.
import * as vscode from "vscode";
import { log } from "./logger";
import type { FolderState } from "./extension-types";
import type { AgentIdentity, AgentSoul, UserProfile } from "./identity-types";

interface IdentityFormData {
  name: string;
  creature: string;
  emoji: string;
  vibe: string;
  language: string;
  tone: string;
  approach: string;
  boundaries: string;
  userName: string;
  preferredAddress: string;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function showIdentityForm(
  context: vscode.ExtensionContext,
  state: FolderState,
  onComplete?: () => Promise<void>,
): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "projectBrainIdentity",
    "Configure Agent Identity",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  currentPanel = panel;

  // Load existing values
  const identity = state.identityManager.loadIdentity();
  const soul = state.identityManager.loadSoul();
  const user = state.identityManager.loadUser();

  panel.webview.html = buildFormHtml(identity, soul, user);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; data?: IdentityFormData }) => {
      if (msg.type === "save" && msg.data) {
        await saveIdentityForm(state, msg.data);
        panel.dispose();
        if (onComplete) await onComplete();
      } else if (msg.type === "cancel") {
        panel.dispose();
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    currentPanel = undefined;
  });
}

async function saveIdentityForm(
  state: FolderState,
  data: IdentityFormData,
): Promise<void> {
  // Save identity
  if (data.name) {
    const identity: AgentIdentity = {
      name: data.name,
      creature: data.creature || "AI Assistant",
      emoji: data.emoji || "🧠",
      vibe: data.vibe || "Professional and helpful",
      theme: `${data.creature || "AI"}-coded`,
      language: data.language || "Español",
    };
    state.identityManager.saveIdentity(identity);
    log(`[IdentityForm] Identity saved: ${identity.name} ${identity.emoji}`);
  }

  // Save soul
  if (data.tone || data.approach) {
    const soul: AgentSoul = {
      tone: data.tone || "direct",
      approach: data.approach || "balanced",
      boundaries: data.boundaries || "",
      customRules: "",
    };
    state.identityManager.saveSoul(soul);
    log(`[IdentityForm] Soul saved: ${soul.tone}`);
  }

  // Save user
  if (data.userName) {
    const user: UserProfile = {
      name: data.userName,
      preferredAddress: data.preferredAddress || data.userName,
      timezone: "",
      notes: "",
    };
    state.identityManager.saveUser(user);
    log(`[IdentityForm] User saved: ${user.name}`);
  }

  // Regenerate agent instructions
  try {
    const docs = await state.scanner.scanProject();
    const freshIdentity = state.identityManager.loadIdentity();
    const freshSoul = state.identityManager.loadSoul();
    const freshUser = state.identityManager.loadUser();
    const essence = state.identityManager.extractProjectEssence();
    await state.bootstrapper.generateAgentInstructions(
      docs.projectType,
      freshIdentity,
      freshSoul,
      freshUser,
      essence,
    );
    log("[IdentityForm] Agent instructions regenerated");
    vscode.window.showInformationMessage(
      `Agent configured: ${freshIdentity?.emoji ?? "🧠"} ${freshIdentity?.name ?? "Agent"} | User: ${freshUser?.name ?? "—"}`,
    );
  } catch (err) {
    log(`[IdentityForm] Failed to regenerate instructions: ${err}`);
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildFormHtml(
  identity: AgentIdentity | null,
  soul: AgentSoul | null,
  user: UserProfile | null,
): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 600px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
  fieldset { border: 1px solid var(--vscode-widget-border, #333); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  legend { font-weight: bold; padding: 0 8px; font-size: 1.1em; }
  .field { margin-bottom: 12px; }
  label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 0.9em; }
  label .hint { font-weight: normal; color: var(--vscode-descriptionForeground); }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #333); border-radius: 4px; font-family: inherit; font-size: 0.95em; }
  textarea { resize: vertical; min-height: 60px; }
  .row { display: flex; gap: 12px; }
  .row .field { flex: 1; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  button { padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.95em; font-weight: 500; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, #555); }
</style>
</head>
<body>
  <h1>🧠 Configure Agent Identity</h1>
  <p class="subtitle">Fill in the fields below to personalize your AI agent. All fields are optional except Name.</p>

  <fieldset>
    <legend>Agent Identity</legend>
    <div class="row">
      <div class="field">
        <label>Name <span class="hint">(required)</span></label>
        <input id="name" value="${esc(identity?.name ?? "")}" placeholder="e.g. Jasper, Atlas, Nova" />
      </div>
      <div class="field">
        <label>Emoji</label>
        <input id="emoji" value="${esc(identity?.emoji ?? "🧠")}" placeholder="🧠" style="width:60px" />
      </div>
    </div>
    <div class="field">
      <label>Creature <span class="hint">(what kind of character)</span></label>
      <input id="creature" value="${esc(identity?.creature ?? "")}" placeholder="e.g. Pirate, Robot, Wizard" />
    </div>
    <div class="field">
      <label>Vibe <span class="hint">(personality in one sentence)</span></label>
      <input id="vibe" value="${esc(identity?.vibe ?? "")}" placeholder="e.g. Chaotic-brilliant senior dev" />
    </div>
    <div class="field">
      <label>Language</label>
      <select id="language">
        <option value="Español" ${(identity?.language ?? "Español") === "Español" ? "selected" : ""}>Español</option>
        <option value="English" ${identity?.language === "English" ? "selected" : ""}>English</option>
        <option value="Português" ${identity?.language === "Português" ? "selected" : ""}>Português</option>
        <option value="Français" ${identity?.language === "Français" ? "selected" : ""}>Français</option>
        <option value="Deutsch" ${identity?.language === "Deutsch" ? "selected" : ""}>Deutsch</option>
      </select>
    </div>
  </fieldset>

  <fieldset>
    <legend>Soul (Personality)</legend>
    <div class="row">
      <div class="field">
        <label>Tone</label>
        <input id="tone" value="${esc(soul?.tone ?? "")}" placeholder="e.g. Professional, Chaotic, Friendly" />
      </div>
      <div class="field">
        <label>Approach</label>
        <select id="approach">
          <option value="balanced" ${(soul?.approach ?? "balanced") === "balanced" ? "selected" : ""}>Balanced</option>
          <option value="pragmatic" ${soul?.approach === "pragmatic" ? "selected" : ""}>Pragmatic</option>
          <option value="thorough" ${soul?.approach === "thorough" ? "selected" : ""}>Thorough</option>
          <option value="creative" ${soul?.approach === "creative" ? "selected" : ""}>Creative</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>Boundaries <span class="hint">(rules the agent must follow)</span></label>
      <textarea id="boundaries" placeholder="e.g. No unnecessary dependencies; Respect existing patterns">${esc(soul?.boundaries ?? "")}</textarea>
    </div>
  </fieldset>

  <fieldset>
    <legend>Your Profile</legend>
    <div class="row">
      <div class="field">
        <label>Your Name</label>
        <input id="userName" value="${esc(user?.name ?? "")}" placeholder="How the agent should call you" />
      </div>
      <div class="field">
        <label>Preferred Address <span class="hint">(nickname)</span></label>
        <input id="preferredAddress" value="${esc(user?.preferredAddress ?? "")}" placeholder="e.g. Chris, Boss" />
      </div>
    </div>
  </fieldset>

  <div class="actions">
    <button class="btn-secondary" onclick="cancel()">Cancel</button>
    <button class="btn-primary" onclick="save()">Save Configuration</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function val(id) { return document.getElementById(id).value.trim(); }
    function save() {
      if (!val('name')) { document.getElementById('name').focus(); return; }
      vscode.postMessage({ type: 'save', data: {
        name: val('name'), creature: val('creature'), emoji: val('emoji'),
        vibe: val('vibe'), language: val('language'),
        tone: val('tone'), approach: val('approach'), boundaries: val('boundaries'),
        userName: val('userName'), preferredAddress: val('preferredAddress'),
      }});
    }
    function cancel() { vscode.postMessage({ type: 'cancel' }); }
  </script>
</body>
</html>`;
}
