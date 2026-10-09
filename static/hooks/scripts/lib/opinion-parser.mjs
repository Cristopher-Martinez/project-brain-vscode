/**
 * opinion-parser.mjs — Single source of truth for parsing 14_OPINIONS.md.
 * Replaces 5 duplicated parsers across session-start, session-stop,
 * subagent-start, post-tool-capture, and opinion-tracker.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Parse all opinions from raw 14_OPINIONS.md content.
 * @param {string} raw - Raw markdown
 * @returns {Array<{id: string|null, domain: string, statement: string, confidence: number, supporting: string[], line: number}>}
 */
export function parseOpinions(raw) {
  const opinions = [];
  let domain = "general", id = null, stmt = null, conf = 0, supp = [], lineNum = 0, blockStart = 0;

  const flush = () => {
    if (stmt) {
      opinions.push({ id, domain, statement: stmt, confidence: conf, supporting: supp, line: blockStart });
    }
    id = null; stmt = null; conf = 0; supp = [];
  };

  for (const line of raw.split("\n")) {
    lineNum++;
    const dm = line.match(/^## (\w+)/);
    if (dm) { flush(); domain = dm[1]; continue; }
    const im = line.match(/^### (op_\w+)/);
    if (im) { flush(); id = im[1]; blockStart = lineNum; continue; }
    const sm = line.match(/^- \*\*Statement\*\*: (.+)/);
    if (sm) { stmt = sm[1].trim(); continue; }
    const cm = line.match(/^- \*\*Confidence\*\*: ([\d.]+)/);
    if (cm) { conf = parseFloat(cm[1]); continue; }
    const sp = line.match(/^- \*\*Supporting\*\*: (.+)/);
    if (sp) { supp = sp[1].split(";").map(s => s.trim()).filter(Boolean); continue; }
  }
  flush();
  return opinions;
}

/**
 * Read + parse + filter + sort + format top opinions as bullet lines.
 * @param {string} memDir - .project-brain/memory/ path
 * @param {object} [opts]
 * @param {number} [opts.n=8] - Top N to return
 * @param {number} [opts.minConfidence=0] - Minimum confidence threshold
 * @param {number} [opts.maxBytes=0] - Max bytes to read (0 = unlimited)
 * @param {(s:string)=>string} [opts.sanitize] - Optional sanitizer for statements
 * @param {string} [opts.bullet="•"] - Bullet character
 * @param {number} [opts.truncate=0] - Truncate statement to N chars (0 = no truncation)
 * @returns {string} Formatted bullet list or empty string
 */
export function getTopOpinions(memDir, opts = {}) {
  const { n = 8, minConfidence = 0, maxBytes = 0, sanitize, bullet = "•", truncate = 0 } = opts;
  try {
    const path = join(memDir, "14_OPINIONS.md");
    if (!existsSync(path)) return "";
    const raw = maxBytes > 0
      ? readFileSync(path, "utf8").slice(0, maxBytes)
      : readFileSync(path, "utf8");
    if (!raw) return "";

    const all = parseOpinions(raw).filter(o => o.confidence >= minConfidence);
    if (!all.length) return "";

    return all
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, n)
      .map(o => {
        const s = sanitize ? sanitize(o.statement) : o.statement;
        const txt = truncate > 0 ? s.slice(0, truncate) : s;
        return `${bullet} [${o.domain}] (c=${o.confidence.toFixed(2)}) ${txt}`;
      })
      .join("\n");
  } catch { return ""; }
}

/**
 * Find opinions relevant to specific domains/keywords.
 * @param {string} memDir - .project-brain/memory/ path
 * @param {string[]} domains - Keywords to match against statement + domain
 * @param {object} [opts]
 * @param {number} [opts.n=5] - Max results
 * @param {number} [opts.minConfidence=0.6] - Min confidence
 * @param {number} [opts.maxBytes=8000] - Read cap
 * @param {(sessionsDir:string, query:string, n:number)=>string|null} [opts.searchCache] - Optional MiniSearch fallback
 * @returns {string} Formatted matches or empty string
 */
export function findRelevantOpinions(memDir, domains, opts = {}) {
  const { n = 5, minConfidence = 0.6, maxBytes = 8000, searchCache } = opts;
  try {
    if (searchCache) {
      const sessionsDir = join(memDir, "sessions");
      const cached = searchCache(sessionsDir, domains.join(" "), n);
      if (cached) return cached;
    }

    const path = join(memDir, "14_OPINIONS.md");
    if (!existsSync(path)) return "";
    const raw = readFileSync(path, "utf8").slice(0, maxBytes);
    if (!raw) return "";

    const all = parseOpinions(raw).filter(o => o.confidence >= minConfidence);
    const matches = all.filter(o => {
      const lower = (o.statement + " " + o.domain).toLowerCase();
      return domains.some(d => lower.includes(d));
    });

    if (!matches.length) return "";
    return matches
      .slice(0, n)
      .map(o => `• [${o.domain}] (c=${o.confidence.toFixed(2)}) ${o.statement}`)
      .join("\n");
  } catch { return ""; }
}
