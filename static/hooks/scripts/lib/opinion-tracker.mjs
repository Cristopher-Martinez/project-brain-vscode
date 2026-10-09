/**
 * opinion-tracker.mjs — Agent-mode opinion evolution.
 * Detects when tool outputs implicitly reinforce, contradict, or generate opinions.
 * Works via three mechanisms:
 *   1. Reinforcement: Scans tool output against existing opinions for semantic overlap
 *   2. Contradiction: Detects negation XOR + antonym pairs → lowers confidence
 *   3. Genesis: Extracts new opinions from capture patterns (decision, architecture)
 * Uses same capture buffer as capture-buffer.mjs — processes during session-stop.
 * Writes directly to 14_OPINIONS.md.
 * Constants mirror src/opinion-types.ts:
 *   REINFORCE_DELTA = 0.05, MAX_CONFIDENCE = 0.99, MIN_CONFIDENCE = 0.05
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseOpinions } from "./opinion-parser.mjs";

// ── Constants (mirrored from src/opinion-types.ts) ──────────────────────────
const REINFORCE_DELTA = 0.05;
const MAX_CONFIDENCE = 0.99;
const MIN_CONFIDENCE = 0.05;
const MAX_REINFORCEMENTS_PER_SESSION = 3;
const MAX_NEW_OPINIONS_PER_SESSION = 3;
const MIN_SIMILARITY_TOKENS = 3;

// ── Contradiction detection ─────────────────────────────────────────────────
const NEGATION_RX =
  /\b(no[t]?|don'?t|won'?t|can'?t|shouldn'?t|never|nunca|jamás|evitar|avoid)\b/i;
const ANTONYM_PAIRS = [
  ["usar", "evitar"],
  ["use", "avoid"],
  ["siempre", "nunca"],
  ["always", "never"],
  ["funciona", "falla"],
  ["works", "fails"],
  ["mejor", "peor"],
  ["better", "worse"],
  ["incluir", "excluir"],
  ["include", "exclude"],
  ["agregar", "eliminar"],
  ["add", "remove"],
];

// ── Decision/architecture patterns for new opinion genesis ──────────────────
const OPINION_PATTERNS = [
  /(?:decid[ií]|decided|chose|eleg[ií])\s+(?:to\s+|que\s+)?(.{15,120})/i,
  /(?:should\s+(?:always|never)|siempre\s+(?:hay que|se debe)|nunca\s+(?:usar|hacer))\s+(.{10,100})/i,
  /(?:best practice|buena pr[aá]ctica|patr[oó]n recomendado)[:.]?\s*(.{10,100})/i,
  /(?:prefer|prefiero|better to|es mejor)\s+(.{10,100})/i,
];

// parseOpinions imported from ./opinion-parser.mjs

/**
 * Tokenize a statement for simple overlap comparison.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Check if a text semantically overlaps with an opinion statement.
 * Uses token overlap (Jaccard-like).
 * @param {string} text - Text from tool output
 * @param {string} statement - Opinion statement
 * @returns {boolean}
 */
function hasOverlap(text, statement) {
  const textTokens = tokenize(text);
  const stmtTokens = tokenize(statement);
  if (stmtTokens.size === 0) return false;

  let overlap = 0;
  for (const t of textTokens) {
    if (stmtTokens.has(t)) overlap++;
  }
  return overlap >= MIN_SIMILARITY_TOKENS && overlap / stmtTokens.size >= 0.4;
}

/**
 * Detect if text contradicts an existing opinion statement.
 * Uses negation XOR (one side negates, the other doesn't) + antonym pairs.
 * Requires >= 2 shared topic tokens to avoid false positives.
 * @param {string} text - New text from session
 * @param {string} statement - Existing opinion statement
 * @returns {boolean}
 */
function detectsContradiction(text, statement) {
  const textTokens = tokenize(text);
  const stmtTokens = tokenize(statement);
  const shared = [...stmtTokens].filter((t) => textTokens.has(t));
  if (shared.length < 2) return false;

  const textNeg = NEGATION_RX.test(text);
  const stmtNeg = NEGATION_RX.test(statement);
  if (textNeg !== stmtNeg) return true;

  const tl = text.toLowerCase();
  const sl = statement.toLowerCase();
  for (const [a, b] of ANTONYM_PAIRS) {
    if (
      (sl.includes(a) && tl.includes(b)) ||
      (sl.includes(b) && tl.includes(a))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Process the capture buffer to evolve opinions.
 * Called from session-stop alongside processCaptureBuffer.
 * 1. Reads capture-buffer.jsonl
 * 2. For each entry, checks contradiction → lower confidence
 * 3. For each entry, checks overlap with existing opinions → reinforce
 * 4. For each entry, checks opinion patterns → create new opinion
 * 5. Writes updated 14_OPINIONS.md
 * @param {string} memoryDir - Path to .project-brain/memory/
 * @returns {{ reinforced: number, created: number, contradicted: number }}
 */
export function evolveOpinions(memoryDir) {
  const result = { reinforced: 0, created: 0, contradicted: 0 };

  try {
    const opinionsPath = join(memoryDir, "14_OPINIONS.md");
    const bufferPath = join(memoryDir, "sessions", "capture-buffer.jsonl");

    if (!existsSync(opinionsPath) || !existsSync(bufferPath)) return result;

    const raw = readFileSync(opinionsPath, "utf8");
    const opinions = parseOpinions(raw);
    const bufferRaw = readFileSync(bufferPath, "utf8").trim();
    if (!bufferRaw) return result;

    const entries = bufferRaw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (entries.length === 0) return result;

    // Track touches per opinion (session cap) + contradiction tracking
    const touchCount = new Map();
    const contradictedIds = new Set();
    let newOpinionCount = 0;
    const lines = raw.split("\n");

    // ── Phase 1: Reinforcement + Contradiction Detection ────────────
    for (const entry of entries) {
      const text = entry.text || "";
      if (text.length < 15) continue;

      for (const op of opinions) {
        const count = touchCount.get(op.id) || 0;
        if (count >= MAX_REINFORCEMENTS_PER_SESSION) continue;

        if (hasOverlap(text, op.statement)) {
          // Contradiction: lower confidence instead of reinforcing
          if (detectsContradiction(text, op.statement)) {
            op.confidence = Math.max(
              op.confidence - REINFORCE_DELTA,
              MIN_CONFIDENCE,
            );
            touchCount.set(op.id, count + 1);
            contradictedIds.add(op.id);
            result.contradicted++;
            continue;
          }
          // Reinforce: update confidence in-place
          const oldConf = op.confidence;
          op.confidence = Math.min(oldConf + REINFORCE_DELTA, MAX_CONFIDENCE);
          op.supporting.push("agent-session");
          touchCount.set(op.id, count + 1);
          result.reinforced++;
        }
      }
    }

    // ── Phase 2: New opinion genesis ────────────────────────────────
    const newOpinions = [];
    for (const entry of entries) {
      if (newOpinionCount >= MAX_NEW_OPINIONS_PER_SESSION) break;
      const text = entry.text || "";
      if (text.length < 20) continue;

      for (const pattern of OPINION_PATTERNS) {
        const match = text.match(pattern);
        if (!match || !match[1]) continue;

        const candidate = match[1].trim();
        if (candidate.length < 15 || candidate.length > 150) continue;

        // Check not duplicate of existing
        const isDup = opinions.some((op) =>
          hasOverlap(candidate, op.statement),
        );
        if (isDup) continue;

        // Also check not duplicate of other new opinions
        const isDupNew = newOpinions.some((no) =>
          hasOverlap(candidate, no.statement),
        );
        if (isDupNew) continue;

        const id = "op_" + Math.random().toString(36).substring(2, 8);
        const today = new Date().toISOString().split("T")[0];
        newOpinions.push({
          id,
          domain: guessDomain(candidate),
          statement: candidate,
          confidence: 0.6,
          created: today,
          updated: today,
        });
        newOpinionCount++;
        result.created++;
        break; // one opinion per entry max
      }
    }

    // ── Phase 3: Write back ─────────────────────────────────────────
    if (result.reinforced > 0 || result.created > 0) {
      let updated = raw;

      // Update touched opinions in-place (reinforced OR contradicted)
      for (const op of opinions) {
        const count = touchCount.get(op.id) || 0;
        if (count === 0) continue;

        // Replace confidence line
        const confRegex = new RegExp(
          `(### ${op.id}[\\s\\S]*?- \\*\\*Confidence\\*\\*: )[\\d.]+`,
        );
        updated = updated.replace(
          confRegex,
          (_, prefix) => prefix + op.confidence.toFixed(2),
        );

        // Replace updated date
        const dateRegex = new RegExp(
          `(### ${op.id}[\\s\\S]*?- \\*\\*Updated\\*\\*: )[\\d-]+`,
        );
        const today = new Date().toISOString().split("T")[0];
        updated = updated.replace(dateRegex, (_, prefix) => prefix + today);

        // Skip supporting update for contradicted opinions
        if (contradictedIds.has(op.id)) continue;

        // Update supporting evidence (compact: use counter instead of appending)
        const suppRegex = new RegExp(
          `(### ${op.id}[\\s\\S]*?- \\*\\*Supporting\\*\\*: )(.+)`,
        );
        updated = updated.replace(suppRegex, (_, prefix, existing) => {
          // Count existing agent-session references
          const counterMatch = existing.match(/agent-session\(x(\d+)\)/);
          const plainCount = (existing.match(/agent-session(?!\()/g) || [])
            .length;
          const prevCount = counterMatch
            ? parseInt(counterMatch[1])
            : plainCount;
          const newCount = prevCount + count;

          // Remove old agent-session references, add compact counter
          let cleaned = existing
            .replace(/;\s*agent-session\(x\d+\)/g, "")
            .replace(/;\s*agent-session(?!\()/g, "")
            .replace(/^agent-session\(x\d+\);\s*/g, "")
            .replace(/^agent-session;\s*/g, "")
            .trim();

          const suffix = `agent-session(x${newCount})`;
          return prefix + (cleaned ? `${cleaned}; ${suffix}` : suffix);
        });
      }

      // Append new opinions at end
      if (newOpinions.length > 0) {
        const blocks = newOpinions.map((op) => {
          return [
            `\n### ${op.id}\n`,
            `- **Statement**: ${op.statement}`,
            `- **Confidence**: ${op.confidence.toFixed(2)}`,
            `- **Created**: ${op.created}`,
            `- **Updated**: ${op.updated}`,
            `- **Supporting**: agent-genesis`,
          ].join("\n");
        });

        // Find last domain section or append under "general"
        const lastDomainIdx = updated.lastIndexOf("\n## ");
        if (lastDomainIdx > 0) {
          // Append after last opinion in last domain
          updated = updated.trimEnd() + "\n" + blocks.join("\n") + "\n";
        } else {
          updated += "\n## general\n" + blocks.join("\n") + "\n";
        }
      }

      // Update header count
      const countMatch = updated.match(
        /> Auto-generated by Project Brain\. (\d+) opinions tracked\./,
      );
      if (countMatch) {
        const newCount = opinions.length + newOpinions.length;
        updated = updated.replace(
          /> Auto-generated by Project Brain\. \d+ opinions tracked\./,
          `> Auto-generated by Project Brain. ${newCount} opinions tracked.`,
        );
      }
      // Update last updated date
      updated = updated.replace(
        /> Last updated: [\d-]+/,
        `> Last updated: ${new Date().toISOString().split("T")[0]}`,
      );

      writeFileSync(opinionsPath, updated, "utf8");
    }

    return result;
  } catch {
    return result;
  }
}

/**
 * Guess the domain for a new opinion based on keywords.
 * @param {string} statement
 * @returns {string}
 */
function guessDomain(statement) {
  const lower = statement.toLowerCase();
  if (/\b(import|module|depend|package|npm)\b/.test(lower))
    return "architecture";
  if (/\b(test|assert|mock|spec|fixture)\b/.test(lower)) return "testing";
  if (/\b(deploy|build|compile|bundle|ci)\b/.test(lower)) return "tools";
  if (/\b(hook|session|identity|memory)\b/.test(lower)) return "architecture";
  if (/\b(security|auth|key|token|perm)\b/.test(lower)) return "security";
  return "general";
}
