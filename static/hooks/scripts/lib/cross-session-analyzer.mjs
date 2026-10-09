/**
 * cross-session-analyzer.mjs — Detects patterns across sessions.
 * Three mechanisms:
 *   1. Learning Promotion: Clusters similar learnings → promotes 3+ cluster to opinion
 *   2. Staleness Decay: Opinions not updated in 30+ days get -0.02 confidence
 *   3. Hot Topic Detection: Recent learning clusters → surfaced as context
 * Uses inverted index for O(n·k) clustering instead of O(n²).
 * Called from session-stop after opinion evolution.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Constants ───────────────────────────────────────────────────────────────
const MIN_CLUSTER_SIZE = 3;
const MAX_PROMOTIONS_PER_RUN = 2;
const STALENESS_DAYS = 30;
const STALENESS_DECAY = 0.02;
const MIN_CONFIDENCE = 0.05;
const MIN_TOKEN_LENGTH = 4;
const MIN_OVERLAP_TOKENS = 3;
const MIN_BULLET_LENGTH = 20;
const RECENT_DAYS = 7;
const MAX_HOT_TOPICS = 3;

// Stopwords — common words that don't indicate semantic similarity
const STOPWORDS = new Set([
  "para",
  "como",
  "este",
  "esta",
  "esto",
  "estos",
  "esas",
  "esos",
  "that",
  "this",
  "with",
  "from",
  "have",
  "been",
  "were",
  "will",
  "what",
  "when",
  "where",
  "which",
  "their",
  "there",
  "then",
  "does",
  "also",
  "into",
  "about",
  "more",
  "some",
  "only",
  "cada",
  "todo",
  "toda",
  "todos",
  "todas",
  "entre",
  "pero",
  "por",
  "una",
  "unos",
  "unas",
  "los",
  "las",
  "del",
  "que",
  "muy",
  "sin",
  "con",
  "sobre",
  "otra",
  "otro",
  "otros",
  "code",
  "file",
  "usar",
  "used",
  "using",
  "make",
  "made",
  "should",
  "could",
  "would",
  "puede",
  "puede",
  "debe",
  "added",
  "updated",
  "changed",
  "fixed",
  "moved",
  "need",
]);

/**
 * Tokenize text for clustering. Removes noise, keeps meaningful tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/`[^`]+`/g, " ") // remove inline code
    .replace(/[^a-záéíóúüñ0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(w));
}

/**
 * Parse learning bullets from 04_LEARNINGS.md.
 * Each bullet is `- text...` under a `## Section` header.
 * Also extracts the date from the section header.
 * @param {string} raw
 * @returns {Array<{text: string, date: string|null, section: string}>}
 */
function parseLearnings(raw) {
  const bullets = [];
  let currentSection = "";
  let currentDate = null;

  for (const line of raw.split("\n")) {
    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      // Extract date from section title like "Auto-Summary (2026-02-22_14-31)"
      const dateMatch = currentSection.match(/(\d{4}-\d{2}-\d{2})/);
      currentDate = dateMatch ? dateMatch[1] : null;
      continue;
    }

    // Date field inside section
    const dateField = line.match(/^\*\*Date\*\*: (\d{4}-\d{2}-\d{2})/);
    if (dateField) {
      currentDate = dateField[1];
      continue;
    }

    const bulletMatch = line.match(/^- (.{20,})/);
    if (bulletMatch) {
      bullets.push({
        text: bulletMatch[1].trim(),
        date: currentDate,
        section: currentSection,
      });
    }
  }

  return bullets;
}

/**
 * Cluster similar bullets using inverted index.
 * Returns groups of bullets with high token overlap.
 * @param {Array<{text: string, date: string|null, section: string}>} bullets
 * @returns {Array<{representative: string, members: number[], size: number}>}
 */
function clusterBullets(bullets) {
  // Build inverted index: token → set of bullet indices
  const index = new Map();
  const bulletTokens = [];

  for (let i = 0; i < bullets.length; i++) {
    const tokens = tokenize(bullets[i].text);
    bulletTokens.push(new Set(tokens));

    for (const token of tokens) {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(i);
    }
  }

  // Find candidate pairs via inverted index
  // For each bullet, count how many tokens it shares with each other bullet
  const pairOverlap = new Map(); // "i:j" → overlap count
  const assigned = new Set();

  for (const [, indices] of index) {
    if (indices.size > 50) continue; // skip very common tokens (noise)
    const arr = [...indices];
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const key = `${Math.min(arr[a], arr[b])}:${Math.max(arr[a], arr[b])}`;
        pairOverlap.set(key, (pairOverlap.get(key) || 0) + 1);
      }
    }
  }

  // Build adjacency: pairs with overlap ≥ MIN_OVERLAP_TOKENS
  const adjacency = new Map();
  for (const [key, overlap] of pairOverlap) {
    if (overlap < MIN_OVERLAP_TOKENS) continue;
    const [i, j] = key.split(":").map(Number);

    // Verify percentage overlap (at least 30% of smaller set)
    const minSize = Math.min(bulletTokens[i].size, bulletTokens[j].size);
    if (minSize === 0 || overlap / minSize < 0.3) continue;

    if (!adjacency.has(i)) adjacency.set(i, new Set());
    if (!adjacency.has(j)) adjacency.set(j, new Set());
    adjacency.get(i).add(j);
    adjacency.get(j).add(i);
  }

  // Greedy clustering: pick node with most neighbors, expand cluster
  const clusters = [];
  const visited = new Set();

  // Sort by degree (most connected first)
  const nodes = [...adjacency.keys()].sort(
    (a, b) => adjacency.get(b).size - adjacency.get(a).size,
  );

  for (const seed of nodes) {
    if (visited.has(seed)) continue;

    const cluster = new Set([seed]);
    const queue = [seed];
    visited.add(seed);

    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbor of adjacency.get(current) || []) {
        if (visited.has(neighbor)) continue;
        // Check neighbor connects to at least half the cluster
        const adj = adjacency.get(neighbor) || new Set();
        let connections = 0;
        for (const member of cluster) {
          if (adj.has(member)) connections++;
        }
        if (connections >= cluster.size * 0.4 || cluster.size < 3) {
          cluster.add(neighbor);
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (cluster.size >= MIN_CLUSTER_SIZE) {
      const members = [...cluster];
      // Representative = the bullet with most connections
      const representative = members.reduce(
        (best, idx) =>
          (adjacency.get(idx)?.size || 0) > (adjacency.get(best)?.size || 0)
            ? idx
            : best,
        members[0],
      );
      clusters.push({
        representative: bullets[representative].text,
        members,
        size: cluster.size,
      });
    }
  }

  // Sort by size descending
  return clusters.sort((a, b) => b.size - a.size);
}

/**
 * Parse opinions from 14_OPINIONS.md (reused from opinion-tracker).
 * @param {string} raw
 * @returns {Array<{id: string, statement: string, confidence: number, updated: string}>}
 */
function parseOpinions(raw) {
  const opinions = [];
  let currentId = null;
  let currentStatement = null;
  let currentConfidence = 0;
  let currentUpdated = "";

  const flush = () => {
    if (currentId && currentStatement) {
      opinions.push({
        id: currentId,
        statement: currentStatement,
        confidence: currentConfidence,
        updated: currentUpdated,
      });
    }
    currentId = null;
    currentStatement = null;
    currentConfidence = 0;
    currentUpdated = "";
  };

  for (const line of raw.split("\n")) {
    const idMatch = line.match(/^### (op_\w+)/);
    if (idMatch) {
      flush();
      currentId = idMatch[1];
      continue;
    }
    const stmtMatch = line.match(/^- \*\*Statement\*\*: (.+)/);
    if (stmtMatch) currentStatement = stmtMatch[1].trim();
    const confMatch = line.match(/^- \*\*Confidence\*\*: ([\d.]+)/);
    if (confMatch) currentConfidence = parseFloat(confMatch[1]);
    const updMatch = line.match(/^- \*\*Updated\*\*: ([\d-]+)/);
    if (updMatch) currentUpdated = updMatch[1];
  }
  flush();
  return opinions;
}

/**
 * Check if a candidate statement overlaps with any existing opinion.
 * @param {string} candidate
 * @param {Array<{statement: string}>} opinions
 * @returns {boolean}
 */
function isDuplicateOfOpinion(candidate, opinions) {
  const candTokens = new Set(tokenize(candidate));
  if (candTokens.size === 0) return false;

  for (const op of opinions) {
    const opTokens = new Set(tokenize(op.statement));
    let overlap = 0;
    for (const t of candTokens) {
      if (opTokens.has(t)) overlap++;
    }
    if (
      overlap >= MIN_OVERLAP_TOKENS &&
      opTokens.size > 0 &&
      overlap / opTokens.size >= 0.3
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Guess domain for a new opinion.
 * @param {string} statement
 * @returns {string}
 */
function guessDomain(statement) {
  const lower = statement.toLowerCase();
  if (/\b(import|module|depend|package|npm|architecture)\b/.test(lower))
    return "architecture";
  if (/\b(test|assert|mock|spec|fixture)\b/.test(lower)) return "testing";
  if (/\b(deploy|build|compile|bundle|esbuild)\b/.test(lower)) return "tools";
  if (/\b(hook|session|identity|memory|opinion)\b/.test(lower))
    return "architecture";
  if (/\b(security|auth|key|token|permission)\b/.test(lower)) return "security";
  return "general";
}

/**
 * Main analysis function. Runs all three mechanisms.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ promoted: number, decayed: number, hotTopics: string[], clusters: number }}
 */
export function analyzePatterns(memoryDir) {
  const result = { promoted: 0, decayed: 0, hotTopics: [], clusters: 0 };

  try {
    const learningsPath = join(memoryDir, "04_LEARNINGS.md");
    const opinionsPath = join(memoryDir, "14_OPINIONS.md");

    if (!existsSync(learningsPath)) return result;

    const learningsRaw = readFileSync(learningsPath, "utf8");
    const bullets = parseLearnings(learningsRaw);

    if (bullets.length === 0) return result;

    // ── 1. Cluster similar learnings ──────────────────────────────────
    const clusters = clusterBullets(bullets);
    result.clusters = clusters.length;

    // ── 2. Promote top clusters to opinions ──────────────────────────
    if (existsSync(opinionsPath) && clusters.length > 0) {
      const opinionsRaw = readFileSync(opinionsPath, "utf8");
      const opinions = parseOpinions(opinionsRaw);
      let updated = opinionsRaw;
      let promotedCount = 0;

      for (const cluster of clusters) {
        if (promotedCount >= MAX_PROMOTIONS_PER_RUN) break;

        // Skip if already covered by an existing opinion
        if (isDuplicateOfOpinion(cluster.representative, opinions)) continue;

        // Create new opinion from cluster representative
        const id = "op_" + Math.random().toString(36).substring(2, 8);
        const today = new Date().toISOString().split("T")[0];
        const domain = guessDomain(cluster.representative);
        const confidence = Math.min(0.6 + cluster.size * 0.05, 0.85);

        const block = [
          `\n### ${id}\n`,
          `- **Statement**: ${cluster.representative}`,
          `- **Confidence**: ${confidence.toFixed(2)}`,
          `- **Created**: ${today}`,
          `- **Updated**: ${today}`,
          `- **Supporting**: cross-session-promotion (${cluster.size} similar learnings)`,
        ].join("\n");

        updated = updated.trimEnd() + "\n" + block + "\n";
        promotedCount++;
        result.promoted++;

        // Track to avoid self-duplicate in next iteration
        opinions.push({
          id,
          statement: cluster.representative,
          confidence,
          updated: today,
        });
      }

      // ── 3. Staleness decay ───────────────────────────────────────────
      const today = new Date();
      for (const op of opinions) {
        if (!op.updated) continue;
        const updatedDate = new Date(op.updated);
        const daysSince = Math.floor(
          (today - updatedDate) / (1000 * 60 * 60 * 24),
        );

        if (daysSince >= STALENESS_DAYS && op.confidence > MIN_CONFIDENCE) {
          const newConf = Math.max(
            op.confidence - STALENESS_DECAY,
            MIN_CONFIDENCE,
          );
          if (newConf !== op.confidence) {
            const confRegex = new RegExp(
              `(### ${op.id}[\\s\\S]*?- \\*\\*Confidence\\*\\*: )[\\d.]+`,
            );
            updated = updated.replace(
              confRegex,
              (_, prefix) => prefix + newConf.toFixed(2),
            );
            result.decayed++;
          }
        }
      }

      // Update metadata
      if (result.promoted > 0 || result.decayed > 0) {
        const countMatch = updated.match(
          /> Auto-generated by Project Brain\. (\d+) opinions tracked\./,
        );
        if (countMatch) {
          const origCount = parseInt(countMatch[1]);
          const newCount = origCount + result.promoted;
          updated = updated.replace(
            /> Auto-generated by Project Brain\. \d+ opinions tracked\./,
            `> Auto-generated by Project Brain. ${newCount} opinions tracked.`,
          );
        }
        updated = updated.replace(
          /> Last updated: [\d-]+/,
          `> Last updated: ${today.toISOString().split("T")[0]}`,
        );

        writeFileSync(opinionsPath, updated, "utf8");
      }
    }

    // ── 4. Hot topic detection (recent learnings clusters) ─────────
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RECENT_DAYS);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const recentBullets = bullets.filter((b) => b.date && b.date >= cutoffStr);
    if (recentBullets.length >= 5) {
      const recentClusters = clusterBullets(recentBullets);
      result.hotTopics = recentClusters
        .slice(0, MAX_HOT_TOPICS)
        .map((c) => `${c.representative} (${c.size} mentions)`);
    }

    return result;
  } catch {
    return result;
  }
}
