/**
 * dedup-learnings.mjs — Deduplicate 04_LEARNINGS.md Auto-Summary entries.
 * Problem: The extension's session-summarizer writes near-identical Auto-Summary
 * entries on each session stop, causing massive file bloat (169 entries, 343KB).
 * Strategy:
 *   1. Parse all entries (## headers)
 *   2. Non-Auto-Summary entries: KEEP ALL (high-quality, hand-curated)
 *   3. Auto-Summary entries on same date: cluster by token overlap
 *   4. Within each cluster: keep the most complete entry (longest)
 *   5. Add purge summary footer with stats
 * Integrated as step 3b in session-stop (before evolveOpinions).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Constants ───────────────────────────────────────────────────────────────
const OVERLAP_THRESHOLD = 0.6; // 60% token overlap = duplicate
const MIN_ENTRIES_TO_DEDUP = 5; // Don't bother if < 5 auto-summaries
const STOP_WORDS = new Set([
  "se",
  "la",
  "el",
  "los",
  "las",
  "de",
  "del",
  "en",
  "para",
  "que",
  "por",
  "con",
  "una",
  "como",
  "fue",
  "más",
  "esto",
  "esta",
  "este",
  "son",
  "sin",
  "hay",
  "ser",
  "han",
  "pero",
  "sus",
  "les",
  "dan",
  "dan",
  "uso",
  "cada",
]);

/**
 * Tokenize text for similarity comparison.
 * Filters short words and stop words for better signal.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-záéíóúüñ0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Compute Jaccard similarity between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0..1
 */
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Parse 04_LEARNINGS.md into structured entries.
 * @param {string} raw
 * @returns {{ header: string, body: string, type: 'auto'|'named'|'preamble', date: string|null, tokens: Set<string>, charLen: number }[]}
 */
function parseEntries(raw) {
  const parts = raw.split(/(?=^## )/m);
  const entries = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split("\n")[0];

    if (firstLine.startsWith("## Auto-Summary")) {
      const dateMatch = trimmed.match(/\*\*Date\*\*: (\S+)/);
      entries.push({
        header: firstLine,
        body: trimmed,
        type: "auto",
        date: dateMatch ? dateMatch[1] : "unknown",
        tokens: tokenize(trimmed),
        charLen: trimmed.length,
      });
    } else if (firstLine.startsWith("## ")) {
      entries.push({
        header: firstLine,
        body: trimmed,
        type: "named",
        date: null,
        tokens: new Set(),
        charLen: trimmed.length,
      });
    } else {
      // Preamble (# header, intro text, etc.)
      entries.push({
        header: "",
        body: trimmed,
        type: "preamble",
        date: null,
        tokens: new Set(),
        charLen: trimmed.length,
      });
    }
  }

  return entries;
}

/**
 * Cluster auto-summary entries by date + similarity.
 * @param {{ header: string, body: string, type: string, date: string|null, tokens: Set<string>, charLen: number }[]} autoEntries
 * @returns {Map<string, { representative: object, members: object[] }[]>}
 */
function clusterByDate(autoEntries) {
  // Group by date
  const byDate = new Map();
  for (const entry of autoEntries) {
    const d = entry.date || "unknown";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(entry);
  }

  // Within each date, cluster by similarity
  const clusters = new Map();
  for (const [date, entries] of byDate) {
    const dateClusters = [];
    const assigned = new Set();

    for (let i = 0; i < entries.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = { representative: entries[i], members: [entries[i]] };
      assigned.add(i);

      for (let j = i + 1; j < entries.length; j++) {
        if (assigned.has(j)) continue;
        const sim = jaccardSimilarity(entries[i].tokens, entries[j].tokens);
        if (sim >= OVERLAP_THRESHOLD) {
          cluster.members.push(entries[j]);
          assigned.add(j);
          // Keep longest as representative
          if (entries[j].charLen > cluster.representative.charLen) {
            cluster.representative = entries[j];
          }
        }
      }

      dateClusters.push(cluster);
    }

    clusters.set(date, dateClusters);
  }

  return clusters;
}

/**
 * Deduplicate 04_LEARNINGS.md.
 * Returns stats about what was changed.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ before: number, after: number, removed: number, bytesBefore: number, bytesAfter: number }}
 */
export function dedupLearnings(memoryDir) {
  const result = {
    before: 0,
    after: 0,
    removed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };

  try {
    const filePath = join(memoryDir, "04_LEARNINGS.md");
    if (!existsSync(filePath)) return result;

    const raw = readFileSync(filePath, "utf8");
    result.bytesBefore = raw.length;

    const entries = parseEntries(raw);
    const autoEntries = entries.filter((e) => e.type === "auto");
    result.before = autoEntries.length;

    // Not enough to bother deduplicating
    if (autoEntries.length < MIN_ENTRIES_TO_DEDUP) return result;

    // Cluster auto-summaries
    const clusters = clusterByDate(autoEntries);

    // Build deduplicated representatives set
    const representatives = new Set();
    let totalClusters = 0;
    for (const [, dateClusters] of clusters) {
      for (const cluster of dateClusters) {
        representatives.add(cluster.representative);
        totalClusters++;
      }
    }

    result.after = representatives.size;
    result.removed = result.before - result.after;

    // Nothing to remove
    if (result.removed === 0) return result;

    // Reconstruct file: preamble + named entries + deduplicated auto entries
    const output = [];
    for (const entry of entries) {
      if (entry.type === "preamble" || entry.type === "named") {
        output.push(entry.body);
      } else if (entry.type === "auto" && representatives.has(entry)) {
        output.push(entry.body);
      }
      // else: auto entry that's a duplicate → skip
    }

    // Add purge footer (strip any previous footer first)
    const today = new Date().toISOString().split("T")[0];
    const footer = [
      "",
      "---",
      "",
      `> Dedup cleanup: ${result.removed} duplicate Auto-Summary entries removed (${result.before} → ${result.after}). Last run: ${today}`,
    ].join("\n");

    // Remove stale dedup footers from previous runs
    const cleanedOutput = output.map((body) =>
      body.replace(/\n---\n\n> Dedup cleanup:[^\n]*/g, ""),
    );

    const finalContent = cleanedOutput.join("\n\n") + footer + "\n";
    result.bytesAfter = finalContent.length;

    writeFileSync(filePath, finalContent, "utf8");
  } catch {
    // Silent fail — don't break session-stop
  }

  return result;
}
