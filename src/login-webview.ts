/**
 * Login Webview — Authentication UI for Project Brain SaaS.
 *
 * Provides a webview panel for:
 * - Email/password login
 * - GitHub OAuth (opens browser, receives callback)
 * - Registration (new account)
 * - Logout
 * - Display current auth + plan status
 *
 * Uses VS Code's webview API with message passing.
 */


import * as vscode from "vscode";
import type { SaaSClient } from "./saas-client";
import { getLoginHtml, type WebviewMessage, type StatusMessage } from "./login-webview-html";

// ─── LoginWebviewProvider ───────────────────────────────────────────────────

export class LoginWebviewProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private saasClient: SaaSClient,
    private extensionUri: vscode.Uri,
    private log: (msg: string) => void,
  ) {}

  /** Show the login webview panel. */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.sendStatus();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "projectBrainLogin",
      "Project Brain — Account",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables,
    );

    // Cleanup on close
    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      undefined,
      this.disposables,
    );

    // Send initial status
    await this.sendStatus();
  }

  /** Update the status display. */
  async sendStatus(error?: string): Promise<void> {
    if (!this.panel) return;

    const authenticated = await this.saasClient.isAuthenticated();
    const status: StatusMessage = {
      type: "status",
      authenticated,
      plan: this.saasClient.currentPlan,
      isOnline: this.saasClient.isOnline,
      error,
    };

    await this.panel.webview.postMessage(status);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // ─── Message Handlers ──────────────────────────────────────────────

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case "login":
          await this.handleLogin(message.email!, message.password!);
          break;
        case "loginGitHub":
          await this.handleGitHubLogin();
          break;
        case "register":
          await this.handleRegister(
            message.email!,
            message.password!,
            message.displayName,
          );
          break;
        case "logout":
          await this.handleLogout();
          break;
        case "refresh":
          await this.handleRefresh();
          break;
        case "getStatus":
          await this.sendStatus();
          break;
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`[LoginWebview] Error: ${errorMsg}`);
      await this.sendStatus(errorMsg);
    }
  }

  private async handleLogin(email: string, password: string): Promise<void> {
    await this.saasClient.login({ email, password });
    await this.saasClient.getLicense(); // Cache license
    await this.sendStatus();
    vscode.window.showInformationMessage(
      "Project Brain: Logged in successfully!",
    );
  }

  private async handleGitHubLogin(): Promise<void> {
    await this.saasClient.loginWithGitHub();
    await this.saasClient.getLicense();
    await this.sendStatus();
    vscode.window.showInformationMessage(
      "Project Brain: GitHub login successful!",
    );
  }

  private async handleRegister(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<void> {
    await this.saasClient.register({ email, password, displayName });
    await this.saasClient.getLicense();
    await this.sendStatus();
    if (displayName) {
      this.log(`[LoginWebview] Registered with display name: ${displayName}`);
    }
    vscode.window.showInformationMessage(
      "Project Brain: Account created! Welcome aboard!",
    );
  }

  private async handleLogout(): Promise<void> {
    await this.saasClient.logout();
    await this.sendStatus();
    vscode.window.showInformationMessage("Project Brain: Logged out.");
  }

  private async handleRefresh(): Promise<void> {
    await this.saasClient.refreshToken();
    await this.saasClient.getLicense();
    await this.sendStatus();
  }

  // ─── HTML ──────────────────────────────────────────────────────────


  // ��� HTML ��������������������������������������������������

  private getHtml(): string {
    return getLoginHtml();
  }
}