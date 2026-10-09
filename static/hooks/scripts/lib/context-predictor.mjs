/**
 * Context Predictor — Anticipates what the user will work on next.
 * Uses session diary data to build lightweight prediction models:
 *   1. Branch-Topic Association: "on branch X, topics A,B,C are common"
 *   2. Topic Succession: "after topics A,B, the user usually works on C"
 *   3. File Momentum: recently touched files → likely next session too
 * Then matches predictions against learnings/troubleshooting to pre-load
 * relevant entries before the user even asks.
 * Called from session-start (step 9) to inject "predicted context".
 * Gracefully returns empty string when insufficient data (< 5 diary entries).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getRelated } from "./entity-graph.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

const DIARY_FILE = "16_SESSION_DIARY.md";
const MIN_DIARY_ENTRIES = 5;
const MAX_PREDICTIONS = 4;
const MAX_MATCHED_ENTRIES = 5;

// ─── Diary Parsing ───────────────────────────────────────────────────────────

/**
 * @typedef {{ topics: string[], branch: string, files: string[] }} DiarySession
 */

/**
 * Parse diary entries into structured session records.
 * @param {string} raw - Diary file content
 * @returns {DiarySession[]}
 */
function parseDiarySessions(raw) {
  const sessions = [];
  const blocks = raw.split(/^## /m).filter(Boolean).slice(1); // skip header

  for (const block of blocks) {
    const lines = block.split("\n");
    const headerLine = lines[0] || "";

    // Header: "2026-02-23 01:52 | branch-name"
    const branchMatch = headerLine.match(/\|\s*(.+)/);
    const branch = branchMatch ? branchMatch[1].trim() : "unknown";

    // Topics: "**Topics**: hooks, memory, scripts"
    const topicsLine = lines.find((l) => l.startsWith("**Topics**:"));
    const topics = topicsLine
      ? topicsLine
          .replace("**Topics**:", "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    // Files: "**Files**: file1, file2 (+3 more)"
    const filesLine = lines.find((l) => l.startsWith("**Files**:"));
    const files = filesLine
      ? filesLine
          .replace("**Files**:", "")
          .replace(/\(\+\d+ more\)/, "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : [];

    if (topics.length > 0 || files.length > 0) {
      sessions.push({ topics, branch, files });
    }
  }

  return sessions;
}

// ─── Prediction Models ───────────────────────────────────────────────────────

/**
 * Build branch→topic frequency map.
 * @param {DiarySession[]} sessions
 * @returns {Map<string, Map<string, number>>}
 */
function buildBranchTopicModel(sessions) {
  /** @type {Map<string, Map<string, number>>} */
  const model = new Map();

  for (const session of sessions) {
    if (!model.has(session.branch)) {
      model.set(session.branch, new Map());
    }
    const topicMap = model.get(session.branch);
    for (const topic of session.topics) {
      topicMap.set(topic, (topicMap.get(topic) || 0) + 1);
    }
  }

  return model;
}

/**
 * Build topic succession model (bigram-style).
 * For each pair of consecutive sessions, record topic[i] → topic[i+1] transitions.
 * @param {DiarySession[]} sessions
 * @returns {Map<string, Map<string, number>>}
 */
function buildSuccessionModel(sessions) {
  /** @type {Map<string, Map<string, number>>} */
  const model = new Map();

  for (let i = 0; i < sessions.length - 1; i++) {
    const current = sessions[i].topics;
    const next = sessions[i + 1].topics;

    for (const src of current) {
      if (!model.has(src)) model.set(src, new Map());
      const targets = model.get(src);
      for (const dst of next) {
        targets.set(dst, (targets.get(dst) || 0) + 1);
      }
    }
  }

  return model;
}

/**
 * Build file momentum: which files appeared most recently and frequently.
 * @param {DiarySession[]} sessions
 * @param {number} window - How many recent sessions to consider
 * @returns {string[]} - Top files by recency-weighted frequency
 */
function buildFileMomentum(sessions, window = 5) {
  const recent = sessions.slice(-window);
  /** @type {Map<string, number>} */
  const freq = new Map();

  for (let i = 0; i < recent.length; i++) {
    const weight = 1 + i * 0.5; // More recent = higher weight
    for (const file of recent[i].files) {
      freq.set(file, (freq.get(file) || 0) + weight);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([file]) => file);
}

// ─── Memory Matching ─────────────────────────────────────────────────────────

/**
 * Find learnings matching predicted topics by [domain] tags.
 * @param {string} memoryDir
 * @param {string[]} predictedTopics
 * @returns {string[]} Matched learning titles
 */
function matchLearnings(memoryDir, predictedTopics) {
  try {
    const path = join(memoryDir, "04_LEARNINGS.md");
    if (!existsSync(path)) return [];

    const raw = readFileSync(path, "utf8");
    const entries = raw.split(/(?=^## )/m).filter((e) => e.startsWith("## "));

    const topicSet = new Set(predictedTopics.map((t) => t.toLowerCase()));
    const matched = [];

    for (const entry of entries) {
      // Check domain tags: "- **[hooks]** ..." or title keywords
      const title = entry.split("\n")[0].replace("## ", "").trim();
      const titleLower = title.toLowerCase();

      // Match by domain tags in bullets
      const domains =
        entry
          .match(/\*\*\[(\w[\w-]*)\]\*\*/g)
          ?.map((m) =>
            m.replace(/\*\*/g, "").replace(/\[|\]/g, "").toLowerCase(),
          ) || [];

      const domainHit = domains.some((d) => topicSet.has(d));

      // Match by topic keyword in title
      const titleHit = predictedTopics.some((t) =>
        titleLower.includes(t.toLowerCase()),
      );

      if (domainHit || titleHit) {
        matched.push(title.slice(0, 100));
      }
    }

    return matched.slice(0, MAX_MATCHED_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Find troubleshooting entries matching predicted topics.
 * @param {string} memoryDir
 * @param {string[]} predictedTopics
 * @returns {string[]} Matched troubleshooting titles
 */
function matchTroubleshooting(memoryDir, predictedTopics) {
  try {
    const path = join(memoryDir, "05_TROUBLESHOOTING.md");
    if (!existsSync(path)) return [];

    const raw = readFileSync(path, "utf8");
    const entries = raw.split(/(?=^## )/m).filter((e) => e.startsWith("## "));

    const matched = [];
    for (const entry of entries) {
      const title = entry.split("\n")[0].replace("## ", "").trim();
      const titleLower = title.toLowerCase();

      const hit = predictedTopics.some((t) =>
        titleLower.includes(t.toLowerCase()),
      );

      if (hit) {
        matched.push(title.slice(0, 100));
      }
    }

    return matched.slice(0, 3);
  } catch {
    return [];
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Predict context for the upcoming session.
 * Reads diary, builds models, matches against memory.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {string} Formatted context block, or empty string
 */
export function predictContext(memoryDir) {
  try {
    const diaryPath = join(memoryDir, DIARY_FILE);
    if (!existsSync(diaryPath)) return "";

    const raw = readFileSync(diaryPath, "utf8");
    const sessions = parseDiarySessions(raw);

    // Need minimum data for meaningful predictions
    if (sessions.length < MIN_DIARY_ENTRIES) return "";

    // Get current state from last session
    const lastSession = sessions[sessions.length - 1];
    const currentBranch = getCurrentBranch(memoryDir) || lastSession.branch;

    // Build models
    const branchModel = buildBranchTopicModel(sessions);
    const successionModel = buildSuccessionModel(sessions);

    // Generate predictions
    /** @type {Map<string, number>} */
    const predictions = new Map();

    // 1. Branch-topic: what topics appear on this branch?
    const branchTopics = branchModel.get(currentBranch);
    if (branchTopics) {
      for (const [topic, count] of branchTopics) {
        predictions.set(topic, (predictions.get(topic) || 0) + count * 2);
      }
    }

    // 2. Topic succession: what follows recent topics?
    for (const topic of lastSession.topics) {
      const nextTopics = successionModel.get(topic);
      if (nextTopics) {
        for (const [next, count] of nextTopics) {
          predictions.set(next, (predictions.get(next) || 0) + count);
        }
      }
    }

    // 3. Entity graph: what co-occurs with recent topics/files?
    try {
      for (const topic of lastSession.topics) {
        const related = getRelated(memoryDir, topic, 3);
        for (const r of related) {
          if (r.type === "topic") {
            predictions.set(r.id, (predictions.get(r.id) || 0) + r.weight);
          }
        }
      }
    } catch {
      /* graph may not exist yet */
    }

    if (predictions.size === 0) return "";

    // Sort by score, take top N
    const topPredictions = [...predictions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PREDICTIONS)
      .map(([topic]) => topic);

    // Match against memory
    const learnings = matchLearnings(memoryDir, topPredictions);
    const issues = matchTroubleshooting(memoryDir, topPredictions);
    const momentum = buildFileMomentum(sessions);

    // Build output
    const parts = [];

    parts.push(
      `Predicted focus: **${topPredictions.join(", ")}** (based on ${sessions.length} sessions)`,
    );

    if (momentum.length > 0) {
      parts.push(`Hot files: ${momentum.join(", ")}`);
    }

    if (learnings.length > 0) {
      parts.push(
        `Related learnings:\n${learnings.map((l) => `  - ${l}`).join("\n")}`,
      );
    }

    if (issues.length > 0) {
      parts.push(`Watch out for:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    }

    // Entity graph connections: files that co-occur with predicted topics
    try {
      const graphConnections = new Set();
      for (const topic of topPredictions) {
        const related = getRelated(memoryDir, topic, 3);
        for (const r of related) {
          if (r.type === "file" && r.weight >= 1) {
            graphConnections.add(`${r.id} (w=${r.weight.toFixed(1)})`);
          }
        }
      }
      if (graphConnections.size > 0) {
        parts.push(
          `Graph connections: ${[...graphConnections].slice(0, 6).join(", ")}`,
        );
      }
    } catch {
      /* graph optional */
    }

    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Read current branch from session handoff.
 * @param {string} memoryDir
 * @returns {string|null}
 */
function getCurrentBranch(memoryDir) {
  try {
    const handoffPath = join(memoryDir, "07_SESSION_HANDOFF.md");
    if (!existsSync(handoffPath)) return null;

    const raw = readFileSync(handoffPath, "utf8");
    const match = raw.match(/\*\*Branch\*\*:\s*`?(\S+?)`?\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
