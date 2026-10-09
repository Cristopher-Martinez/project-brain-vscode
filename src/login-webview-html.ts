/**
 * Login Webview HTML � Template and types for login UI.
 *
 * Extracted from login-webview.ts to keep file sizes under 400 lines.
 */

import type { Plan } from "./saas-client";

// ��� Types ����������������������������������������������������
export interface WebviewMessage {
  type:
    | "login"
    | "loginGitHub"
    | "register"
    | "logout"
    | "refresh"
    | "getStatus";
  email?: string;
  password?: string;
  displayName?: string;
}

export interface StatusMessage {
  type: "status";
  authenticated: boolean;
  plan: Plan;
  email?: string;
  isOnline: boolean;
  error?: string;
}
// ��� HTML Template �������������������������������������������

/** Generate the login webview HTML. */
export function getLoginHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Brain — Account</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --border: var(--vscode-widget-border, #333);
      --error: var(--vscode-errorForeground, #f48771);
      --success: var(--vscode-testing-iconPassed, #4ec9b0);
      --muted: var(--vscode-descriptionForeground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
      padding: 24px;
      max-width: 480px;
      margin: 0 auto;
    }

    h1 { font-size: 1.4em; margin-bottom: 4px; }
    .subtitle { color: var(--muted); margin-bottom: 24px; }

    .section { margin-bottom: 24px; }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.85em;
      font-weight: bold;
    }
    .status-badge.online { background: #1a3a2a; color: var(--success); }
    .status-badge.offline { background: #3a1a1a; color: var(--error); }
    .status-badge.free { background: #2a2a2a; color: var(--muted); }
    .status-badge.pro { background: #1a2a3a; color: #4fc3f7; }
    .status-badge.team { background: #2a1a3a; color: #ce93d8; }
    .status-badge.enterprise { background: #3a2a1a; color: #ffb74d; }

    .form-group { margin-bottom: 12px; }
    .form-group label {
      display: block;
      margin-bottom: 4px;
      font-size: 0.9em;
      color: var(--muted);
    }

    input[type="text"],
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 6px 10px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      font-size: 0.95em;
    }

    button {
      padding: 8px 16px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.95em;
      margin-right: 8px;
      margin-top: 4px;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.danger {
      background: #5a1a1a;
      color: var(--error);
    }

    .github-btn {
      background: #238636;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      justify-content: center;
    }
    .github-btn:hover { background: #2ea043; }

    .divider {
      display: flex;
      align-items: center;
      margin: 16px 0;
      color: var(--muted);
    }
    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid var(--border);
    }
    .divider span { padding: 0 12px; font-size: 0.85em; }

    .error-msg {
      color: var(--error);
      font-size: 0.9em;
      margin-top: 8px;
      display: none;
    }
    .error-msg.visible { display: block; }

    .plan-info {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-top: 12px;
    }
    .plan-info h3 { margin-bottom: 8px; }
    .plan-info .feature { color: var(--muted); font-size: 0.9em; }

    #logged-in-view { display: none; }
    #logged-out-view { display: none; }
    .loading { opacity: 0.6; pointer-events: none; }
  </style>
</head>
<body>
  <h1>🧠 Project Brain</h1>
  <p class="subtitle">Cloud Account</p>

  <div id="status-bar" class="section">
    <span id="online-badge" class="status-badge offline">Checking...</span>
    <span id="plan-badge" class="status-badge free" style="margin-left: 8px;">Free</span>
  </div>

  <div id="error-display" class="error-msg"></div>

  <!-- Logged Out View -->
  <div id="logged-out-view">
    <div class="section">
      <button class="github-btn" onclick="loginGitHub()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        Sign in with GitHub
      </button>
    </div>

    <div class="divider"><span>or</span></div>

    <div class="section">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" placeholder="you@example.com" />
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="Password" />
      </div>
      <button onclick="login()">Sign In</button>
      <button class="secondary" onclick="register()">Create Account</button>
    </div>
  </div>

  <!-- Logged In View -->
  <div id="logged-in-view">
    <div class="plan-info">
      <h3>Current Plan: <span id="plan-name">Free</span></h3>
      <div id="plan-features" class="feature"></div>
    </div>
    <div class="section" style="margin-top: 16px;">
      <button class="secondary" onclick="refresh()">Refresh Status</button>
      <button class="danger" onclick="logout()">Sign Out</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function login() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      if (!email || !password) {
        showError('Please enter email and password');
        return;
      }
      setLoading(true);
      vscode.postMessage({ type: 'login', email, password });
    }

    function loginGitHub() {
      setLoading(true);
      vscode.postMessage({ type: 'loginGitHub' });
    }

    function register() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      if (!email || !password) {
        showError('Please enter email and password');
        return;
      }
      setLoading(true);
      vscode.postMessage({ type: 'register', email, password });
    }

    function logout() {
      setLoading(true);
      vscode.postMessage({ type: 'logout' });
    }

    function refresh() {
      setLoading(true);
      vscode.postMessage({ type: 'refresh' });
    }

    function showError(msg) {
      const el = document.getElementById('error-display');
      el.textContent = msg;
      el.classList.add('visible');
      setTimeout(() => el.classList.remove('visible'), 5000);
    }

    function setLoading(state) {
      document.body.classList.toggle('loading', state);
    }

    const PLAN_FEATURES = {
      free: ['Local-only operation'],
      pro: ['Global Memory', 'Skill Marketplace', 'Model Router', 'Custom Skills (5)', 'Analytics'],
      team: ['Shared Memory', 'Team Skills', 'Team Analytics', 'Priority Support', '+ all Pro'],
      enterprise: ['SSO/SAML', 'Audit Logging', 'Custom Deploy', 'Dedicated Support', 'API Access', '+ all Team'],
    };

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type !== 'status') return;

      setLoading(false);

      // Online badge
      const ob = document.getElementById('online-badge');
      ob.textContent = msg.isOnline ? 'Online' : 'Offline';
      ob.className = 'status-badge ' + (msg.isOnline ? 'online' : 'offline');

      // Plan badge
      const pb = document.getElementById('plan-badge');
      pb.textContent = msg.plan.charAt(0).toUpperCase() + msg.plan.slice(1);
      pb.className = 'status-badge ' + msg.plan;

      // Views
      document.getElementById('logged-in-view').style.display = msg.authenticated ? 'block' : 'none';
      document.getElementById('logged-out-view').style.display = msg.authenticated ? 'none' : 'block';

      // Plan info
      document.getElementById('plan-name').textContent = msg.plan.charAt(0).toUpperCase() + msg.plan.slice(1);
      const features = PLAN_FEATURES[msg.plan] || [];
      document.getElementById('plan-features').innerHTML = features.map(f => '✓ ' + f).join('<br>');

      // Error
      if (msg.error) showError(msg.error);
    });

    // Request initial status
    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;

  }