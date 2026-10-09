/**
 * SaaS Client — All communication with the Project Brain cloud backend.
 *
 * Responsibilities:
 * - Auth (login, GitHub OAuth, logout, token refresh)
 * - License verification with offline caching (24h grace period)
 * - Skill marketplace operations
 * - Global memory sync & search
 * - Project registration
 * - Automatic retry with exponential backoff
 * - Clock-drift protection using server Date header
 *
 * Tokens stored in VS Code SecretStorage (OS keychain).
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Plan = "free" | "pro" | "team" | "enterprise";

export type FeatureKey =
  | "global_memory"
  | "skill_marketplace"
  | "advanced_model_router"
  | "custom_skills"
  | "custom_personality"
  | "cron_reminders"
  | "team_shared_memory"
  | "team_skill_library"
  | "team_analytics"
  | "priority_support"
  | "analytics_dashboard"
  | "sso_saml"
  | "audit_logging"
  | "custom_deployment"
  | "dedicated_support"
  | "api_access"
  | "cloud_storage";

export type SearchScope =
  | "project"
  | "stack_specific"
  | "cross_project"
  | "universal";

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms
}

export interface License {
  userId: string;
  plan: Plan;
  role?: "user" | "admin" | "super_admin";
  isAdmin?: boolean;
  features: FeatureKey[];
  maxProjects: number;
  maxCustomSkills: number;
  expiresAt: string; // ISO date
  isTrialActive: boolean;
}

export interface ProjectInfo {
  name: string;
  pathHash: string;
  projectType?: string;
  stack?: string[];
}

export interface SkillFilter {
  tier?: Plan;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface SkillListing {
  id: string;
  name: string;
  slug: string;
  description: string;
  tier: Plan;
  version: string;
  category: string;
  author: string;
  downloads: number;
  isOfficial: boolean;
}

export interface SkillUpdate {
  skillId: string;
  currentVersion: string;
  newVersion: string;
}

export interface CustomSkill {
  name: string;
  slug: string;
  description: string;
  content: string;
  version: string;
}

export interface SyncResult {
  pushed: number;
  pulled: SyncedOpinion[];
  conflicts: SyncConflict[];
  syncVersion: number;
}

export interface SyncedOpinion {
  id: string;
  statement: string;
  category: string;
  confidence: number;
  scope: SearchScope;
  syncVersion: number;
  updatedAt?: string;
}

export interface SyncConflict {
  opinionId: string;
  localVersion: number;
  remoteVersion: number;
  resolution: "local_wins" | "remote_wins" | "manual";
}

export interface MemoryResult {
  id: string;
  statement: string;
  confidence: number;
  scope: SearchScope;
  similarity?: number;
  searchMethod?: "vector" | "text";
}

export interface QueuedOperation {
  type: string;
  payload: unknown;
  idempotencyKey?: string;
  createdAt?: string;
}

export interface PromptEntryResponse {
  id: string;
  tier: "basic" | "premium";
  category: string;
  version: number;
  /** AES-256-GCM encrypted content: base64(IV || ciphertext || authTag) */
  content: string;
}

export interface PromptsResponse {
  plan: Plan;
  promptCount: number;
  encrypted: boolean;
  /** Base64-encoded AES-256-GCM data key for decryption */
  dk: string;
  prompts: PromptEntryResponse[];
}

export interface FileUploadResult {
  version: number;
  contentHash: string;
  sizeBytes: number;
  r2Key: string;
}

export interface FileDownloadResult {
  content: string;
  version: number;
  contentHash: string;
}

export interface FileManifestEntry {
  filePath: string;
  contentHash: string;
  sizeBytes: number;
  version: number;
  syncedAt: string;
}

export interface FileManifest {
  projectId: string;
  files: FileManifestEntry[];
  totalSize: number;
}

export interface FileSyncDiff {
  toUpload: string[]; // Files newer locally
  toDownload: string[]; // Files newer remotely
  conflicts: string[]; // Both changed
  synced: string[]; // Already in sync
}

export interface FileVersionEntry {
  version: number;
  sizeBytes: number;
  snapshotAt: string;
}

export interface FileVersionList {
  filePath: string;
  projectId: string;
  versions: FileVersionEntry[];
  maxVersions: number;
}

export interface FileRestoreResult {
  restored: boolean;
  filePath: string;
  fromVersion: number;
  newVersion: number;
  sizeBytes: number;
}

export interface SaaSClientOptions {
  baseUrl: string;
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
}

// ─── Plan Feature Map ───────────────────────────────────────────────────────

const PLAN_FEATURES: Record<Plan, FeatureKey[]> = {
  free: [],
  pro: [
    "global_memory",
    "skill_marketplace",
    "advanced_model_router",
    "custom_skills",
    "custom_personality",
    "cron_reminders",
    "analytics_dashboard",
    "cloud_storage",
  ],
  team: [
    "global_memory",
    "skill_marketplace",
    "advanced_model_router",
    "custom_skills",
    "custom_personality",
    "cron_reminders",
    "analytics_dashboard",
    "team_shared_memory",
    "team_skill_library",
    "team_analytics",
    "priority_support",
    "cloud_storage",
  ],
  enterprise: [
    "global_memory",
    "skill_marketplace",
    "advanced_model_router",
    "custom_skills",
    "custom_personality",
    "cron_reminders",
    "analytics_dashboard",
    "team_shared_memory",
    "team_skill_library",
    "team_analytics",
    "priority_support",
    "sso_saml",
    "audit_logging",
    "custom_deployment",
    "dedicated_support",
    "api_access",
    "cloud_storage",
  ],
};

// ─── Constants ──────────────────────────────────────────────────────────────

const SECRET_ACCESS_TOKEN = "projectbrain.auth.accessToken";
const SECRET_REFRESH_TOKEN = "projectbrain.auth.refreshToken";
const STATE_LICENSE_CACHE = "projectbrain.license.cache";
const STATE_SERVER_TIME = "projectbrain.server.lastKnownTime";
const STATE_TOKEN_EXPIRES_AT = "projectbrain.auth.tokenExpiresAt";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min, matching server
const LICENSE_GRACE_HOURS = 24; // SECURITY (MED-02): Reduced from 72h to 24h
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ─── SaaSClient ─────────────────────────────────────────────────────────────

export class SaaSClient {
  private baseUrls: string[];
  private activeBaseUrlIndex: number = 0;
  private context: vscode.ExtensionContext;
  private log: (msg: string) => void;
  private cachedLicense: License | null = null;
  private cachedLicenseAt: number = 0;
  private explicitlyLoggedOut: boolean = false;
  private lastKnownServerTime: number = 0;
  private accessTokenExpiresAt: number = 0;
  private _isOnline: boolean = false;
  private cacheHmacKey: string = ""; // MED-02: HMAC key for cache integrity

  /** Event emitter for SaaS events (forbidden, etc.) */
  readonly events = new EventEmitter();

  private static readonly DEFAULT_FALLBACK_URLS = [
    "https://api.projectbrain.tech",
  ];

  constructor(options: SaaSClientOptions) {
    const configured = options.baseUrl.replace(/\/$/, "");
    const candidates = [
      configured,
      ...SaaSClient.DEFAULT_FALLBACK_URLS.map((url) => url.replace(/\/$/, "")),
    ];
    this.baseUrls = Array.from(
      new Set(candidates.filter((u) => u && (u.startsWith("http://") || u.startsWith("https://")))),
    );
    if (this.baseUrls.length === 0) {
      this.baseUrls = [...SaaSClient.DEFAULT_FALLBACK_URLS];
    }
    this.activeBaseUrlIndex = 0;
    this.context = options.context;
    this.log = options.log;

    this.log(`[SaaSClient] API base candidates: ${this.baseUrls.join(" -> ")}`);

    // Bypass VS Code proxy for our API domains — SOCKS5 proxies cause
    // "Invalid URL protocol" errors with Node.js fetch (undici)
    this.bypassProxyForApiDomains();

    // MED-02: Derive HMAC key from extension URI (unique per machine + extension install)
    this.cacheHmacKey =
      `pb-cache-${this.context.extension.id}-${this.context.globalStorageUri.fsPath}`.substring(
        0,
        64,
      );

    // Restore cached server time
    const storedTime = this.context.globalState.get<number>(STATE_SERVER_TIME);
    if (storedTime) {
      this.lastKnownServerTime = storedTime;
    }

    // Restore cached license (with HMAC validation)
    const cached = this.context.globalState.get<{
      license: License;
      cachedAt: number;
      hmac?: string;
    }>(STATE_LICENSE_CACHE);
    if (cached && this.verifyCacheHmac(cached)) {
      this.cachedLicense = cached.license;
      this.cachedLicenseAt = cached.cachedAt;
    } else if (cached) {
      this.log(
        "[SaaSClient] License cache HMAC invalid — ignoring cached license",
      );
      void this.context.globalState.update(STATE_LICENSE_CACHE, undefined);
    }

    // Restore cached token expiry so proactive refresh works after restart
    const storedExpiry = this.context.globalState.get<number>(
      STATE_TOKEN_EXPIRES_AT,
    );
    if (storedExpiry && storedExpiry > 0) {
      this.accessTokenExpiresAt = storedExpiry;
    }
  }

  private bypassProxyForApiDomains(): void {
    const hosts = this.baseUrls
      .map((u) => { try { return new URL(u).hostname; } catch { return ""; } })
      .filter(Boolean);
    if (hosts.length === 0) return;
    const current = process.env["NO_PROXY"] || process.env["no_proxy"] || "";
    const missing = hosts.filter((h) => !current.includes(h));
    if (missing.length > 0) {
      const updated = current ? `${current},${missing.join(",")}` : missing.join(",");
      process.env["NO_PROXY"] = updated;
      this.log(`[SaaSClient] Set NO_PROXY: ${updated}`);
    }
  }

  private get activeBaseUrl(): string {
    return this.baseUrls[this.activeBaseUrlIndex] ?? this.baseUrls[0] ?? "";
  }

  private rotateBaseUrl(reason: string): boolean {
    if (this.baseUrls.length < 2) return false;
    const previousIndex = this.activeBaseUrlIndex;
    const nextIndex = (this.activeBaseUrlIndex + 1) % this.baseUrls.length;
    if (nextIndex === previousIndex) return false;

    this.activeBaseUrlIndex = nextIndex;
    this.log(
      `[SaaSClient] Switched API base (${reason}): ${this.baseUrls[previousIndex]} -> ${this.baseUrls[nextIndex]}`,
    );
    return true;
  }

  // ─── Auth ──────────────────────────────────────────────────────────
  /** Register a new account with email + password. */
  async register(
    credentials: LoginCredentials & { displayName?: string },
  ): Promise<AuthToken> {
    const res = await this.request<AuthToken>("POST", "/auth/register", {
      body: credentials,
      noAuth: true,
    });

    await this.storeTokens(res);
    this.log("[SaaSClient] Registration successful");
    return res;
  }
  /** Login with email + password. */
  async login(credentials: LoginCredentials): Promise<AuthToken> {
    const res = await this.request<AuthToken>("POST", "/auth/login", {
      body: credentials,
      noAuth: true,
    });

    await this.storeTokens(res);
    this.log("[SaaSClient] Login successful");
    return res;
  }

  /** Start GitHub OAuth flow using VS Code URI handler. */
  async loginWithGitHub(): Promise<AuthToken> {
    // Open browser for GitHub OAuth
    const callbackUri = await vscode.env.asExternalUri(
      vscode.Uri.parse(
        `${vscode.env.uriScheme}://crismart.project-brain/auth/callback`,
      ),
    );

    // Use base64url to avoid double-encoding by vscode.Uri.parse()
    // (Uri.parse partially decodes %3A/%2F but not %3F/%3D, then
    //  toString re-encodes % → %25, corrupting the redirect_uri)
    const callbackStr = callbackUri.toString(true);
    const redirectB64 = Buffer.from(callbackStr).toString("base64url");
    const authUrl = `${this.activeBaseUrl}/api/auth/github/init?redirect_b64=${redirectB64}`;
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    // Wait for callback via URI handler
    const token = await new Promise<AuthToken>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("GitHub OAuth timed out")),
        120_000,
      );

      const disposable = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
          clearTimeout(timeout);
          disposable.dispose();

          const params = new URLSearchParams(uri.query);
          const accessToken = params.get("access_token");
          const refreshToken = params.get("refresh_token");
          const expiresAt = params.get("expires_at");

          if (!accessToken || !refreshToken || !expiresAt) {
            reject(new Error("Invalid OAuth callback parameters"));
            return;
          }

          resolve({
            accessToken,
            refreshToken,
            expiresAt: parseInt(expiresAt, 10),
          });
        },
      });
    });

    await this.storeTokens(token);
    this.log("[SaaSClient] GitHub OAuth login successful");
    return token;
  }

  /** Logout — invalidate all tokens. */
  async logout(): Promise<void> {
    // Clear local tokens FIRST for instant UI response
    await this.clearTokens();
    this.cachedLicense = null;
    this.cachedLicenseAt = 0;
    this.explicitlyLoggedOut = true;
    this.events.emit("logout");
    this.log("[SaaSClient] Logged out");

    // Best-effort server-side token invalidation (fire-and-forget)
    try {
      void this.request("DELETE", "/auth/logout").catch(() => {});
    } catch {
      // Ignore — local logout already complete
    }
  }

  /** Refresh the access token using the stored refresh token. */
  async refreshToken(): Promise<AuthToken> {
    const refreshTok = await this.context.secrets.get(SECRET_REFRESH_TOKEN);
    if (!refreshTok) {
      throw new Error("No refresh token available — please log in again");
    }

    const res = await this.request<AuthToken>("POST", "/auth/refresh", {
      body: { refreshToken: refreshTok },
      noAuth: true,
    });

    await this.storeTokens(res);
    this.log("[SaaSClient] Token refreshed");
    return res;
  }

  /** Check if user is authenticated (has stored tokens or sandbox override). */
  async isAuthenticated(): Promise<boolean> {
    if (this.explicitlyLoggedOut) return false;
    if (this.getSandboxLicenseOverride()) return true;
    const token = await this.context.secrets.get(SECRET_ACCESS_TOKEN);
    return !!token;
  }

  // ─── License ───────────────────────────────────────────────────────

  /** Get current license, using cache when offline. */
  async getLicense(): Promise<License> {
    // Sandbox tier override via env vars (PB_SANDBOX_TIER, PB_SANDBOX_ROLE)
    const sandboxOverride = this.getSandboxLicenseOverride();
    if (sandboxOverride) {
      this.cachedLicense = sandboxOverride;
      this.cachedLicenseAt = Date.now();
      return sandboxOverride;
    }

    // Try fresh from server
    try {
      const oldPlan = this.cachedLicense?.plan ?? "free";
      const license = await this.request<License>("GET", "/license");
      this.cachedLicense = license;
      this.cachedLicenseAt = Date.now();
      // MED-02: Sign cache with HMAC before persisting
      const cachePayload = {
        license,
        cachedAt: this.cachedLicenseAt,
        hmac: this.computeCacheHmac(license, this.cachedLicenseAt),
      };
      await this.context.globalState.update(STATE_LICENSE_CACHE, cachePayload);
      // Emit planChanged when plan upgrades or downgrades
      if (oldPlan !== license.plan) {
        this.events.emit("planChanged", { from: oldPlan, to: license.plan });
      }
      return license;
    } catch {
      // Offline fallback
      if (this.cachedLicense && this.isLicenseCacheValid()) {
        this.log("[SaaSClient] Using cached license (offline)");
        return this.cachedLicense;
      }
      // No valid cache — return free tier
      this.log("[SaaSClient] No valid license cache — defaulting to free tier");
      return this.freeLicense();
    }
  }

  /**
   * Require a valid authenticated session and fetch license from server.
   * Unlike getLicense(), this NEVER falls back to free tier on failure.
   */
  async requireAuthenticatedLicense(): Promise<License> {
    // Sandbox override bypasses auth + server
    const sandboxOverride = this.getSandboxLicenseOverride();
    if (sandboxOverride) {
      this.cachedLicense = sandboxOverride;
      this.cachedLicenseAt = Date.now();
      return sandboxOverride;
    }

    const isAuth = await this.isAuthenticated();
    if (!isAuth) {
      throw new SaaSError("Not authenticated", 401);
    }

    const license = await this.request<License>("GET", "/license");
    this.cachedLicense = license;
    this.cachedLicenseAt = Date.now();

    const cachePayload = {
      license,
      cachedAt: this.cachedLicenseAt,
      hmac: this.computeCacheHmac(license, this.cachedLicenseAt),
    };
    await this.context.globalState.update(STATE_LICENSE_CACHE, cachePayload);

    return license;
  }

  /** Check if user has access to a specific feature. */
  checkAccess(feature: FeatureKey): boolean {
    if (!this.cachedLicense) return false;

    // Clock-drift protection: if local time < last known server time,
    // treat license as expired (possible clock manipulation)
    if (Date.now() < this.lastKnownServerTime) {
      this.log("[SaaSClient] Clock drift detected — denying access");
      return false;
    }

    return this.cachedLicense.features.includes(feature);
  }

  /** Get the current plan from cached license. */
  get currentPlan(): Plan {
    return this.cachedLicense?.plan ?? "free";
  }

  /** Whether the current user has admin privileges. */
  get isAdmin(): boolean {
    return this.cachedLicense?.isAdmin === true;
  }

  /** Whether the client believes it's online. */
  get isOnline(): boolean {
    return this._isOnline;
  }

  // ─── Skills ────────────────────────────────────────────────────────

  /** List marketplace skills with optional filters. */
  async listMarketplaceSkills(filters?: SkillFilter): Promise<SkillListing[]> {
    const params = new URLSearchParams();
    if (filters?.tier) params.set("tier", filters.tier);
    if (filters?.category) params.set("category", filters.category);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.page) params.set("page", String(filters.page));
    if (filters?.limit) params.set("limit", String(filters.limit));

    const query = params.toString();
    const path = `/skills${query ? `?${query}` : ""}`;
    const res = await this.request<{ skills: SkillListing[] }>("GET", path);
    return res.skills;
  }

  /** Install a skill from the marketplace. */
  async installSkill(skillId: string): Promise<void> {
    await this.request("POST", `/skills/${skillId}/install`);
    this.log(`[SaaSClient] Installed skill ${skillId}`);
  }

  /** Uninstall a skill. */
  async uninstallSkill(skillId: string): Promise<void> {
    await this.request("DELETE", `/skills/${skillId}/install`);
    this.log(`[SaaSClient] Uninstalled skill ${skillId}`);
  }

  /** Check for skill updates. */
  async getSkillUpdates(): Promise<SkillUpdate[]> {
    const res = await this.request<{ updates: SkillUpdate[] }>(
      "GET",
      "/skills/updates",
    );
    return res.updates;
  }

  /** Get full skill content by ID (lazy-load for remote skills). */
  async getSkillContent(
    skillId: string,
  ): Promise<{ content: string; description: string }> {
    const res = await this.request<{ content: string; description: string }>(
      "GET",
      `/skills/${skillId}`,
    );
    return { content: res.content ?? "", description: res.description ?? "" };
  }

  /** Publish a custom skill to the marketplace. */
  async publishSkill(skill: CustomSkill): Promise<void> {
    await this.request("POST", "/skills/publish", { body: skill });
    this.log(`[SaaSClient] Published skill "${skill.name}"`);
  }

  // ─── Tab Config ─────────────────────────────────────────────────────

  /** Fetch resolved tab visibility config for the current user. */
  async fetchTabConfig(): Promise<{ tabId: string; visible: boolean }[]> {
    try {
      const res = await this.request<{
        tabs: { tabId: string; visible: boolean; source: string }[];
      }>("GET", "/config/tabs");
      return res.tabs.map((t) => ({ tabId: t.tabId, visible: t.visible }));
    } catch (e) {
      this.log(`[SaaSClient] fetchTabConfig failed: ${e}`);
      return []; // empty = all visible (default)
    }
  }

  // ─── Extension Updates ─────────────────────────────────────────────

  /** Check latest available extension version from server. */
  async checkExtensionUpdate(): Promise<{
    available: boolean;
    version?: string;
    publishedAt?: string;
    changelog?: string;
    size?: number;
  }> {
    try {
      const res = await this.request<{
        available: boolean;
        version?: string;
        publishedAt?: string;
        changelog?: string;
        size?: number;
      }>("GET", "/config/extension/latest");
      return res;
    } catch (e) {
      this.log(`[SaaSClient] checkExtensionUpdate failed: ${e}`);
      return { available: false };
    }
  }

  /** Download the latest VSIX as a buffer. */
  async downloadExtensionVsix(): Promise<Buffer | null> {
    try {
      const token = await this.getValidAccessToken();
      const url = `${this.activeBaseUrl}/api/config/extension/download`;
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(url, { method: "GET", headers });
      if (!response.ok) {
        this.log(`[SaaSClient] downloadExtensionVsix HTTP ${response.status}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      this.log(
        `[SaaSClient] Downloaded VSIX (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`,
      );
      return Buffer.from(arrayBuffer);
    } catch (e) {
      this.log(`[SaaSClient] downloadExtensionVsix failed: ${e}`);
      return null;
    }
  }

  /** Publish a VSIX to the server (admin only). */
  async publishExtension(
    vsixBuffer: Buffer,
    version: string,
    changelog?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.request<{ success: boolean }>(
        "POST",
        "/admin/extension/publish",
        {
          body: {
            vsix: vsixBuffer.toString("base64"),
            version,
            changelog: changelog ?? "",
          },
        },
      );
      this.log(`[SaaSClient] Published extension v${version}`);
      return { success: res.success };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[SaaSClient] publishExtension failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ─── Prompts ───────────────────────────────────────────────────────

  /** Fetch premium prompts gated by the user's plan. */
  async getPrompts(): Promise<PromptsResponse> {
    const res = await this.request<PromptsResponse>("GET", "/prompts");
    return res;
  }

  // ─── Global Memory ─────────────────────────────────────────────────

  /** Sync local opinions with the cloud. */
  async syncOpinions(
    local: SyncedOpinion[],
    lastSyncVersion?: number,
  ): Promise<SyncResult> {
    return this.request<SyncResult>("POST", "/memory/sync", {
      body: {
        opinions: local,
        lastSyncVersion: lastSyncVersion ?? 0,
      },
    });
  }

  /** Search the global memory via pgvector similarity. */
  async searchGlobalMemory(
    query: string,
    scope?: SearchScope,
    limit = 10,
  ): Promise<MemoryResult[]> {
    const res = await this.request<{ results: MemoryResult[] }>(
      "POST",
      "/memory/search",
      {
        body: { query, scope, limit },
      },
    );
    return res.results;
  }

  /** Register or update a project in the cloud. */
  async registerProject(info: ProjectInfo): Promise<string> {
    const res = await this.request<{ projectId: string }>(
      "POST",
      "/memory/project",
      { body: info },
    );
    return res.projectId;
  }

  // ─── Cloud File Storage ────────────────────────────────────────────

  /**
   * Upload a memory file to cloud storage (R2).
   * Encrypts server-side with user's derived key.
   */
  async uploadFile(
    projectId: string,
    filePath: string,
    content: string,
    forceOverwrite = false,
  ): Promise<FileUploadResult | null> {
    try {
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      const extraHeaders: Record<string, string> = {};
      if (forceOverwrite) {
        extraHeaders["X-Force-Overwrite"] = "true";
      }
      return await this.request<FileUploadResult>(
        "PUT",
        `/files/${projectId}/${encodedPath}`,
        {
          body: { content },
          extraHeaders,
        },
      );
    } catch (err) {
      // Auto-retry with force if shrinkage guard triggered
      if (
        !forceOverwrite &&
        err instanceof Error &&
        err.message.includes("Content shrinkage detected")
      ) {
        this.log(
          `[SaaSClient] Shrinkage guard hit for ${filePath} — retrying with force`,
        );
        return this.uploadFile(projectId, filePath, content, true);
      }
      this.log(
        `[SaaSClient] Upload failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Download and decrypt a memory file from cloud storage.
   */
  async downloadFile(
    projectId: string,
    filePath: string,
  ): Promise<FileDownloadResult | null> {
    try {
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      return await this.request<FileDownloadResult>(
        "GET",
        `/files/${projectId}/${encodedPath}`,
      );
    } catch (err) {
      this.log(
        `[SaaSClient] Download failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Get the cloud manifest for a project (list of all files + hashes).
   * Used for diff-based sync.
   */
  async getFileManifest(projectId: string): Promise<FileManifest | null> {
    try {
      return await this.request<FileManifest>(
        "GET",
        `/files/${projectId}/manifest`,
      );
    } catch (err) {
      this.log(
        `[SaaSClient] Manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Batch sync: send local file hashes, receive diff instructions.
   * The server compares hashes and tells us what to upload/download.
   */
  async batchSync(
    projectId: string,
    localFiles: Array<{ path: string; hash: string }>,
  ): Promise<FileSyncDiff | null> {
    try {
      return await this.request<FileSyncDiff>(
        "POST",
        `/files/${projectId}/sync`,
        {
          body: { files: localFiles },
        },
      );
    } catch (err) {
      this.log(
        `[SaaSClient] Batch sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Delete a file from cloud storage (soft-delete).
   */
  async deleteFile(projectId: string, filePath: string): Promise<boolean> {
    try {
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      await this.request("DELETE", `/files/${projectId}/${encodedPath}`);
      return true;
    } catch (err) {
      this.log(
        `[SaaSClient] Delete failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Purge ALL cloud files for a project.
   * Hard-deletes from R2, soft-deletes from DB, frees storage.
   * Returns count of purged files and bytes freed.
   */
  async purgeProjectFiles(
    projectId: string,
  ): Promise<{ purged: number; totalBytesFreed: number } | null> {
    try {
      return await this.request<{ purged: number; totalBytesFreed: number }>(
        "DELETE",
        `/files/${projectId}`,
      );
    } catch (err) {
      this.log(
        `[SaaSClient] Purge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * List versioned snapshots for a file.
   * Returns historical versions that can be restored.
   */
  async listFileVersions(
    projectId: string,
    filePath: string,
  ): Promise<FileVersionList | null> {
    try {
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      return await this.request<FileVersionList>(
        "GET",
        `/files/${projectId}/versions/${encodedPath}`,
      );
    } catch (err) {
      this.log(
        `[SaaSClient] List versions failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Restore a file from a versioned snapshot.
   * The current version is auto-snapshotted before restoring (reversible).
   */
  async restoreFileVersion(
    projectId: string,
    filePath: string,
    version: number,
  ): Promise<FileRestoreResult | null> {
    try {
      return await this.request<FileRestoreResult>(
        "POST",
        `/files/${projectId}/restore`,
        {
          body: { filePath, version },
        },
      );
    } catch (err) {
      this.log(
        `[SaaSClient] Restore failed (${filePath} v${version}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ─── Health ────────────────────────────────────────────────────────

  /** Ping the backend to check connectivity. */
  async ping(): Promise<boolean> {
    for (let i = 0; i < this.baseUrls.length; i++) {
      const targetIndex = (this.activeBaseUrlIndex + i) % this.baseUrls.length;
      const targetBaseUrl = this.baseUrls[targetIndex];
      if (!targetBaseUrl || !(targetBaseUrl.startsWith("http://") || targetBaseUrl.startsWith("https://"))) {
        this.log(`[SaaSClient] Skipping invalid baseUrl in ping: "${targetBaseUrl}"`);
        continue;
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await fetch(`${targetBaseUrl}/api/health/live`, {
            method: "GET",
            signal: controller.signal,
          });
          if (response.ok) {
            this.activeBaseUrlIndex = targetIndex;
            this._isOnline = true;
            return true;
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // try next candidate
      }
    }

    this._isOnline = false;
    return false;
  }

  // ─── Generic Execute (for OfflineManager queue flush) ──────────────

  /** Execute a queued operation against the API. */
  async execute(op: QueuedOperation, idempotencyKey?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const methodMap: Record<string, string> = {
      sync_opinions: "POST",
      search_memory: "POST",
      register_project: "POST",
      install_skill: "POST",
      uninstall_skill: "DELETE",
      publish_skill: "POST",
      track_analytics: "POST",
    };

    const pathMap: Record<string, string> = {
      sync_opinions: "/memory/sync",
      search_memory: "/memory/search",
      register_project: "/memory/project",
      install_skill: `/skills/${(op.payload as { skillId?: string })?.skillId}/install`,
      uninstall_skill: `/skills/${(op.payload as { skillId?: string })?.skillId}/install`,
      publish_skill: "/skills/publish",
      track_analytics: "/analytics/event",
    };

    const method = methodMap[op.type] ?? "POST";
    const path = pathMap[op.type];
    if (!path) {
      throw new Error(`Unknown operation type: ${op.type}`);
    }

    await this.request(method, path, {
      body: op.payload,
      extraHeaders: headers,
    });
  }

  // ─── Internal HTTP ─────────────────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      noAuth?: boolean;
      maxRetries?: number;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<T> {
    const retries = options?.maxRetries ?? MAX_RETRIES;

    for (let attempt = 0; attempt < retries; attempt++) {
      const baseUrl = this.activeBaseUrl;
      if (!baseUrl || !(baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
        this.log(`[SaaSClient] Invalid baseUrl: "${baseUrl}" (baseUrls=${JSON.stringify(this.baseUrls)}, index=${this.activeBaseUrlIndex})`);
        throw new SaaSError(
          `Invalid API URL — check projectBrain.saas.apiUrl setting (got: "${baseUrl}")`,
          0,
        );
      }
      const url = `${baseUrl}/api${path}`;
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(options?.extraHeaders ?? {}),
        };

        // Add auth header
        if (!options?.noAuth) {
          const token = await this.getValidAccessToken();
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
        }

        const fetchOptions: RequestInit = {
          method,
          headers,
          ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
        };

        const response = await fetch(url, fetchOptions);

        // Track server time for clock-drift protection
        const serverDate = response.headers.get("Date");
        if (serverDate) {
          const serverTime = new Date(serverDate).getTime();
          if (!isNaN(serverTime)) {
            this.lastKnownServerTime = serverTime;
            await this.context.globalState.update(
              STATE_SERVER_TIME,
              serverTime,
            );
          }
        }

        this._isOnline = true;

        // Handle 401 — try token refresh once
        if (response.status === 401 && !options?.noAuth && attempt === 0) {
          try {
            await this.refreshToken();
            continue; // Retry with new token
          } catch {
            this.events.emit("authExpired");
            throw new SaaSError(
              "Authentication expired — please log in again",
              401,
            );
          }
        }

        if (!response.ok) {
          const errorBody = await response.text();
          let message: string;
          try {
            const parsed = JSON.parse(errorBody);
            message = parsed.error ?? parsed.message ?? errorBody;
          } catch {
            message = errorBody;
          }

          // Emit forbidden event for upgrade prompts
          if (response.status === 403) {
            this.events.emit("forbidden", { path, message });
          }

          throw new SaaSError(message, response.status);
        }

        // 204 No Content
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof SaaSError) {
          if (error.statusCode >= 500) {
            this.rotateBaseUrl(`HTTP ${error.statusCode} on ${path}`);
          }

          // Don't retry client errors (4xx) except 401 (handled above) and 429
          if (
            error.statusCode >= 400 &&
            error.statusCode < 500 &&
            error.statusCode !== 429
          ) {
            throw error;
          }
        } else {
          this.rotateBaseUrl(`network error on ${path}`);
        }

        this._isOnline = false;

        // Retry with exponential backoff
        if (attempt < retries - 1) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          const errMsg = error instanceof Error ? error.message : String(error);
          this.log(
            `[SaaSClient] Request failed (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms — ${method} ${path} — ${errMsg}`,
          );
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw error;
        }
      }
    }

    throw new SaaSError("Request failed after all retries", 0);
  }

  /** Get a valid access token, refreshing if needed. */
  private async getValidAccessToken(): Promise<string | undefined> {
    const token = await this.context.secrets.get(SECRET_ACCESS_TOKEN);
    if (!token) return undefined;

    // If we know it's expired, refresh proactively
    if (
      this.accessTokenExpiresAt > 0 &&
      Date.now() >= this.accessTokenExpiresAt - 60_000
    ) {
      try {
        await this.refreshToken();
        return this.context.secrets.get(SECRET_ACCESS_TOKEN);
      } catch {
        return token; // Try the old one — server will 401 if truly expired
      }
    }

    return token;
  }

  private async storeTokens(token: AuthToken): Promise<void> {
    this.explicitlyLoggedOut = false;
    await this.context.secrets.store(SECRET_ACCESS_TOKEN, token.accessToken);
    await this.context.secrets.store(SECRET_REFRESH_TOKEN, token.refreshToken);
    // Backward compat: if server didn't send expiresAt, estimate it (now + 15min)
    const expiresAt =
      token.expiresAt && token.expiresAt > 0
        ? token.expiresAt
        : Date.now() + ACCESS_TOKEN_TTL_MS;
    this.accessTokenExpiresAt = expiresAt;
    await this.context.globalState.update(STATE_TOKEN_EXPIRES_AT, expiresAt);
  }

  private async clearTokens(): Promise<void> {
    await this.context.secrets.delete(SECRET_ACCESS_TOKEN);
    await this.context.secrets.delete(SECRET_REFRESH_TOKEN);
    this.accessTokenExpiresAt = 0;
    await this.context.globalState.update(STATE_TOKEN_EXPIRES_AT, undefined);
  }

  /** Check if the cached license is still within the 24h grace period. */
  private isLicenseCacheValid(): boolean {
    if (!this.cachedLicenseAt) return false;

    const graceMs = LICENSE_GRACE_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    // Clock-drift: if local time is before last known server time, invalid
    if (now < this.lastKnownServerTime) {
      return false;
    }

    return now - this.cachedLicenseAt < graceMs;
  }

  // SECURITY (MED-02): HMAC signing for license cache integrity
  private computeCacheHmac(license: License, cachedAt: number): string {
    // Simple hash: plan + features + expiresAt + cachedAt + key
    const data = `${license.plan}:${license.features.sort().join(",")}:${license.expiresAt}:${cachedAt}:${this.cacheHmacKey}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `v1:${Math.abs(hash).toString(36)}`;
  }

  private verifyCacheHmac(cached: {
    license: License;
    cachedAt: number;
    hmac?: string;
  }): boolean {
    if (!cached.hmac) return false; // Legacy cache without HMAC — reject
    const expected = this.computeCacheHmac(cached.license, cached.cachedAt);
    return cached.hmac === expected;
  }

  /**
   * Write a plan-cache file for hooks to read.
   * Hooks are standalone Node.js scripts without VS Code API access,
   * so they read this file to know the current plan.
   */
  writePlanCache(folderPaths: string[]): void {
    // Skip writing in development mode (Extension Development Host)
    // to avoid overwriting the production plan cache on disk
    if (this.context.extensionMode === vscode.ExtensionMode.Development) {
      this.log("[SaaSClient] Dev mode — skipping plan cache write");
      return;
    }
    const data = JSON.stringify({
      plan: this.currentPlan,
      features: this.cachedLicense?.features ?? [],
      updatedAt: new Date().toISOString(),
    });
    for (const folder of folderPaths) {
      try {
        const sessionsDir = path.join(folder, "docs", "memory", "sessions");
        if (!fs.existsSync(sessionsDir)) {
          fs.mkdirSync(sessionsDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(sessionsDir, ".plan-cache.json"),
          data,
          "utf8",
        );
      } catch {
        // Non-fatal — hooks degrade gracefully
      }
    }
  }

  /** Return a free-tier license placeholder. */
  private freeLicense(): License {
    return {
      userId: "",
      plan: "free",
      features: [],
      maxProjects: 0,
      maxCustomSkills: 0,
      expiresAt: new Date(0).toISOString(),
      isTrialActive: false,
    };
  }

  /**
   * Read PB_SANDBOX_TIER and PB_SANDBOX_ROLE env vars.
   * Returns a synthetic license when present, null otherwise.
   */
  private getSandboxLicenseOverride(): License | null {
    const tier = process.env.PB_SANDBOX_TIER as Plan | undefined;
    if (!tier || !["free", "pro", "team", "enterprise"].includes(tier)) {
      return null;
    }
    const role =
      (process.env.PB_SANDBOX_ROLE as "user" | "admin" | "super_admin") ??
      "user";
    const isAdmin = role === "admin" || role === "super_admin";
    const features = PLAN_FEATURES[tier] ?? [];

    this.log(
      `[SaaSClient] Sandbox override active — tier=${tier}, role=${role}`,
    );

    return {
      userId: `sandbox-${tier}-${role}`,
      plan: tier,
      role,
      isAdmin,
      features,
      maxProjects: tier === "free" ? 1 : tier === "pro" ? 10 : 50,
      maxCustomSkills: tier === "free" ? 0 : tier === "pro" ? 5 : 25,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      isTrialActive: false,
    };
  }
}

// ─── Error type ─────────────────────────────────────────────────────────────

export class SaaSError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SaaSError";
  }
}
