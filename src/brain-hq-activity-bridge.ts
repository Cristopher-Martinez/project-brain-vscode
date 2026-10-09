/**
 * Brain HQ ↔ Activity Feed bridge.
 * Watches `.project-brain/loops/activity-feed.json` for changes and pushes
 * updates to the webview for real-time Neural Pulse visualization.
 */

import * as fs from "fs";
import * as path from "path";
import type { BrainHqInstance } from "./brain-hq-message-handler";
import { getLoopsDir } from "./brain-paths";
import { log } from "./logger";

// ——— File watcher for activity feed ————————————————————
const activeWatchers = new Map<string, fs.FSWatcher>();
const watchDebounce = new Map<string, NodeJS.Timeout>();

export interface ActivityEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  tool: string;
  category: "edit" | "search" | "read" | "terminal" | "brain" | "agent";
  icon: string;
  summary: string;
}

interface ActivityFeedStore {
  entries: ActivityEntry[];
}

function readFeedFile(repoRoot: string): ActivityEntry[] {
  const fp = path.join(getLoopsDir(repoRoot), "activity-feed.json");
  try {
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw) as ActivityFeedStore;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Start watching activity-feed.json for real-time visualization updates.
 */
export function startActivityWatcher(
  repoRoot: string,
  sessionId: string,
  instance: BrainHqInstance,
): void {
  const key = `activity::${repoRoot}::${sessionId}`;
  if (activeWatchers.has(key)) return;

  const feedFile = path.join(getLoopsDir(repoRoot), "activity-feed.json");
  if (!fs.existsSync(feedFile)) {
    // Create the file so watcher can start
    const dir = path.dirname(feedFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(feedFile, JSON.stringify({ entries: [] }), "utf8");
  }

  try {
    const watcher = fs.watch(feedFile, () => {
      const existing = watchDebounce.get(key);
      if (existing) clearTimeout(existing);
      watchDebounce.set(
        key,
        setTimeout(() => {
          pushActivityToWebview(repoRoot, sessionId, instance);
          watchDebounce.delete(key);
        }, 200),
      );
    });
    activeWatchers.set(key, watcher);
    log(
      `[ActivityBridge] Watching activity feed for session ${sessionId.substring(0, 8)}`,
    );
  } catch (err) {
    log(`[ActivityBridge] fs.watch failed: ${err}`);
  }
}

/**
 * Stop watching activity feed for a session.
 */
export function stopActivityWatcher(repoRoot: string, sessionId: string): void {
  const key = `activity::${repoRoot}::${sessionId}`;
  const watcher = activeWatchers.get(key);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(key);
  }
  const timer = watchDebounce.get(key);
  if (timer) {
    clearTimeout(timer);
    watchDebounce.delete(key);
  }
}

/**
 * Stop all activity feed watchers (cleanup on deactivate).
 */
export function stopAllActivityWatchers(): void {
  for (const [, watcher] of activeWatchers) {
    watcher.close();
  }
  for (const [, timer] of watchDebounce) {
    clearTimeout(timer);
  }
  activeWatchers.clear();
  watchDebounce.clear();
}

/**
 * Push current activity feed state for a session to the webview.
 * Filters entries by sessionId and sends last 100.
 */
export function pushActivityToWebview(
  repoRoot: string,
  sessionId: string,
  instance: BrainHqInstance,
): void {
  const allEntries = readFeedFile(repoRoot);
  // Filter entries for this session (or global/multi-session entries)
  const sessionEntries = allEntries.filter(
    (e) =>
      e.sessionId === sessionId ||
      e.sessionId === "global" ||
      (e.sessionId && e.sessionId.includes(sessionId)),
  );
  const recent = sessionEntries.slice(-100);

  instance.panel.webview.postMessage({
    type: "activityFeedUpdate",
    sessionId,
    entries: recent,
  });
}

/**
 * Clear activity feed entries for a session (on session end).
 */
export function clearActivityFeed(repoRoot: string): void {
  const fp = path.join(getLoopsDir(repoRoot), "activity-feed.json");
  try {
    fs.writeFileSync(fp, JSON.stringify({ entries: [] }), "utf8");
  } catch {
    // Best-effort
  }
}
