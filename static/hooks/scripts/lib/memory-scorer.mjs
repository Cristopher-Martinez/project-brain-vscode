/**
 * Memory Scorer — Usage-based relevance tracking for memory entries.
 * Tracks how often each memory entry is surfaced by MiniSearch queries.
 * Entries used frequently are "valuable"; entries never used are "noise".
 * Two-phase design (mirrors capture-buffer pattern):
 *   1. ACCUMULATE (search-cache.mjs): querySearchCache writes matched
 *      statements to sessions/query-hits.jsonl on every query.
 *   2. PROCESS (session-stop): processScores() aggregates hits, ages
 *      all tracked entries, and computes relevance scores.
 * Score file: sessions/memory-scores.json
 * Hit log:    sessions/query-hits.jsonl (cleared after processing)
 * Relevance formula: hits / max(age, 1)
 *   - high relevance (>0.3 after age>5) → frequently used knowledge
 *   - low relevance  (<0.05 after age>10) → candidate for archival
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const SCORES_FILE = "memory-scores.json";
const HITS_FILE = "query-hits.jsonl";
const MAX_TRACKED_ENTRIES = 300;
const DECAY_FACTOR = 0.95; // Forgetting curve: relevance *= 0.95^daysSinceLastAccess

// ─── Hit Accumulation ────────────────────────────────────────────────────────

/**
 * Record search hits from a MiniSearch query.
 * Called internally by querySearchCache after every successful query.
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @param {Array<{type: string, statement: string}>} results - MiniSearch results
 */
export function recordQueryHits(sessionsDir, results) {
  try {
    if (!results || results.length === 0) return;
    if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

    const statements = results
      .map((r) => `${r.type || "unknown"}:${(r.statement || "").slice(0, 120)}`)
      .filter(Boolean);

    if (statements.length === 0) return;

    const line = JSON.stringify({ ts: Date.now(), hits: statements }) + "\n";
    appendFileSync(join(sessionsDir, HITS_FILE), line, "utf8");
  } catch {
    /* non-critical */
  }
}

// ─── Score Processing (session-stop) ─────────────────────────────────────────

/**
 * Process accumulated query hits and update memory scores.
 * Should be called once per session from session-stop, BEFORE buildSearchCache.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ tracked: number, active: number, stale: number } | null}
 */
export function processScores(memoryDir) {
  try {
    const sessionsDir = join(memoryDir, "sessions");
    const scoresPath = join(sessionsDir, SCORES_FILE);
    const hitsPath = join(sessionsDir, HITS_FILE);

    // 1. Load existing scores
    let scores = {};
    if (existsSync(scoresPath)) {
      const raw = readFileSync(scoresPath, "utf8");
      const parsed = JSON.parse(raw);
      scores = parsed.entries || {};
    }

    // 2. Read and aggregate query hits
    const hitCounts = {};
    if (existsSync(hitsPath)) {
      const raw = readFileSync(hitsPath, "utf8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const { hits } = JSON.parse(line);
          if (Array.isArray(hits)) {
            for (const key of hits) {
              hitCounts[key] = (hitCounts[key] || 0) + 1;
            }
          }
        } catch {
          
        }
      }
      // Clear hit log after processing
      try {
        unlinkSync(hitsPath);
      } catch {
        
      }
    }

    // 3. Update scores: increment age for ALL, add hits where applicable
    const now = new Date().toISOString().slice(0, 10);
    for (const key of Object.keys(scores)) {
      scores[key].age = (scores[key].age || 0) + 1;
      scores[key].lastAged = now;
    }

    // 4. Record new hits (create entries if not tracked yet)
    for (const [key, count] of Object.entries(hitCounts)) {
      if (!scores[key]) {
        scores[key] = { hits: 0, age: 0, firstSeen: now, lastHit: null };
      }
      scores[key].hits += count;
      scores[key].lastHit = now;
    }

    // 4b. Utility feedback — boost scores for injected recall referenced in session
    try {
      const recallPath = join(sessionsDir, "injected-recall.json");
      if (existsSync(recallPath)) {
        const recall = JSON.parse(readFileSync(recallPath, "utf8"));
        const bufferPath = join(sessionsDir, "capture-buffer.jsonl");
        const bufferText = existsSync(bufferPath)
          ? readFileSync(bufferPath, "utf8").toLowerCase()
          : "";
        for (const key of recall.items || []) {
          const words = key
            .toLowerCase()
            .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 4);
          const matches = words.filter((w) => bufferText.includes(w));
          if (matches.length >= 2) {
            if (!scores[key]) {
              scores[key] = { hits: 0, age: 0, firstSeen: now, lastHit: null };
            }
            scores[key].hits += 1;
            scores[key].lastHit = now;
          }
        }
        try {
          unlinkSync(recallPath);
        } catch {
          
        }
      }
    } catch {
      /* non-critical */
    }

    // 5. Compute relevance with forgetting curve
    for (const entry of Object.values(scores)) {
      entry.relevance = +(entry.hits / Math.max(entry.age, 1)).toFixed(3);

      // Forgetting curve: decay memories not recently accessed
      const lastAccess = entry.lastHit || entry.firstSeen;
      if (lastAccess) {
        const daysSince = Math.floor(
          (Date.now() - new Date(lastAccess).getTime()) / 86400000,
        );
        if (daysSince > 0) {
          entry.relevance = +(
            entry.relevance * Math.pow(DECAY_FACTOR, daysSince)
          ).toFixed(3);
        }
      }
    }

    // 6. Prune: keep only top MAX_TRACKED_ENTRIES by relevance
    const sortedKeys = Object.keys(scores).sort(
      (a, b) => (scores[b].relevance || 0) - (scores[a].relevance || 0),
    );
    if (sortedKeys.length > MAX_TRACKED_ENTRIES) {
      const toRemove = sortedKeys.slice(MAX_TRACKED_ENTRIES);
      for (const key of toRemove) {
        delete scores[key];
      }
    }

    // 7. Compute summary stats
    const entries = Object.values(scores);
    const tracked = entries.length;
    const active = entries.filter(
      (e) => e.age >= 5 && e.relevance >= 0.3,
    ).length;
    const stale = entries.filter(
      (e) => e.age >= 10 && e.relevance < 0.05,
    ).length;

    // 8. Write scores
    writeFileSync(
      scoresPath,
      JSON.stringify(
        { version: 1, updatedAt: now, tracked, active, stale, entries: scores },
        null,
        2,
      ),
      "utf8",
    );

    return { tracked, active, stale };
  } catch {
    return null;
  }
}

/**
 * Get the top N most relevant memory entries by score.
 * Useful for promotion candidates (entries that should be in BOOT.md).
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @param {number} [n=5] - Number of top entries to return
 * @returns {Array<{ key: string, hits: number, age: number, relevance: number }>}
 */
export function getTopScored(memoryDir, n = 5) {
  try {
    const scoresPath = join(memoryDir, "sessions", SCORES_FILE);
    if (!existsSync(scoresPath)) return [];

    const raw = readFileSync(scoresPath, "utf8");
    const { entries } = JSON.parse(raw);
    if (!entries) return [];

    return Object.entries(entries)
      .filter(([, v]) => v.age >= 3) // minimum age for meaningful score
      .sort(([, a], [, b]) => (b.relevance || 0) - (a.relevance || 0))
      .slice(0, n)
      .map(([key, v]) => ({ key, ...v }));
  } catch {
    return [];
  }
}
