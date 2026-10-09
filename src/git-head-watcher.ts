/**
 * git-head-watcher.ts — Monitors .git/HEAD for unauthorized branch changes.
 *
 * Inspired by KiloCode's poll-based watcher pattern. Detects when an LLM
 * switches branches by polling the HEAD ref every 2 seconds.
 */

import * as fs from "fs";
import * as path from "path";
import { log, logWarn } from "./logger";

/**
 * Polls .git/HEAD at a fixed interval and fires a callback when the branch changes.
 * Lightweight detection layer — catches anything the static/LLM layers missed.
 */
export class GitHeadWatcher {
  private currentBranch: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly repoRoot: string;
  private readonly onBranchChange: (prev: string, next: string) => void;

  constructor(
    repoRoot: string,
    onBranchChange: (previousBranch: string, newBranch: string) => void,
  ) {
    this.repoRoot = repoRoot;
    this.onBranchChange = onBranchChange;
  }

  start(): void {
    this.currentBranch = this.readBranch();
    if (!this.currentBranch) {
      logWarn(`[GitHeadWatcher] Cannot read HEAD at ${this.repoRoot}`);
      return;
    }

    log(`[GitHeadWatcher] Watching — branch: ${this.currentBranch}, repo: ${this.repoRoot}`);

    // Poll every 2 seconds (light, like KiloCode's approach)
    this.interval = setInterval(() => {
      const branch = this.readBranch();
      if (branch && branch !== this.currentBranch) {
        const prev = this.currentBranch ?? "unknown";
        logWarn(`[GitHeadWatcher] ⚠️ Branch changed: ${prev} → ${branch} (repo: ${this.repoRoot})`);
        this.onBranchChange(prev, branch);
        this.currentBranch = branch;
      }
    }, 2000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log(`[GitHeadWatcher] Stopped (repo: ${this.repoRoot})`);
    }
  }

  private readBranch(): string | null {
    try {
      const headPath = path.join(this.repoRoot, ".git", "HEAD");
      const content = fs.readFileSync(headPath, "utf8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        return content.replace("ref: refs/heads/", "");
      }
      return content.substring(0, 8); // detached HEAD
    } catch {
      return null;
    }
  }

  getBranch(): string | null {
    return this.currentBranch;
  }

  /** Update expected branch (call after intentional branch changes). */
  setExpectedBranch(branch: string): void {
    this.currentBranch = branch;
    log(`[GitHeadWatcher] Expected branch set: ${branch}`);
  }
}
