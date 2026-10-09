/**
 * search-cache.mjs — MiniSearch cache lifecycle for fuzzy knowledge search.
 * Responsibilities:
 *   1. Build: Parse opinions + troubleshooting + learnings → MiniSearch index → serialize
 *   2. Query: Load cache, auto-rebuild if stale, fuzzy search with BM25 scoring
 *   3. Health: Track opinion health metrics (total, avg confidence, stale count)
 * Auto-rebuild: If 14_OPINIONS.md has been modified since the cache was built,
 * the cache is transparently rebuilt before querying. This ensures mid-session
 * opinion changes are immediately searchable.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { safeRead } from "./fs-utils.mjs";
import { recordQueryHits } from "./memory-scorer.mjs";
import MiniSearch from "./minisearch.mjs";

/** MiniSearch index configuration — shared between build and load */
const INDEX_OPTIONS = {
  fields: ["searchText", "domain", "statement"],
  storeFields: ["type", "domain", "statement", "confidence"],
};

/**
 * Build a MiniSearch index from opinions + troubleshooting + learnings.
 * Writes serialized cache to sessions/search-cache.json.
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ docCount: number, health: object } | null} Build result or null on failure
 */
export function buildSearchCache(memoryDir) {
  try {
    const sessionsDir = join(memoryDir, "sessions");
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const documents = [];
    let docId = 0;

    // ── Health tracking ─────────────────────────────────────────────
    const health = {
      totalOpinions: 0,
      avgConfidence: 0,
      lowConfidence: 0, // < 0.3
      highConfidence: 0, // >= 0.8
      troubleshootingCount: 0,
      learningsCount: 0,
    };

    // ── 1. Parse 14_OPINIONS.md ─────────────────────────────────────
    const opinionsRaw = safeRead(join(memoryDir, "14_OPINIONS.md"), 15000);
    if (opinionsRaw) {
      let currentDomain = "general";
      let currentStatement = null;
      let currentConfidence = 0;
      let confSum = 0;

      const flushEntry = () => {
        if (currentStatement && currentConfidence >= 0.5) {
          documents.push({
            id: docId++,
            type: "opinion",
            domain: currentDomain,
            statement: currentStatement,
            confidence: currentConfidence,
            searchText: `${currentDomain} ${currentStatement}`,
          });
          health.totalOpinions++;
          confSum += currentConfidence;
          if (currentConfidence < 0.3) health.lowConfidence++;
          if (currentConfidence >= 0.8) health.highConfidence++;
        }
        currentStatement = null;
        currentConfidence = 0;
      };

      for (const line of opinionsRaw.split("\n")) {
        const domainMatch = line.match(/^## (\w+)/);
        if (domainMatch) {
          flushEntry();
          currentDomain = domainMatch[1];
          continue;
        }
        if (line.match(/^### op_\w+/)) {
          flushEntry();
          continue;
        }
        const stmtMatch = line.match(/^- \*\*Statement\*\*: (.+)/);
        if (stmtMatch) {
          currentStatement = stmtMatch[1].trim();
          continue;
        }
        const confMatch = line.match(/^- \*\*Confidence\*\*: ([\d.]+)/);
        if (confMatch) {
          currentConfidence = parseFloat(confMatch[1]);
          continue;
        }
      }
      flushEntry();

      if (health.totalOpinions > 0) {
        health.avgConfidence = +(confSum / health.totalOpinions).toFixed(3);
      }
    }

    // ── 2. Parse 05_TROUBLESHOOTING.md ──────────────────────────────
    const troubleRaw = safeRead(
      join(memoryDir, "05_TROUBLESHOOTING.md"),
      15000,
    );
    if (troubleRaw) {
      for (const section of troubleRaw.split(/^## /m).filter(Boolean)) {
        const lines = section.split("\n");
        const title = lines[0]?.trim() || "";
        if (!title) continue;
        const body = lines.slice(1).join(" ").trim().slice(0, 200);
        documents.push({
          id: docId++,
          type: "troubleshooting",
          domain: "troubleshooting",
          statement: title,
          confidence: 1.0,
          searchText: `${title} ${body}`,
        });
        health.troubleshootingCount++;
      }
    }

    // ── 3. Parse 04_LEARNINGS.md section titles ─────────────────────
    const learningsRaw = safeRead(join(memoryDir, "04_LEARNINGS.md"), 10000);
    if (learningsRaw) {
      for (const section of learningsRaw.split(/^## /m).filter(Boolean)) {
        const title = section.split("\n")[0]?.trim() || "";
        if (!title || title.length < 5) continue;
        documents.push({
          id: docId++,
          type: "learning",
          domain: "learnings",
          statement: title,
          confidence: 1.0,
          searchText: title,
        });
        health.learningsCount++;
      }
    }

    // ── 3b. Index temporal mailbox notes (Tesseract) ────────────────
    try {
      const mailboxPath = join(sessionsDir, "temporal-mailbox.jsonl");
      if (existsSync(mailboxPath)) {
        const lines = readFileSync(mailboxPath, "utf8")
          .split("\n")
          .filter(Boolean);
        for (const line of lines) {
          try {
            const note = JSON.parse(line);
            if (note.promoted || Date.now() - note.timestamp > 2 * 60 * 60 * 1000) continue;
            documents.push({
              id: docId++,
              type: "temporal",
              domain: "self-reminder",
              statement: note.text,
              confidence: note.importance || 0.7,
              searchText: `temporal reminder ${note.text}`,
            });
          } catch {  }
        }
      }
    } catch {  }

    if (documents.length === 0) return null;

    // ── 4. Build MiniSearch index ───────────────────────────────────
    const miniSearch = new MiniSearch(INDEX_OPTIONS);
    miniSearch.addAll(documents);

    // ── 5. Serialize to disk ────────────────────────────────────────
    const cacheData = {
      version: 2,
      builtAt: new Date().toISOString(),
      docCount: documents.length,
      health,
      options: INDEX_OPTIONS,
      index: JSON.stringify(miniSearch),
    };

    writeFileSync(
      join(sessionsDir, "search-cache.json"),
      JSON.stringify(cacheData),
      "utf8",
    );

    return { docCount: documents.length, health };
  } catch {
    return null;
  }
}

/**
 * Check if the search cache is stale (opinions modified after cache build).
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {boolean} true if cache needs rebuild
 */
function isCacheStale(sessionsDir, memoryDir) {
  try {
    const cachePath = join(sessionsDir, "search-cache.json");
    if (!existsSync(cachePath)) return true;

    const cacheRaw = readFileSync(cachePath, "utf8");
    const cacheData = JSON.parse(cacheRaw);
    if (!cacheData.builtAt) return true;

    const cacheTime = new Date(cacheData.builtAt).getTime();

    // Check if any source file has been modified after cache was built
    const sourceFiles = [
      join(memoryDir, "14_OPINIONS.md"),
      join(memoryDir, "05_TROUBLESHOOTING.md"),
      join(memoryDir, "04_LEARNINGS.md"),
    ];

    for (const filePath of sourceFiles) {
      if (!existsSync(filePath)) continue;
      const mtime = statSync(filePath).mtimeMs;
      if (mtime > cacheTime) return true;
    }

    return false;
  } catch {
    return true; // rebuild on any error
  }
}

/**
 * Query the MiniSearch cache for relevant opinions/troubleshooting/learnings.
 * Auto-rebuilds if source files have been modified since last cache build.
 * @param {string} sessionsDir - Path to .project-brain/memory/sessions/
 * @param {string} query - Search query (domain keywords joined by spaces)
 * @param {number} [maxResults=5] - Maximum results to return
 * @returns {string} Formatted bullet-list results or empty string
 */
export function querySearchCache(sessionsDir, query, maxResults = 5) {
  try {
    if (!query || !query.trim()) return "";

    const memoryDir = dirname(sessionsDir);

    // ── Auto-rebuild if stale ───────────────────────────────────────
    if (isCacheStale(sessionsDir, memoryDir)) {
      buildSearchCache(memoryDir);
    }

    // ── Load cache ──────────────────────────────────────────────────
    const cachePath = join(sessionsDir, "search-cache.json");
    if (!existsSync(cachePath)) return "";

    const raw = readFileSync(cachePath, "utf8");
    const cacheData = JSON.parse(raw);
    if (!cacheData.index || !cacheData.options) return "";

    const miniSearch = MiniSearch.loadJSON(cacheData.index, cacheData.options);

    const results = miniSearch.search(query, {
      fuzzy: 0.2,
      prefix: true,
      boost: { statement: 2 },
    });

    if (results.length === 0) return "";

    const topResults = results.slice(0, maxResults);

    // ── Record hits for memory scoring (best-effort) ────────────────
    try {
      recordQueryHits(sessionsDir, topResults);
    } catch {
      /* never block queries */
    }

    return topResults
      .map((r) => {
        const conf =
          r.confidence !== undefined
            ? ` (c=${Number(r.confidence).toFixed(2)})`
            : "";
        const domain = r.domain || "general";
        return `• [${domain}]${conf} ${r.statement || ""}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}
