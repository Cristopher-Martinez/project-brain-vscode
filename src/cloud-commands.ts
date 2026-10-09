import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  ensureProjectBrainDirs,
  hasLegacyPaths,
  migrateFromLegacyPaths,
} from "./brain-paths";
import type { CloudSync } from "./cloud-sync";
import { log } from "./logger";
import type { MemoryFS } from "./memory-fs";

export interface CloudCommandDeps {
  getCloudSync: () => CloudSync | null;
  setCloudSync: (cs: CloudSync) => void;
  getSaasClient: () => any | null;
  getMemoryFS: () => MemoryFS | null;
  setMemoryFS: (mfs: MemoryFS) => void;
  folderStates: Map<string, any>;
  treeDataProvider: any;
  projectPathHash: (fsPath: string) => string;
  pickWorkspaceFolder: () => Promise<vscode.WorkspaceFolder | undefined>;
}

export function registerCloudCommands(
  context: vscode.ExtensionContext,
  deps: CloudCommandDeps,
): void {
  // ─── Cloud Sync Commands ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.cloudSync", async () => {
      const activeSaasClient = deps.getSaasClient();
      let activeCloudSync = deps.getCloudSync();
      const activeMemoryFS = deps.getMemoryFS();

      // Lazy init: if CloudSync not started at activation, try now
      if (!activeCloudSync && activeSaasClient && activeMemoryFS) {
        try {
          if (await activeSaasClient.isAuthenticated()) {
            await activeSaasClient.requireAuthenticatedLicense();
            log(
              `[CloudSync] Lazy license refresh — plan=${activeSaasClient.currentPlan}, hasCloud=${activeSaasClient.checkAccess("cloud_storage")}`,
            );
          } else {
            log("[CloudSync] Not authenticated — cannot start cloud sync");
            vscode.window.showWarningMessage(
              "Cloud Sync requires authentication. Use 'Project Brain: Login to Cloud' first.",
            );
            return;
          }
        } catch (e) {
          log(`[CloudSync] Lazy license refresh failed: ${e}`);
        }

        if (activeSaasClient.checkAccess("cloud_storage")) {
          try {
            const pFolder = vscode.workspace.workspaceFolders?.[0];
            if (!pFolder) return;
            const cfg = vscode.workspace.getConfiguration("projectBrain");
            const mFolder = cfg.get<string>(
              "memoryFolder",
              ".project-brain/memory",
            );
            const mPath = path.join(pFolder.uri.fsPath, mFolder);
            const pHash = deps.projectPathHash(pFolder.uri.fsPath);

            const cloudProjectId = await activeSaasClient.registerProject({
              name: pFolder.name,
              pathHash: pHash,
            });

            if (cloudProjectId) {
              activeMemoryFS.setProjectId(cloudProjectId);
              activeMemoryFS.enableCloud();
              const { CloudSync } =
                require("./cloud-sync") as typeof import("./cloud-sync");
              const cloudSync = new CloudSync({
                memoryFS: activeMemoryFS,
                saasClient: activeSaasClient,
                projectId: cloudProjectId,
                memoryPath: mPath,
                log,
              });
              cloudSync.start();
              activeCloudSync = cloudSync;
              deps.setCloudSync(cloudSync);
              context.subscriptions.push(cloudSync);
              log(
                `[CloudSync] Lazy init succeeded — project=${cloudProjectId}`,
              );
            } else {
              vscode.window.showWarningMessage(
                "Cloud Sync: Could not register project. Check Output panel for details.",
              );
              return;
            }
          } catch (e) {
            log(`[CloudSync] Lazy init failed: ${e}`);
            vscode.window.showWarningMessage(
              `Cloud Sync initialization failed: ${e}`,
            );
            return;
          }
        }
      }

      if (!activeCloudSync) {
        vscode.window.showWarningMessage(
          "Cloud Sync not enabled. Requires Pro plan or higher.",
        );
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Project Brain: Syncing memory files...",
        },
        async () => {
          await activeCloudSync!.syncNow();
          vscode.window.showInformationMessage(
            `Cloud Sync complete — ${activeCloudSync!.stats.filesUploaded} up, ${activeCloudSync!.stats.filesDownloaded} down`,
          );
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.cloudSyncStatus",
      async () => {
        const activeCloudSync = deps.getCloudSync();
        const activeMemoryFS = deps.getMemoryFS();
        if (!activeCloudSync || !activeMemoryFS) {
          vscode.window.showInformationMessage(
            "Cloud Sync: Disabled (requires Pro plan)",
          );
          return;
        }
        const stats = activeMemoryFS.getStats();
        const syncStats = activeCloudSync.stats;
        vscode.window.showInformationMessage(
          `☁️ Cloud Sync: ${syncStats.status}\n` +
            `Local: ${stats.localFiles} files | Cloud: ${stats.cloudFiles} files | Cloud-only: ${stats.cloudOnlyFiles}\n` +
            `Pinned: ${stats.pinnedFiles} | Pending: ${stats.pendingUploads}\n` +
            `Last sync: ${syncStats.lastSyncAt ?? "never"}`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.excludeFromGit", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (folder) await excludeFromGit(folder);
    }),
  );

  // ——— Migrate Legacy Paths ————————————————————————————————————
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.migrateLegacy", async () => {
      const folder = await deps.pickWorkspaceFolder();
      if (!folder) return;
      await migrateLegacyCommand(folder);
    }),
  );

  // ——— Migrate Bridge Keys to Global Settings ———————————————————
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.migrateKeysToGlobal", async () => {
      try {
        const { migrateKeysToGlobalSettings } = await import("./brain-hq-bridge-settings-handler");
        const migrated = await migrateKeysToGlobalSettings();
        if (migrated.length > 0) {
          vscode.window.showInformationMessage(
            `Bridge keys migrated to global settings: ${migrated.join(", ")}`,
          );
        } else {
          vscode.window.showInformationMessage(
            "No bridge keys found in SecretStorage to migrate.",
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Migration failed: ${err}`);
      }
    }),
  );

  // ─── Purge Cloud Files ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "projectBrain.purgeCloudFiles",
      async () => {
        const activeSaasClient = deps.getSaasClient();
        const activeCloudSync = deps.getCloudSync();
        const activeMemoryFS = deps.getMemoryFS();

        if (!activeSaasClient || !activeCloudSync) {
          vscode.window.showWarningMessage(
            "Cloud Sync not active. Cannot purge.",
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          "⚠️ This will permanently delete ALL cloud-synced memory files for this project, including version snapshots. Local files are NOT affected. Continue?",
          { modal: true },
          "Yes, Purge Everything",
        );

        if (confirm !== "Yes, Purge Everything") return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Purging cloud files...",
          },
          async () => {
            const projectId = activeCloudSync!.cloudProjectId;
            const result = await activeSaasClient!.purgeProjectFiles(projectId);

            if (result) {
              const freed =
                result.totalBytesFreed > 1024
                  ? `${(result.totalBytesFreed / 1024).toFixed(1)}KB`
                  : `${result.totalBytesFreed}B`;
              log(
                `[CloudSync] Purged ${result.purged} cloud files (${freed} freed)`,
              );

              // Clear cloud manifest so MemoryFS knows files are gone
              if (activeMemoryFS) {
                activeMemoryFS.clearCloudManifest();
              }

              // Re-vectorize to clean up orphaned chunks from deleted files
              const folder = vscode.workspace.workspaceFolders?.[0];
              if (folder) {
                const state = deps.folderStates.get(folder.uri.toString());
                if (state?.autoVectorizer) {
                  log("[CloudSync] Triggering re-vectorization after purge...");
                  await state.autoVectorizer.triggerSync(true);
                  deps.treeDataProvider.updateStatus({
                    autoVecActive: state.autoVectorizer.isActive(),
                    workspaceFolder: folder,
                  });
                }
              }

              vscode.window.showInformationMessage(
                `Purged ${result.purged} cloud files (${freed} freed). Local files untouched.`,
              );
            } else {
              vscode.window.showErrorMessage(
                "Failed to purge cloud files. Check Output panel.",
              );
            }
          },
        );
      },
    ),
  );
}

/**
 * Add Project Brain generated files to .git/info/exclude (local-only gitignore).
 * This never modifies the project's .gitignore, so it's safe for third-party repos.
 *
 * @param silent - When true (auto-called on activation), skip UI notifications.
 */
export async function excludeFromGit(
  folder: vscode.WorkspaceFolder,
  silent = false,
): Promise<void> {
  const folderPath = folder.uri.fsPath;

  // Patterns for ALL files/dirs Project Brain generates.
  // .project-brain/ is the catch-all for memory, loops, analysis, repos, shadow, sqlite, etc.
  // .github/ subdirs are hooks, agents, prompts, and skills deployed by the bootstrapper.
  const patterns = [
    ".project-brain/",
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".github/hooks/",
    ".github/agents/",
    ".github/prompts/",
    ".github/skills/",
  ];

  const gitDir = path.join(folderPath, ".git");
  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");

  // Verify this is a git repo
  if (!fs.existsSync(gitDir)) {
    if (!silent) {
      vscode.window.showWarningMessage(
        "Not a git repository. Cannot add local exclusions.",
      );
    }
    return;
  }

  // Ensure .git/info/ directory exists
  if (!fs.existsSync(infoDir)) {
    fs.mkdirSync(infoDir, { recursive: true });
  }

  // Read existing exclude file
  let existing = "";
  if (fs.existsSync(excludePath)) {
    existing = fs.readFileSync(excludePath, "utf-8");
  }

  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));

  // Header for our section
  const sectionStart = "# --- Project Brain (auto-generated) ---";
  const sectionEnd = "# --- /Project Brain ---";

  // If our section already exists, remove it to rebuild fresh
  const startIdx = existing.indexOf(sectionStart);
  const endIdx = existing.indexOf(sectionEnd);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.substring(0, startIdx).trimEnd();
    const after = existing.substring(endIdx + sectionEnd.length).trimStart();
    existing = before + (after ? "\n" + after : "");
    // Re-parse existing lines after removing our old section
    existingLines.clear();
    existing.split(/\r?\n/).forEach((l) => existingLines.add(l.trim()));
  }

  // Build the section with all patterns
  const newPatterns = patterns.filter((p) => !existingLines.has(p));
  const allPatterns = patterns; // Always write full section

  const section = ["", sectionStart, ...allPatterns, sectionEnd].join("\n");

  // Append to exclude file
  const finalContent = existing.trimEnd() + section + "\n";
  fs.writeFileSync(excludePath, finalContent, "utf-8");

  const added = newPatterns.length;
  const total = allPatterns.length;

  log(`Git local exclude updated: ${total} patterns in ${excludePath}`);

  // Untrack any previously-tracked files that now match the exclude patterns.
  // Uses --ignore-unmatch so it's a no-op if the path was never tracked.
  try {
    for (const pattern of allPatterns) {
      const normalized = pattern.replace(/\/$/, ""); // strip trailing slash
      execFileSync(
        "git",
        ["rm", "--cached", "--ignore-unmatch", "-r", normalized],
        { cwd: folderPath, stdio: "pipe" },
      );
    }
    log("git rm --cached: untracked excluded patterns");
  } catch {
    /* git not available or no tracked files — safe to ignore */
  }

  if (silent) {
    return; // No UI noise during activation
  }

  if (added === 0) {
    vscode.window.showInformationMessage(
      `Project Brain: All ${total} patterns already excluded in .git/info/exclude`,
    );
  } else {
    vscode.window.showInformationMessage(
      `Project Brain: ${added} new pattern(s) added to .git/info/exclude (${total} total). These files are now locally ignored without modifying .gitignore.`,
    );
  }
}

/**
 * Migrate legacy paths (docs/memory/, .brain-loops/) → .project-brain/.
 * Shows what will be migrated, asks confirmation, runs migration.
 */
async function migrateLegacyCommand(
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const repoRoot = folder.uri.fsPath;
  const legacy = hasLegacyPaths(repoRoot);

  if (!legacy.legacyMemory && !legacy.legacyLoops && !legacy.legacyHooks) {
    vscode.window.showInformationMessage(
      "Project Brain: No legacy paths found. Nothing to migrate.",
    );
    return;
  }

  const parts: string[] = [];
  if (legacy.legacyMemory) {
    parts.push("docs/memory/ → .project-brain/memory/");
  }
  if (legacy.legacyLoops) {
    parts.push(".brain-loops/ → .project-brain/loops/");
  }
  if (legacy.legacyHooks) {
    parts.push(".github/hooks/scripts/ → .project-brain/hooks/scripts/");
  }

  const confirm = await vscode.window.showInformationMessage(
    `Migrate legacy paths?\n${parts.join("\n")}`,
    { modal: true },
    "Migrate",
  );

  if (confirm !== "Migrate") return;

  ensureProjectBrainDirs(repoRoot);
  const result = migrateFromLegacyPaths(repoRoot);

  const migrated: string[] = [];
  if (result.migratedMemory) {
    migrated.push("docs/memory/ → .project-brain/memory/");
  }
  if (result.migratedLoops) {
    migrated.push(".brain-loops/ → .project-brain/loops/");
  }
  if (result.migratedHooks) {
    migrated.push(".github/hooks/scripts/ → .project-brain/hooks/scripts/");
  }

  if (migrated.length > 0) {
    log(`Legacy migration completed: ${migrated.join(", ")}`);
    vscode.window.showInformationMessage(
      `Project Brain: Migration complete!\n${migrated.join("\n")}`,
    );
  } else {
    vscode.window.showInformationMessage(
      "Project Brain: Files already exist in new paths. Nothing was copied.",
    );
  }
}
