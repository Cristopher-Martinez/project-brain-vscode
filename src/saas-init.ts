// ─── SaaS Layer Initialization (extracted from extension.ts) ────────────────
// Responsibility: SaaSClient, OfflineManager, MemoryFS, CloudSync, SkillManager,
// DualOpinionBank, AdminDB, LoginWebview, UpgradePrompts, 403 handler
import * as path from "path";
import * as vscode from "vscode";
import { AdminDB } from "./admin-db";
import type { CronScheduler } from "./cron-scheduler";
import { DualOpinionBank } from "./dual-opinion-bank";
import type { FolderState } from "./extension-types";
import { LoginWebviewProvider } from "./login-webview";
import { OfflineManager } from "./offline-manager";
import type { OpinionBank } from "./opinion-bank";
import type { PromptLoader } from "./prompt-loader";
import { SaaSClient } from "./saas-client";
import { SkillManager } from "./skill-manager";
import type { BrainTreeDataProvider } from "./tree-view";
import { UpgradePromptManager } from "./upgrade-prompts";

export interface SaaSInitOpts {
  context: vscode.ExtensionContext;
  primaryFolder: vscode.WorkspaceFolder;
  memoryPath: string;
  opinionBank: OpinionBank;
  folderStates: Map<string, FolderState>;
  treeDataProvider: BrainTreeDataProvider;
  promptLoader: PromptLoader;
  lmToolRefs: {
    awaken: { setSaaSClient(c: SaaSClient): void };
    toolbox: { setSaaSClient(c: SaaSClient): void };
    searchMemory: { setSaaSClient(c: SaaSClient): void };
    getContext: { setSaaSClient(c: SaaSClient): void };
  };
  projectPathHash: (fsPath: string) => string;
  log: (msg: string) => void;
  getCronScheduler: () => CronScheduler | null;
  getSkillManager: () => SkillManager | null;
  setSkillManager: (v: SkillManager | null) => void;
  getDualOpinionBank: () => DualOpinionBank | null;
}

export interface SaaSInitResult {
  saasClient: SaaSClient;
  offlineManager: OfflineManager | null;
  dualOpinionBank: DualOpinionBank | null;
  skillManager: SkillManager | null;
  loginWebview: LoginWebviewProvider | null;
  upgradePrompts: UpgradePromptManager | null;
  adminDb: AdminDB | null;
  memoryFS: import("./memory-fs").MemoryFS | null;
  cloudSync: import("./cloud-sync").CloudSync | null;
  licenseRefreshPromise: Promise<void>;
}

export function initializeSaaSLayer(opts: SaaSInitOpts): SaaSInitResult {
  const {
    context,
    primaryFolder,
    memoryPath,
    opinionBank,
    folderStates,
    treeDataProvider,
    promptLoader,
    lmToolRefs,
    projectPathHash,
    log,
  } = opts;

  const saasConfig = vscode.workspace.getConfiguration("projectBrain.saas");
  let saasApiUrl = saasConfig.get<string>(
    "apiUrl",
    "https://api.projectbrain.tech",
  );

  // Validate API URL — fallback to default if empty/invalid
  if (
    !saasApiUrl ||
    !(
      saasApiUrl.startsWith("http://") || saasApiUrl.startsWith("https://")
    )
  ) {
    saasApiUrl = "https://api.projectbrain.tech";
    log(
      `[SaaS] Invalid API URL in config, using default: ${saasApiUrl}`,
    );
  }

  // 1. SaaSClient — HTTP client for all cloud communication
  const saasClient = new SaaSClient({ baseUrl: saasApiUrl, context, log });
  promptLoader.setSaaSClient(saasClient);
  lmToolRefs.awaken.setSaaSClient(saasClient);
  lmToolRefs.toolbox.setSaaSClient(saasClient);
  lmToolRefs.searchMemory.setSaaSClient(saasClient);
  lmToolRefs.getContext.setSaaSClient(saasClient);

  const getCurrentFolderPaths = () =>
    [...folderStates.keys()].map((uri) => vscode.Uri.parse(uri).fsPath);
  saasClient.writePlanCache(getCurrentFolderPaths());

  const licenseRefreshPromise = (async () => {
    try {
      if (await saasClient.isAuthenticated()) {
        await saasClient.requireAuthenticatedLicense();
        saasClient.writePlanCache(getCurrentFolderPaths());
        log("[SaaS] License refreshed on activation");
      }
    } catch (e) {
      log(`[SaaS] Activation license refresh failed: ${e}`);
    }
  })();

  // Event orchestration
  saasClient.events.on("logout", () => {
    log("[SaaS] Logout detected — clearing plan cache");
    saasClient.writePlanCache(getCurrentFolderPaths());
    const skillMgr = opts.getSkillManager();
    if (skillMgr) skillMgr.updatePlan("free");
    const dob = opts.getDualOpinionBank();
    if (dob?.isSyncing) {
      log(
        "[SaaS] Warning: logout during active sync — sync will fail gracefully",
      );
    }
  });
  saasClient.events.on("authExpired", () => {
    log("[SaaS] Auth expired globally — notifying user");
    vscode.window
      .showWarningMessage(
        "Project Brain: your session expired. Log in again to keep cloud sync active.",
        "Log in",
      )
      .then((choice) => {
        if (choice === "Log in") {
          vscode.commands.executeCommand("projectBrain.saas.login");
        }
      });
  });
  saasClient.events.on("planChanged", async () => {
    const newPlan = saasClient.currentPlan;
    log(`[SaaS] Plan changed to ${newPlan} — updating plan cache + skills`);
    saasClient.writePlanCache(getCurrentFolderPaths());
    const skillMgr = opts.getSkillManager();
    if (skillMgr) skillMgr.updatePlan(newPlan);
    const dob = opts.getDualOpinionBank();
    if (newPlan !== "free" && dob) {
      dob
        .sync()
        .then((summary) => {
          log(
            `[SaaS] Auto-restore sync: pushed=${summary.pushed}, pulled=${summary.pulled}`,
          );
          vscode.window.showInformationMessage(
            `🧠 Plan upgraded! Memory restored — ${summary.pulled} opinions pulled from cloud.`,
          );
        })
        .catch((e) => log(`[SaaS] Auto-restore sync failed: ${e}`));
    }
    const cronSched = opts.getCronScheduler();
    if (cronSched) {
      try {
        const hasAccess = await saasClient.checkAccess("cron_reminders");
        if (hasAccess && !cronSched.isRunning) {
          cronSched.start();
          log("[Cron] Scheduler started (plan upgraded)");
        } else if (!hasAccess && cronSched.isRunning) {
          cronSched.stop();
          log("[Cron] Scheduler stopped (plan downgraded)");
        }
      } catch (e) {
        log(`[Cron] Plan reactivity error: ${e}`);
      }
    }
  });
  context.subscriptions.push({
    dispose: () => {
      saasClient.events.removeAllListeners();
    },
  });

  // 2. OfflineManager
  let offlineManager: OfflineManager | null = null;
  try {
    offlineManager = new OfflineManager({ saasClient, context, log });
  } catch (e) {
    log(`[SaaS] OfflineManager init error (non-fatal): ${e}`);
  }

  // 2b. MemoryFS + CloudSync
  let memoryFS: import("./memory-fs").MemoryFS | null = null;
  let cloudSync: import("./cloud-sync").CloudSync | null = null;
  try {
    const { MemoryFS } = require("./memory-fs") as typeof import("./memory-fs");
    const { CloudSync } =
      require("./cloud-sync") as typeof import("./cloud-sync");
    const projectHash = projectPathHash(primaryFolder.uri.fsPath);
    const memFS = new MemoryFS({
      memoryPath,
      projectId: projectHash,
      saasClient,
      log,
    });

    void (async () => {
      try {
        await licenseRefreshPromise;
        const isAuth = await saasClient.isAuthenticated();
        const plan = saasClient.currentPlan;
        const hasCloud = saasClient.checkAccess("cloud_storage");
        log(
          `[CloudSync] Activation check — authenticated=${isAuth}, plan=${plan}, hasCloud=${hasCloud}`,
        );
        if (hasCloud) {
          let cloudProjectId: string | null = null;
          try {
            cloudProjectId = await saasClient.registerProject({
              name: primaryFolder.name,
              pathHash: projectHash,
            });
            if (cloudProjectId) {
              memFS.setProjectId(cloudProjectId);
              log(
                `[SaaS] Cloud project registered: ${cloudProjectId} (${primaryFolder.name})`,
              );
            }
          } catch (e) {
            const isAuthError =
              e instanceof Error &&
              (e.message.includes("Authentication expired") ||
                e.message.includes("log in again") ||
                (e as { statusCode?: number }).statusCode === 401);
            if (isAuthError) {
              log("[SaaS] Session expired — prompting user to re-login");
              const action = await vscode.window.showWarningMessage(
                "Project Brain: Your cloud session has expired. Please log in again to enable CloudSync.",
                "Log in",
              );
              if (action === "Log in") {
                void vscode.commands.executeCommand("projectBrain.saas.login");
              }
            } else {
              log(
                `[SaaS] Project registration failed — CloudSync disabled: ${e}`,
              );
            }
          }
          if (!cloudProjectId) {
            log("[SaaS] CloudSync not started (missing cloud project ID)");
            return;
          }
          memFS.enableCloud();
          const cs = new CloudSync({
            memoryFS: memFS,
            saasClient,
            projectId: cloudProjectId,
            memoryPath,
            log,
          });
          cs.start();
          cloudSync = cs;
          context.subscriptions.push(cs);
          const state = folderStates.get(primaryFolder.uri.toString());
          if (state?.autoVectorizer) {
            const manifestPath = path.join(memoryPath, ".cloud-manifest.json");
            state.autoVectorizer.enableCloudBacked(manifestPath);
            cs.connectToVectorizer(state.autoVectorizer);
            log("[SaaS] Pipeline unified: vectorize → cloud sync → auto-evict");
          }
          log("[SaaS] Cloud Memory Sync started (Pro+ feature)");
        } else {
          log("[SaaS] Cloud storage not available in current plan");
        }
      } catch (e) {
        log(`[SaaS] CloudSync init error (non-fatal): ${e}`);
      }
    })();

    memoryFS = memFS;
    context.subscriptions.push(memFS);
  } catch (e) {
    log(`[SaaS] MemoryFS init error (non-fatal): ${e}`);
  }

  // 3. SkillManager
  let skillManager: SkillManager | null = null;
  try {
    skillManager = new SkillManager({
      memoryPath,
      extensionPath: context.extensionPath,
      saasClient,
      log,
    });
    const currentPlan = saasClient.currentPlan;
    skillManager
      .initialize(currentPlan)
      .catch((e) => log(`[SaaS] SkillManager init error: ${e}`));
  } catch (e) {
    log(`[SaaS] SkillManager construction error (non-fatal): ${e}`);
  }

  // 4. DualOpinionBank
  let dualOpinionBank: DualOpinionBank | null = null;
  try {
    dualOpinionBank = new DualOpinionBank({
      opinionBank,
      saasClient,
      offlineManager: offlineManager ?? undefined,
      log,
    });
  } catch (e) {
    log(`[SaaS] DualOpinionBank init error (non-fatal): ${e}`);
  }

  // 4b. AdminDB (admin-gated)
  let adminDb: AdminDB | null = null;
  void (async () => {
    try {
      await licenseRefreshPromise;
      log(`[SaaS] AdminDB gate: isAdmin=${saasClient.isAdmin}`);
      if (saasClient.isAdmin) {
        adminDb = new AdminDB(memoryPath, log);
        log("[SaaS] AdminDB initialized (admin role detected)");
      } else {
        log(
          "[SaaS] AdminDB skipped — user is not admin (will lazy-init on command)",
        );
      }
    } catch (e) {
      log(`[SaaS] AdminDB init error (non-fatal): ${e}`);
    }
  })();

  // 5. LoginWebviewProvider
  let loginWebview: LoginWebviewProvider | null = null;
  try {
    loginWebview = new LoginWebviewProvider(
      saasClient,
      context.extensionUri,
      log,
    );
  } catch (e) {
    log(`[SaaS] LoginWebview init error (non-fatal): ${e}`);
  }

  // 6. UpgradePromptManager
  let upgradePrompts: UpgradePromptManager | null = null;
  try {
    upgradePrompts = new UpgradePromptManager({
      context,
      log,
      onViewPlans: () => {
        loginWebview?.show();
      },
    });
  } catch (e) {
    log(`[SaaS] UpgradePrompts init error (non-fatal): ${e}`);
  }

  // 7. Connect 403 events to upgrade prompts
  if (upgradePrompts) {
    saasClient.events.on(
      "forbidden",
      ({ path: reqPath, message }: { path: string; message: string }) => {
        const featureMap: Record<string, import("./saas-client").FeatureKey> = {
          "/skills": "skill_marketplace",
          "/memory": "global_memory",
          "/analytics": "analytics_dashboard",
          "/teams": "team_shared_memory",
          "/files": "cloud_storage",
        };
        const matchedFeature = Object.entries(featureMap).find(([prefix]) =>
          reqPath.startsWith(prefix),
        );
        if (matchedFeature && upgradePrompts) {
          upgradePrompts.promptForFeature(
            matchedFeature[1],
            saasClient.currentPlan ?? "free",
          );
        } else {
          vscode.window
            .showWarningMessage(
              `🧠 ${message}. Upgrade your plan for full access.`,
              "View Plans",
            )
            .then((action) => {
              if (action === "View Plans") loginWebview?.show();
            });
        }
      },
    );
  }

  // Update TreeView after license resolves
  void licenseRefreshPromise.then(() => {
    log(`[SaaS] Admin status resolved: ${saasClient.isAdmin}`);
    treeDataProvider.updateStatus({ isAdmin: saasClient.isAdmin });
  });

  log(
    `[SaaS] Cloud layer initialized (plan: ${saasClient.currentPlan}, online: ${saasClient.isOnline})`,
  );

  return {
    saasClient,
    offlineManager,
    dualOpinionBank,
    skillManager,
    loginWebview,
    upgradePrompts,
    adminDb,
    memoryFS: memoryFS,
    cloudSync,
    licenseRefreshPromise,
  };
}
