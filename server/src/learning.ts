/**
 * Learning — portable opinion capture + persistence (zero vscode deps).
 *
 * Migrated from the extension's auto-capture / opinion-bank stack so the
 * self-learning quality loop works from ANY MCP client. Pure fs/path.
 *
 * Flow: scan text with CAPTURE_PATTERNS → clean → safety check → dedup
 * against existing opinions (>60% word overlap) → persist to 14_OPINIONS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Opinion {
  id: string;
  statement: string;
  confidence: number;
  domain: string;
  evidence: { supporting: string[]; contradicting: string[] };
  createdAt: string;
  lastUpdated: string;
}

export const OPINIONS_FILE = "14_OPINIONS.md";
const MAX_OPINIONS = 200;

// ─── Capture patterns ───────────────────────────────────────────────────────

interface CapturePattern {
  pattern: RegExp;
  domain: string;
  confidence: number;
  extract: (m: RegExpMatchArray) => string | null;
}

const CAPTURE_BLOCKLIST: RegExp[] = [
  /\b(exec|spawn|execFile|child_process|require\s*\()\b/i,
  /\b(readFile|writeFile|unlink|rmdir|fs\.\w+)\b/i,
  /\b(process\.env|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/i,
  /\b(system\s*prompt|ignore\s*(previous|all)\s*instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\b/i,
  /https?:\/\/(?!github\.com|localhost)/i,
  /\b(curl|wget|fetch|XMLHttpRequest)\b/i,
  /[A-Za-z0-9+/]{50,}={0,2}/,
];

export function isCaptureSafe(text: string): boolean {
  return !CAPTURE_BLOCKLIST.some((p) => p.test(text));
}

const CAPTURE_PATTERNS: CapturePattern[] = [
  { pattern: /(?:la solución fue|the fix was|se resolvió con|fixed by|resolved by)\s*[:-]?\s*(.{10,200})/i, domain: "debugging", confidence: 0.75, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:error resuelto|bug fixed|issue resolved)[:-]?\s*(.{10,200})/i, domain: "debugging", confidence: 0.7, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:el problema era que|the root cause was|caused by|the issue was|el error era)\s*[:-]?\s*(.{10,200})/i, domain: "debugging", confidence: 0.75, extract: (m) => `Root cause: ${m[1]?.trim()}` },
  { pattern: /(?:decidimos|we decided|decision made|opted for|elegimos)\s*[:-]?\s*(.{10,200})/i, domain: "architecture", confidence: 0.8, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:deberíamos usar|we should use|la mejor opción es|the best approach is|conviene usar)\s*[:-]?\s*(.{10,200})/i, domain: "architecture", confidence: 0.7, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:aprendí que|learned that|lesson learned|nota importante|key insight)\s*[:-]?\s*(.{10,200})/i, domain: "general", confidence: 0.7, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:funciona mejor si|works better when|el truco es|the trick is|best practice)\s*[:-]?\s*(.{10,200})/i, domain: "patterns", confidence: 0.65, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:cuidado con|watch out for|esto causa problemas|this causes issues|ojo con|beware of)\s*[:-]?\s*(.{10,200})/i, domain: "patterns", confidence: 0.7, extract: (m) => `Warning: ${m[1]?.trim()}` },
  { pattern: /(?:usar siempre|always use|nunca usar|never use|preferir|prefer)\s+(.{5,150})/i, domain: "tools", confidence: 0.7, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:siempre que|every time|cada vez que|whenever you|each time)\s+(.{10,200})/i, domain: "workflow", confidence: 0.6, extract: (m) => m[1]?.trim() || null },
  { pattern: /(?:más rápido si|faster when|performance tip|optimizar con|optimize with|mejora el rendimiento)\s*[:-]?\s*(.{10,200})/i, domain: "patterns", confidence: 0.65, extract: (m) => `Perf: ${m[1]?.trim()}` },
  { pattern: /(?:recuerda que|remember that|no olvidar|don't forget)\s*[:-]?\s*(.{10,200})/i, domain: "general", confidence: 0.85, extract: (m) => m[1]?.trim() || null },
];

export function cleanStatement(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/[.;,]+$/, "").trim();
  s = s.replace(/^(que|that|porque|because|ya que|since)\s+/i, "").trim();
  s = s.replace(/^\|+\s*/, "").replace(/\s*\|+$/, "").trim();
  s = s.replace(/^\*+\s*/, "").replace(/\s*\*+$/, "").trim();
  if (/^[|`*#>-]/.test(s) || /[|]$/.test(s)) return null;
  if (/^`[^`]+`$/.test(s)) return null;
  if (s.length < 10 || s.length > 200) return null;
  const wordCount = s.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount < 3) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Diacritic folding ──────────────────────────────────────────────────────

/**
 * Fold accented characters to their ASCII base, 1:1 (length- and index-
 * preserving). Lets capture patterns match regardless of accents/locale
 * ("solución" === "solucion") without depending on exact orthography.
 */
export function foldDiacritics(s: string): string {
  return s
    .replace(/[áàäâãå]/g, "a").replace(/[ÁÀÄÂÃÅ]/g, "A")
    .replace(/[éèëê]/g, "e").replace(/[ÉÈËÊ]/g, "E")
    .replace(/[íìïî]/g, "i").replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[óòöôõ]/g, "o").replace(/[ÓÒÖÔÕ]/g, "O")
    .replace(/[úùüû]/g, "u").replace(/[ÚÙÜÛ]/g, "U")
    .replace(/ñ/g, "n").replace(/Ñ/g, "N")
    .replace(/ç/g, "c").replace(/Ç/g, "C");
}

// ─── Dedup ──────────────────────────────────────────────────────────────────

function extractWords(text: string): Set<string> {
  return new Set(
    foldDiacritics(text.toLowerCase()).split(/\s+/)
      .map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ""))
      .filter((w) => w.length > 3),
  );
}

export function areSimilarStatements(a: string, b: string): boolean {
  const wordsA = extractWords(a);
  const wordsB = extractWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function serializeOpinions(opinions: Opinion[]): string {
  const lines: string[] = [
    "# Opinion Bank",
    "",
    `> Auto-generated by Project Brain. ${opinions.length} opinions tracked.`,
    `> Last updated: ${new Date().toISOString().split("T")[0]}`,
    "",
  ];
  const grouped = new Map<string, Opinion[]>();
  for (const op of opinions) {
    const list = grouped.get(op.domain) || [];
    list.push(op);
    grouped.set(op.domain, list);
  }
  for (const [domain, ops] of grouped) {
    lines.push(`## ${domain}`, "");
    for (const op of ops.sort((a, b) => b.confidence - a.confidence)) {
      lines.push(`### ${op.id}`, "");
      lines.push(`- **Statement**: ${op.statement}`);
      lines.push(`- **Confidence**: ${op.confidence.toFixed(2)}`);
      lines.push(`- **Created**: ${op.createdAt}`);
      lines.push(`- **Updated**: ${op.lastUpdated}`);
      if (op.evidence.supporting.length > 0) lines.push(`- **Supporting**: ${op.evidence.supporting.join("; ")}`);
      if (op.evidence.contradicting.length > 0) lines.push(`- **Contradicting**: ${op.evidence.contradicting.join("; ")}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function parseOpinions(content: string): Opinion[] {
  const opinions: Opinion[] = [];
  const lines = content.split("\n");
  let current: Partial<Opinion> | null = null;
  let currentDomain = "general";
  const push = () => {
    if (current && current.id && current.statement) {
      const now = new Date().toISOString().split("T")[0];
      opinions.push({
        id: current.id,
        statement: current.statement,
        confidence: current.confidence ?? 0.5,
        domain: current.domain || currentDomain,
        evidence: current.evidence || { supporting: [], contradicting: [] },
        createdAt: current.createdAt || now,
        lastUpdated: current.lastUpdated || now,
      });
    }
  };
  for (const line of lines) {
    const domainMatch = line.match(/^## (\w+)/);
    if (domainMatch) { currentDomain = domainMatch[1]; continue; }
    const idMatch = line.match(/^### (op_\w+)/);
    if (idMatch) { push(); current = { id: idMatch[1], domain: currentDomain }; continue; }
    if (!current) continue;
    const stmtMatch = line.match(/^- \*\*Statement\*\*: (.+)/);
    if (stmtMatch) { current.statement = stmtMatch[1]; continue; }
    const confMatch = line.match(/^- \*\*Confidence\*\*: ([\d.]+)/);
    if (confMatch) { current.confidence = parseFloat(confMatch[1]); continue; }
    const createdMatch = line.match(/^- \*\*Created\*\*: (.+)/);
    if (createdMatch) { current.createdAt = createdMatch[1]; continue; }
    const updatedMatch = line.match(/^- \*\*Updated\*\*: (.+)/);
    if (updatedMatch) { current.lastUpdated = updatedMatch[1]; continue; }
    const supMatch = line.match(/^- \*\*Supporting\*\*: (.+)/);
    if (supMatch) {
      current.evidence = current.evidence || { supporting: [], contradicting: [] };
      current.evidence.supporting = supMatch[1].split("; ").filter(Boolean);
      continue;
    }
    const conMatch = line.match(/^- \*\*Contradicting\*\*: (.+)/);
    if (conMatch) {
      current.evidence = current.evidence || { supporting: [], contradicting: [] };
      current.evidence.contradicting = conMatch[1].split("; ").filter(Boolean);
    }
  }
  push();
  return opinions;
}

function opinionsPath(memoryPath: string): string {
  return path.join(memoryPath, OPINIONS_FILE);
}

function loadOpinions(memoryPath: string): Opinion[] {
  const file = opinionsPath(memoryPath);
  if (!fs.existsSync(file)) return [];
  try {
    return parseOpinions(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/** Read all opinions for a project (public accessor). */
export function readOpinions(memoryPath: string): Opinion[] {
  return loadOpinions(memoryPath);
}

/**
 * Extract verbatim any '### ' blocks whose heading is NOT a managed `op_<id>`
 * opinion — e.g. '### [auto-promoted] …' entries written by OTHER Project Brain
 * components. `parseOpinions` ignores these, so without preserving them the
 * full-rewrite below would silently drop them once writes target the shared
 * committed store. Returns the joined raw block text (no trailing newline).
 */
function extractForeignBlocks(content: string): string {
  const out: string[] = [];
  let capturing = false;
  for (const line of content.split("\n")) {
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      capturing = !/^op_\w+/.test(h3[1].trim());
      if (capturing) out.push(line);
      continue;
    }
    if (capturing) {
      // A new heading ends the foreign block.
      if (/^#{1,3} /.test(line)) {
        capturing = false;
        continue;
      }
      out.push(line);
    }
  }
  return out.join("\n").trim();
}

/**
 * Persist an opinion array to 14_OPINIONS.md (sorted, capped). Preserves any
 * foreign (non-`op_`) entries already in the file so a full rewrite never drops
 * content written by other components (see extractForeignBlocks).
 */
export function persistOpinions(memoryPath: string, opinions: Opinion[]): void {
  const trimmed = opinions
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_OPINIONS);
  const file = opinionsPath(memoryPath);
  let preserved = "";
  if (fs.existsSync(file)) {
    try {
      preserved = extractForeignBlocks(fs.readFileSync(file, "utf-8"));
    } catch {
      /* best effort — never block a write on a parse error */
    }
  }
  let output = serializeOpinions(trimmed);
  if (preserved) {
    output += `\n## preserved\n\n> Entries written by other Project Brain components, kept verbatim.\n\n${preserved}\n`;
  }
  fs.writeFileSync(file, output, "utf-8");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CaptureResult {
  captured: number;
  total: number;
  statements: string[];
}

/** Scan text for capturable learnings and persist new opinions. */
export function captureLearnings(
  memoryPath: string,
  text: string,
  source?: string,
): CaptureResult {
  const existing = loadOpinions(memoryPath);
  const evidence = source || `mcp-${new Date().toISOString().split("T")[0]}`;
  const newStatements: string[] = [];

  // Match on a diacritic-folded copy so accents/locale don't block capture,
  // but extract the ORIGINAL substring (tildes preserved) via match indices.
  const folded = foldDiacritics(text);

  for (const pattern of CAPTURE_PATTERNS) {
    const foldedRe = new RegExp(foldDiacritics(pattern.pattern.source), "gid");
    for (const match of folded.matchAll(foldedRe)) {
      const groupIdx = match.indices?.[1];
      const originalGroup = groupIdx ? text.slice(groupIdx[0], groupIdx[1]) : match[1];
      const synthetic = [match[0], originalGroup] as unknown as RegExpMatchArray;
      const raw = pattern.extract(synthetic);
      if (!raw || raw.length < 10) continue;
      const cleaned = cleanStatement(raw);
      if (!cleaned || !isCaptureSafe(cleaned)) continue;
      const dupExisting = existing.some((o) => areSimilarStatements(o.statement, cleaned));
      const dupNew = newStatements.some((s) => areSimilarStatements(s, cleaned));
      if (dupExisting || dupNew) continue;
      const now = new Date().toISOString().split("T")[0];
      existing.push({
        id: `op_${Math.random().toString(36).substring(2, 8)}`,
        statement: cleaned,
        confidence: pattern.confidence,
        domain: pattern.domain,
        evidence: { supporting: [evidence], contradicting: [] },
        createdAt: now,
        lastUpdated: now,
      });
      newStatements.push(cleaned);
    }
  }

  if (newStatements.length > 0) {
    persistOpinions(memoryPath, existing);
  }

  return {
    captured: newStatements.length,
    total: existing.length,
    statements: newStatements,
  };
}

/** Return all tracked opinions (optionally filtered by domain). */
export function listOpinions(memoryPath: string, domain?: string): Opinion[] {
  const all = loadOpinions(memoryPath);
  if (!domain) return all;
  return all.filter((o) => o.domain === domain);
}

/** Directly add a single opinion. Deduplicates against existing opinions. */
export function addOpinion(
  memoryPath: string,
  statement: string,
  confidence: number,
  domain: string,
): { added: boolean; id: string; reason?: string } {
  const existing = loadOpinions(memoryPath);
  const cleaned = cleanStatement(statement);
  if (!cleaned || cleaned.length < 5) {
    return { added: false, id: "", reason: "Statement too short or empty" };
  }
  if (!isCaptureSafe(cleaned)) {
    return { added: false, id: "", reason: "Statement blocked by safety filter" };
  }
  const dup = existing.find((o) => areSimilarStatements(o.statement, cleaned));
  if (dup) {
    // Boost confidence of existing opinion instead of duplicating
    dup.confidence = Math.min(0.99, Math.max(dup.confidence, confidence));
    dup.lastUpdated = new Date().toISOString().split("T")[0];
    persistOpinions(memoryPath, existing);
    return { added: false, id: dup.id, reason: `Similar opinion already exists (boosted to ${dup.confidence.toFixed(2)})` };
  }
  const now = new Date().toISOString().split("T")[0];
  const id = `op_${Math.random().toString(36).substring(2, 8)}`;
  const clampedConf = Math.min(0.99, Math.max(0.05, confidence));
  existing.push({
    id,
    statement: cleaned,
    confidence: clampedConf,
    domain: domain || "general",
    evidence: { supporting: ["manual-add"], contradicting: [] },
    createdAt: now,
    lastUpdated: now,
  });
  persistOpinions(memoryPath, existing);
  return { added: true, id };
}
