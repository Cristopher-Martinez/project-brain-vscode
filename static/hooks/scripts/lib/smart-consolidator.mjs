/**
 * smart-consolidator.mjs — Score-based archival for 04_LEARNINGS.md.
 * Problem: Learnings file grows unbounded (200+ entries, 285KB).
 * Dedup removes duplicates but can't reduce volume of unique entries.
 * Cross-session promotes patterns to opinions but doesn't archive.
 * Strategy:
 *   1. Parse all entries from 04_LEARNINGS.md
 *   2. Score each entry by: memory-scores relevance (if available) + recency
 *   3. If count > MAX_ACTIVE, archive lowest-scored entries
 *   4. Write archive to 04_LEARNINGS_ARCHIVE.md (append)
 *   5. Rewrite 04_LEARNINGS.md with surviving entries
 * Scoring (dual-strategy):
 *   - PRIMARY (when memory-scores.json exists): match entry bullets against
 *     score keys, use relevance. High relevance = frequently queried = valuable.
 *   - FALLBACK (no scores): age-based. Older entries = less valuable.
 *   - ALWAYS: entries < PROTECT_DAYS old are protected (never archived).
 *   - ALWAYS: named entries get a bonus over Auto-Summary entries.
 * Called from session-stop as step 5c (after processScores, before buildSearchCache).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ACTIVE = 80;
const MAX_ARCHIVE = 500;
const PROTECT_DAYS = 7;
const MIN_ENTRIES_TO_CONSOLIDATE = 30;
const NAMED_BONUS = 0.3;
const RECENCY_WEIGHT = 0.5;
const SCORES_FILE = "memory-scores.json";

// ─── Date Extraction ─────────────────────────────────────────────────────────

/**
 * Extract a date from an entry (header or body).
 * @param {string} header - First line of the entry
 * @param {string} body - Full entry text
 * @returns {string|null} ISO date string (YYYY-MM-DD) or null
 */
function extractDate(header, body) {
  // 1. Header date: "## Something (2026-02-22_23-54)" or "(2026-02-22)"
  const headerMatch = header.match(/(\d{4}-\d{2}-\d{2})/);
  if (headerMatch) return headerMatch[1];

  // 2. Body **Date** field
  const bodyMatch = body.match(/\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})/);
  if (bodyMatch) return bodyMatch[1];

  return null;
}

/**
 * Compute age in days from a date string.
 * @param {string|null} dateStr - ISO date (YYYY-MM-DD) or null
 * @returns {number} Age in days (999 if no date)
 */
function ageDays(dateStr) {
  if (!dateStr) return 999; // Unknown date = treated as very old
  const then = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const diff = now.getTime() - then.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

// ─── Entry Parsing ───────────────────────────────────────────────────────────

/**
 * Parse 04_LEARNINGS.md into structured entries.
 * @param {string} raw - File content
 * @returns {{ header: string, body: string, type: 'auto'|'named'|'preamble', date: string|null, bullets: string[] }[]}
 */
function parseEntries(raw) {
  const parts = raw.split(/(?=^## )/m);
  const entries = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split("\n")[0];

    if (!firstLine.startsWith("## ")) {
      // Preamble: # header, intro text, dedup footers
      entries.push({
        header: firstLine,
        body: trimmed,
        type: "preamble",
        date: null,
        bullets: [],
      });
      continue;
    }

    const isAuto = firstLine.startsWith("## Auto-Summary");
    const date = extractDate(firstLine, trimmed);

    // Extract bullet points for score matching
    const bullets = [];
    for (const line of trimmed.split("\n")) {
      const bulletMatch = line.match(
        /^- \*\*\[.+?\]\*\*\s*(?:\(c=[\d.]+\))?\s*(.+)/,
      );
      if (bulletMatch) {
        bullets.push(bulletMatch[1].trim().slice(0, 120));
      }
    }

    entries.push({
      header: firstLine,
      body: trimmed,
      type: isAuto ? "auto" : "named",
      date,
      bullets,
    });
  }

  return entries;
}

// ─── Score Matching ──────────────────────────────────────────────────────────

/**
 * Load memory-scores.json and build a quick lookup map.
 * Keys in scores file: "type:statement" (e.g., "learning:some text here")
 * @param {string} memoryDir
 * @returns {Map<string, number>|null} statement→relevance map, or null
 */
function loadScoresMap(memoryDir) {
  try {
    const scoresPath = join(memoryDir, "sessions", SCORES_FILE);
    if (!existsSync(scoresPath)) return null;

    const { entries } = JSON.parse(readFileSync(scoresPath, "utf8"));
    if (!entries || typeof entries !== "object") return null;

    const map = new Map();
    for (const [key, val] of Object.entries(entries)) {
      // Key format: "type:statement text..."
      const colonIdx = key.indexOf(":");
      if (colonIdx > 0) {
        const statement = key
          .slice(colonIdx + 1)
          .toLowerCase()
          .trim();
        map.set(statement, val.relevance || 0);
      }
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Find the best relevance score for an entry by matching its bullets.
 * Uses substring matching — if a bullet appears as a key prefix, it matches.
 * @param {string[]} bullets - Extracted bullet texts
 * @param {Map<string, number>} scoresMap
 * @returns {number} Best relevance (0 if no match)
 */
function matchEntryScore(bullets, scoresMap) {
  if (!scoresMap || bullets.length === 0) return 0;

  let bestScore = 0;
  for (const bullet of bullets) {
    const normalized = bullet.toLowerCase().trim();
    if (normalized.length < 10) continue;

    // Exact match first
    if (scoresMap.has(normalized)) {
      bestScore = Math.max(bestScore, scoresMap.get(normalized));
      continue;
    }

    // Prefix match: check if any scored key starts with this bullet's first 40 chars
    const prefix = normalized.slice(0, 40);
    for (const [key, relevance] of scoresMap) {
      if (key.startsWith(prefix) || prefix.startsWith(key.slice(0, 40))) {
        bestScore = Math.max(bestScore, relevance);
        break; // One match per bullet is enough
      }
    }
  }

  return bestScore;
}

// ─── Consolidation Engine ────────────────────────────────────────────────────

/**
 * Score an entry for archival ranking.
 * Lower score = more likely to be archived.
 * @param {object} entry - Parsed entry
 * @param {Map<string, number>|null} scoresMap - Memory scores (null if unavailable)
 * @returns {number} Consolidation score (higher = keep, lower = archive)
 */
function scoreEntry(entry, scoresMap) {
  const age = ageDays(entry.date);

  // Protected: recent entries are never archived
  if (age < PROTECT_DAYS) return Infinity;

  let score = 0;

  // 1. Memory-scores relevance (primary signal when available)
  const relevance = matchEntryScore(entry.bullets, scoresMap);
  if (relevance > 0) {
    score += relevance * 10; // Scale up: 0.3 relevance → 3.0 score
  }

  // 2. Recency bonus (decays with age)
  score += RECENCY_WEIGHT / Math.max(age / 30, 0.1);

  // 3. Named entry bonus (hand-curated > auto-summary)
  if (entry.type === "named") {
    score += NAMED_BONUS;
  }

  // 4. Content richness bonus (more bullets = more knowledge)
  score += Math.min(entry.bullets.length * 0.05, 0.25);

  return score;
}

/**
 * Consolidate learnings: archive excess entries to keep file manageable.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ archived: number, remaining: number, strategy: string } | null}
 */
export function consolidateLearnings(memoryDir) {
  try {
    const learningsPath = join(memoryDir, "04_LEARNINGS.md");
    if (!existsSync(learningsPath)) return null;

    const raw = readFileSync(learningsPath, "utf8");
    const entries = parseEntries(raw);

    // Count actual content entries (not preamble)
    const contentEntries = entries.filter((e) => e.type !== "preamble");

    // Don't consolidate if under threshold
    if (contentEntries.length <= MAX_ACTIVE) return null;
    if (contentEntries.length < MIN_ENTRIES_TO_CONSOLIDATE) return null;

    // Load memory scores (may be null)
    const scoresMap = loadScoresMap(memoryDir);
    const strategy = scoresMap ? "score-based" : "age-based";

    // Score all content entries
    const scored = contentEntries.map((entry) => ({
      entry,
      score: scoreEntry(entry, scoresMap),
    }));

    // Sort: lowest score first (candidates for archival)
    scored.sort((a, b) => a.score - b.score);

    // How many to archive?
    const toArchiveCount = contentEntries.length - MAX_ACTIVE;
    if (toArchiveCount <= 0) return null;

    // Split: archive the lowest-scored, keep the rest
    const toArchive = scored
      .slice(0, toArchiveCount)
      .filter((s) => s.score !== Infinity); // Never archive protected

    if (toArchive.length === 0) return null;

    // Build archive content
    const archiveEntries = toArchive.map((s) => s.entry);
    const archiveSet = new Set(archiveEntries);

    // ── Write archive ─────────────────────────────────────────────
    const archivePath = join(memoryDir, "04_LEARNINGS_ARCHIVE.md");
    const now = new Date().toISOString().slice(0, 10);
    const archiveHeader = `\n---\n\n> Archived ${toArchive.length} entries on ${now} (strategy: ${strategy})\n\n`;
    const archiveBody = archiveEntries.map((e) => e.body).join("\n\n");

    if (existsSync(archivePath)) {
      // Append to existing archive
      const existing = readFileSync(archivePath, "utf8");

      // Cap archive size
      const existingSections = existing
        .split(/(?=^## )/m)
        .filter((p) => p.trim());
      if (existingSections.length + toArchive.length > MAX_ARCHIVE) {
        // Trim oldest archive entries (at the beginning)
        const keepCount = MAX_ARCHIVE - toArchive.length;
        const trimmed = existingSections.slice(-keepCount).join("\n\n");
        writeFileSync(
          archivePath,
          trimmed + archiveHeader + archiveBody + "\n",
          "utf8",
        );
      } else {
        writeFileSync(
          archivePath,
          existing.trimEnd() + archiveHeader + archiveBody + "\n",
          "utf8",
        );
      }
    } else {
      const header =
        "# Learnings Archive\n\n" +
        "<!-- Archived entries from 04_LEARNINGS.md. Low-relevance or stale entries. -->\n" +
        "<!-- These can be searched if needed but don't pollute the active file. -->\n";
      writeFileSync(
        archivePath,
        header + archiveHeader + archiveBody + "\n",
        "utf8",
      );
    }

    // ── Rewrite active learnings ──────────────────────────────────
    const preambles = entries.filter((e) => e.type === "preamble");
    const surviving = entries.filter(
      (e) => e.type !== "preamble" && !archiveSet.has(e),
    );

    const newContent =
      preambles.map((e) => e.body).join("\n\n") +
      "\n\n" +
      surviving.map((e) => e.body).join("\n\n") +
      "\n";

    writeFileSync(learningsPath, newContent, "utf8");

    return {
      archived: toArchive.length,
      remaining: surviving.length,
      strategy,
    };
  } catch {
    return null;
  }
}
