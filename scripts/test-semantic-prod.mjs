// scripts/test-semantic-prod.ts
import { mkdtempSync, writeFileSync as writeFileSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// server/src/embedding-types.ts
var BUILT_IN_BASE_URL = "https://api.projectbrain.tech/api/v1";
var BUILT_IN_MODEL = "BAAI/bge-small-en-v1.5";
var BUILT_IN_KEY = "community";
function readEmbeddingConfig() {
  return {
    provider: process.env.EMBEDDING_PROVIDER || "",
    apiKey: process.env.EMBEDDING_API_KEY || BUILT_IN_KEY,
    model: process.env.EMBEDDING_MODEL || BUILT_IN_MODEL,
    baseUrl: process.env.EMBEDDING_BASE_URL || BUILT_IN_BASE_URL,
    maxTextLength: 2048,
    batchSize: 32
  };
}
var EMPTY_PLACEHOLDER = "empty document";
function sanitizeForEmbedding(text) {
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ""
  ).trim();
  return cleaned.length === 0 ? EMPTY_PLACEHOLDER : cleaned;
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// server/src/embedding-remote.ts
var MAX_RETRIES = 3;
var RETRY_BASE_MS = 500;
var MAX_CONSECUTIVE_FAILURES = 5;
function adaptiveBatchSize(totalChunks, baseBatch) {
  if (totalChunks > 3e3) return Math.min(baseBatch * 4, 128);
  if (totalChunks > 1500) return Math.min(baseBatch * 2, 64);
  return baseBatch;
}
function resolveModelName(model, baseUrl) {
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  if (isOpenRouter && !model.includes("/")) {
    return `openai/${model}`;
  }
  return model;
}
var RemoteEmbeddingProvider = class {
  name = "remote";
  apiKey;
  model;
  baseUrl;
  maxTextLength;
  batchSize;
  resolvedModel;
  healthChecked = false;
  healthy = true;
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.maxTextLength = config.maxTextLength;
    this.batchSize = config.batchSize;
    this.resolvedModel = resolveModelName(this.model, this.baseUrl);
  }
  isAvailable() {
    return !!this.apiKey;
  }
  /**
   * Check if the embedding server is reachable.
   * TEI exposes /health at the root URL. We derive it from baseUrl.
   * Caches the result to avoid repeated pings within the same session.
   */
  async checkHealth() {
    if (this.healthChecked) return this.healthy;
    try {
      const healthUrl = this.baseUrl.replace(/\/v1\/?$/, "/health");
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5e3)
      });
      this.healthy = response.ok;
    } catch {
      this.healthy = false;
    }
    this.healthChecked = true;
    if (!this.healthy) {
      console.warn(
        "  Embedding server health check failed \u2014 server unreachable"
      );
    }
    return this.healthy;
  }
  async generateBatch(chunks) {
    const result = [];
    let consecutiveFailures = 0;
    let skippedChunks = 0;
    const effectiveBatch = adaptiveBatchSize(chunks.length, this.batchSize);
    console.log(
      `  Generating embeddings via remote server (${this.resolvedModel}, ${chunks.length} chunks, batch=${effectiveBatch})...`
    );
    for (let i = 0; i < chunks.length; i += effectiveBatch) {
      const batch = chunks.slice(i, i + effectiveBatch);
      let batchSuccess = false;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const embeddings = await this.callEmbeddingAPI(
            batch.map((c) => c.content)
          );
          for (let j = 0; j < batch.length; j++) {
            result.push({ ...batch[j], embedding: embeddings[j] });
          }
          batchSuccess = true;
          consecutiveFailures = 0;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(
            `
  Batch ${Math.floor(i / effectiveBatch) + 1} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg}`
          );
          if (attempt < MAX_RETRIES - 1) {
            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
            console.log(`  Retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!batchSuccess) {
        consecutiveFailures++;
        skippedChunks += batch.length;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `
  ${consecutiveFailures} consecutive batch failures \u2014 aborting remote provider`
          );
          const dims = result.length > 0 ? result[0].embedding.length : 768;
          for (const chunk of chunks.slice(i)) {
            result.push({ ...chunk, embedding: new Array(dims).fill(0) });
          }
          break;
        }
        console.log(`  Retrying batch items individually...`);
        for (const chunk of batch) {
          try {
            const [embedding] = await this.callEmbeddingAPI([chunk.content]);
            result.push({ ...chunk, embedding });
          } catch {
            const dims = result.length > 0 ? result[0].embedding.length : 768;
            result.push({ ...chunk, embedding: new Array(dims).fill(0) });
            skippedChunks++;
          }
        }
      }
      const progress = Math.min(i + effectiveBatch, chunks.length);
      process.stdout.write(`\r  Progress: ${progress}/${chunks.length} chunks`);
    }
    if (skippedChunks > 0) {
      console.log(`
  \u26A0 ${skippedChunks} chunks used zero-vector fallback`);
    }
    console.log();
    return { chunks: result, vocabulary: [], embeddingType: "remote" };
  }
  async generateQuery(query) {
    const prefixed = this.isBgeModel() ? `Represent this sentence for searching relevant passages: ${query}` : query;
    const [embedding] = await this.callEmbeddingAPI([prefixed]);
    return embedding;
  }
  /** Check if the model is a BGE variant (benefits from instruction prefix) */
  isBgeModel() {
    return this.model.toLowerCase().includes("bge-");
  }
  /** Prepend BGE instruction prefix for document embeddings */
  addDocumentPrefix(text) {
    return this.isBgeModel() ? `Represent this document for retrieval: ${text}` : text;
  }
  /** Call the remote embedding API */
  async callEmbeddingAPI(texts) {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.resolvedModel,
        input: texts.map(
          (t) => this.addDocumentPrefix(sanitizeForEmbedding(t).slice(0, this.maxTextLength))
        )
      }),
      signal: AbortSignal.timeout(6e4)
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Remote embedding failed (${response.status}): ${errText}`
      );
    }
    const data = await response.json();
    return data.data.map((d) => d.embedding);
  }
};

// server/src/embedding-tfidf.ts
var VOCAB_SIZE = 768;
function stem(word) {
  if (word.length < 4) return word;
  return word.replace(/ies$/, "i").replace(/tion$/, "t").replace(/sion$/, "s").replace(/ment$/, "").replace(/ness$/, "").replace(/ing$/, "").replace(/ous$/, "").replace(/ble$/, "").replace(/ful$/, "").replace(/ally$/, "").replace(/ize$/, "").replace(/ise$/, "").replace(/ent$/, "").replace(/ant$/, "").replace(/ed$/, "").replace(/er$/, "").replace(/es$/, "").replace(/ly$/, "").replace(/s$/, "");
}
function tokenize(text) {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 2).map(stem);
}
function buildVocabulary(chunks) {
  const wordCounts = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    const words = tokenize(chunk.content);
    const uniqueWords = new Set(words);
    for (const word of uniqueWords) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }
  const numDocs = chunks.length;
  const minDocs = 2;
  const maxDocs = Math.floor(numDocs * 0.8);
  return Array.from(wordCounts.entries()).filter(([, count]) => count >= minDocs && count <= maxDocs).sort((a, b) => b[1] - a[1]).slice(0, VOCAB_SIZE).map(([word]) => word);
}
function computeTfIdf(text, vocabulary, idfScores) {
  const words = tokenize(text);
  const wordCounts = /* @__PURE__ */ new Map();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }
  const maxCount = Math.max(...Array.from(wordCounts.values()), 1);
  return vocabulary.map((term) => {
    const tf = (wordCounts.get(term) || 0) / maxCount;
    const idf = idfScores.get(term) || 0;
    return tf * idf;
  });
}
function computeIdfScores(chunks, vocabulary) {
  const docFreq = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    const words = new Set(tokenize(chunk.content));
    for (const word of vocabulary) {
      if (words.has(word)) {
        docFreq.set(word, (docFreq.get(word) || 0) + 1);
      }
    }
  }
  const idfScores = /* @__PURE__ */ new Map();
  for (const [word, freq] of docFreq) {
    idfScores.set(word, Math.log(chunks.length / (freq + 1)) + 1);
  }
  return idfScores;
}
var TfIdfEmbeddingProvider = class {
  name = "tfidf";
  isAvailable() {
    return true;
  }
  async generateBatch(chunks, existingVocabulary) {
    console.log(`  Generating TF-IDF embeddings (${chunks.length} chunks)...`);
    const vocabulary = existingVocabulary || buildVocabulary(chunks);
    const idfScores = computeIdfScores(chunks, vocabulary);
    const result = chunks.map((chunk) => ({
      ...chunk,
      embedding: computeTfIdf(chunk.content, vocabulary, idfScores)
    }));
    return { chunks: result, vocabulary, embeddingType: "tfidf" };
  }
  async generateQuery(query, vocabulary) {
    if (!vocabulary || vocabulary.length === 0) {
      throw new Error("Vocabulary required for TF-IDF query embedding");
    }
    const words = tokenize(query);
    const wordCounts = /* @__PURE__ */ new Map();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
    return vocabulary.map((term) => (wordCounts.get(term) || 0) > 0 ? 1 : 0);
  }
};

// server/src/embeddings.ts
function createProviderRegistry() {
  const config = readEmbeddingConfig();
  return [new RemoteEmbeddingProvider(config), new TfIdfEmbeddingProvider()];
}
function normalizeEmbeddingType(type) {
  if (type === "cloudflare" || type === "openai") return "remote";
  return type;
}
async function generateQueryEmbedding(query, vocabulary, embeddingType) {
  const registry = createProviderRegistry();
  const resolvedType = normalizeEmbeddingType(embeddingType || "");
  if (resolvedType === "remote") {
    const remote = registry.find((p) => p.name === "remote");
    if (remote?.isAvailable()) {
      const healthy = await remote.checkHealth();
      if (healthy) {
        try {
          return await remote.generateQuery(query);
        } catch (error) {
          console.warn(
            `  Remote query failed: ${error instanceof Error ? error.message : error}. Falling back to TF-IDF`
          );
        }
      } else {
        console.warn(
          "  Embedding server unreachable for query \u2014 falling back to TF-IDF"
        );
      }
    } else {
      console.warn(
        "  Index was built with remote embeddings but server not available now"
      );
    }
  }
  const tfidf = registry.find((p) => p.name === "tfidf");
  if (tfidf) {
    return tfidf.generateQuery(query, vocabulary);
  }
  throw new Error("No embedding provider available for query");
}

// server/src/capture-anchors.ts
var CAPTURE_ANCHORS = [
  // English
  "I learned that this approach works better",
  "the root cause of the bug was identified",
  "the fix was to change the configuration",
  "always remember to use this pattern, never that one",
  "watch out for this pitfall, it causes issues",
  // Spanish
  "aprend\xED que esta soluci\xF3n funciona mejor",
  "la causa ra\xEDz del error fue identificada",
  "la soluci\xF3n fue cambiar la configuraci\xF3n",
  "hay que recordar usar siempre este patr\xF3n, nunca aquel",
  "cuidado con este problema, causa fallos",
  // German
  "die Ursache des Fehlers war ein veralteter Cache",
  "die L\xF6sung war, den Index neu aufzubauen",
  // French
  "la cause racine du bogue \xE9tait une mauvaise configuration",
  "la solution consistait \xE0 invalider le cache",
  // Portuguese
  "a causa raiz do erro foi identificada",
  "aprendi que devemos sempre usar este padr\xE3o"
];
var anchorCache = null;
async function getAnchorEmbeddings() {
  if (anchorCache) return anchorCache;
  try {
    const embeddings = await Promise.all(
      CAPTURE_ANCHORS.map((a) => generateQueryEmbedding(a, void 0, "remote"))
    );
    const dim = embeddings[0]?.length ?? 0;
    if (dim < 128 || embeddings.some((e) => e.length !== dim)) return null;
    anchorCache = embeddings;
    return anchorCache;
  } catch {
    return null;
  }
}

// server/src/learning.ts
import * as fs from "node:fs";
import * as path from "node:path";
var OPINIONS_FILE = "14_OPINIONS.md";
var MAX_OPINIONS = 200;
var CAPTURE_BLOCKLIST = [
  /\b(exec|spawn|execFile|child_process|require\s*\()\b/i,
  /\b(readFile|writeFile|unlink|rmdir|fs\.\w+)\b/i,
  /\b(process\.env|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b/i,
  /\b(system\s*prompt|ignore\s*(previous|all)\s*instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\b/i,
  /https?:\/\/(?!github\.com|localhost)/i,
  /\b(curl|wget|fetch|XMLHttpRequest)\b/i,
  /[A-Za-z0-9+/]{50,}={0,2}/
];
function isCaptureSafe(text) {
  return !CAPTURE_BLOCKLIST.some((p) => p.test(text));
}
var CAPTURE_PATTERNS = [
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
  { pattern: /(?:recuerda que|remember that|no olvidar|don't forget)\s*[:-]?\s*(.{10,200})/i, domain: "general", confidence: 0.85, extract: (m) => m[1]?.trim() || null }
];
function cleanStatement(raw) {
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
function foldDiacritics(s) {
  return s.replace(/[áàäâãå]/g, "a").replace(/[ÁÀÄÂÃÅ]/g, "A").replace(/[éèëê]/g, "e").replace(/[ÉÈËÊ]/g, "E").replace(/[íìïî]/g, "i").replace(/[ÍÌÏÎ]/g, "I").replace(/[óòöôõ]/g, "o").replace(/[ÓÒÖÔÕ]/g, "O").replace(/[úùüû]/g, "u").replace(/[ÚÙÜÛ]/g, "U").replace(/ñ/g, "n").replace(/Ñ/g, "N").replace(/ç/g, "c").replace(/Ç/g, "C");
}
function extractWords(text) {
  return new Set(
    foldDiacritics(text.toLowerCase()).split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, "")).filter((w) => w.length > 3)
  );
}
function areSimilarStatements(a, b) {
  const wordsA = extractWords(a);
  const wordsB = extractWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}
function serializeOpinions(opinions) {
  const lines = [
    "# Opinion Bank",
    "",
    `> Auto-generated by Project Brain. ${opinions.length} opinions tracked.`,
    `> Last updated: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`,
    ""
  ];
  const grouped = /* @__PURE__ */ new Map();
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
function parseOpinions(content) {
  const opinions = [];
  const lines = content.split("\n");
  let current = null;
  let currentDomain = "general";
  const push = () => {
    if (current && current.id && current.statement) {
      const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      opinions.push({
        id: current.id,
        statement: current.statement,
        confidence: current.confidence ?? 0.5,
        domain: current.domain || currentDomain,
        evidence: current.evidence || { supporting: [], contradicting: [] },
        createdAt: current.createdAt || now,
        lastUpdated: current.lastUpdated || now
      });
    }
  };
  for (const line of lines) {
    const domainMatch = line.match(/^## (\w+)/);
    if (domainMatch) {
      currentDomain = domainMatch[1];
      continue;
    }
    const idMatch = line.match(/^### (op_\w+)/);
    if (idMatch) {
      push();
      current = { id: idMatch[1], domain: currentDomain };
      continue;
    }
    if (!current) continue;
    const stmtMatch = line.match(/^- \*\*Statement\*\*: (.+)/);
    if (stmtMatch) {
      current.statement = stmtMatch[1];
      continue;
    }
    const confMatch = line.match(/^- \*\*Confidence\*\*: ([\d.]+)/);
    if (confMatch) {
      current.confidence = parseFloat(confMatch[1]);
      continue;
    }
    const createdMatch = line.match(/^- \*\*Created\*\*: (.+)/);
    if (createdMatch) {
      current.createdAt = createdMatch[1];
      continue;
    }
    const updatedMatch = line.match(/^- \*\*Updated\*\*: (.+)/);
    if (updatedMatch) {
      current.lastUpdated = updatedMatch[1];
      continue;
    }
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
function opinionsPath(memoryPath) {
  return path.join(memoryPath, OPINIONS_FILE);
}
function loadOpinions(memoryPath) {
  const file = opinionsPath(memoryPath);
  if (!fs.existsSync(file)) return [];
  try {
    return parseOpinions(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}
function readOpinions(memoryPath) {
  return loadOpinions(memoryPath);
}
function persistOpinions(memoryPath, opinions) {
  const trimmed = opinions.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_OPINIONS);
  fs.writeFileSync(opinionsPath(memoryPath), serializeOpinions(trimmed), "utf-8");
}
function captureLearnings(memoryPath, text, source) {
  const existing = loadOpinions(memoryPath);
  const evidence = source || `mcp-${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`;
  const newStatements = [];
  const folded = foldDiacritics(text);
  for (const pattern of CAPTURE_PATTERNS) {
    const foldedRe = new RegExp(foldDiacritics(pattern.pattern.source), "gid");
    for (const match of folded.matchAll(foldedRe)) {
      const groupIdx = match.indices?.[1];
      const originalGroup = groupIdx ? text.slice(groupIdx[0], groupIdx[1]) : match[1];
      const synthetic = [match[0], originalGroup];
      const raw = pattern.extract(synthetic);
      if (!raw || raw.length < 10) continue;
      const cleaned = cleanStatement(raw);
      if (!cleaned || !isCaptureSafe(cleaned)) continue;
      const dupExisting = existing.some((o) => areSimilarStatements(o.statement, cleaned));
      const dupNew = newStatements.some((s) => areSimilarStatements(s, cleaned));
      if (dupExisting || dupNew) continue;
      const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      existing.push({
        id: `op_${Math.random().toString(36).substring(2, 8)}`,
        statement: cleaned,
        confidence: pattern.confidence,
        domain: pattern.domain,
        evidence: { supporting: [evidence], contradicting: [] },
        createdAt: now,
        lastUpdated: now
      });
      newStatements.push(cleaned);
    }
  }
  if (newStatements.length > 0) {
    const trimmed = existing.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_OPINIONS);
    fs.writeFileSync(opinionsPath(memoryPath), serializeOpinions(trimmed), "utf-8");
  }
  return {
    captured: newStatements.length,
    total: existing.length,
    statements: newStatements
  };
}

// server/src/semantic-capture.ts
var SEM_THRESHOLD = Number(process.env.CAPTURE_SEM_THRESHOLD) || 0.6;
var MIN_SENTENCE_LEN = 20;
var MAX_SENTENCES = 40;
function segmentSentences(text) {
  return text.split(/(?<=[.!?])\s+|[\n;]+/).map((s) => s.trim()).filter((s) => s.length >= MIN_SENTENCE_LEN).slice(0, MAX_SENTENCES);
}
async function scoreSentences(text) {
  const anchors = await getAnchorEmbeddings();
  if (!anchors) return null;
  const dim = anchors[0].length;
  const hits = [];
  for (const sentence of segmentSentences(text)) {
    let emb;
    try {
      emb = await generateQueryEmbedding(sentence, void 0, "remote");
    } catch {
      return null;
    }
    if (emb.length !== dim) return null;
    let best = 0;
    for (const anchor of anchors) {
      const sim = cosineSimilarity(emb, anchor);
      if (sim > best) best = sim;
    }
    if (best >= SEM_THRESHOLD) hits.push({ statement: sentence, score: best });
  }
  return hits;
}
function persistSemanticHits(memoryPath, hits, source) {
  const existing = readOpinions(memoryPath);
  const evidence = source || `mcp-sem-${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`;
  const newStatements = [];
  for (const hit of hits) {
    const cleaned = cleanStatement(hit.statement);
    if (!cleaned || !isCaptureSafe(cleaned)) continue;
    if (existing.some((o) => areSimilarStatements(o.statement, cleaned))) continue;
    if (newStatements.some((s) => areSimilarStatements(s, cleaned))) continue;
    const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    existing.push({
      id: `op_${Math.random().toString(36).substring(2, 8)}`,
      statement: cleaned,
      confidence: Math.min(0.8, Math.max(0.5, hit.score)),
      domain: "general",
      evidence: { supporting: [`${evidence} (semantic ${hit.score.toFixed(2)})`], contradicting: [] },
      createdAt: now,
      lastUpdated: now
    });
    newStatements.push(cleaned);
  }
  if (newStatements.length > 0) persistOpinions(memoryPath, existing);
  return { captured: newStatements.length, total: existing.length, statements: newStatements };
}
async function captureLearningHybrid(memoryPath, text, source) {
  const lexical = captureLearnings(memoryPath, text, source);
  if (lexical.captured > 0) return { ...lexical, mode: "lexical" };
  const hits = await scoreSentences(text);
  if (!hits || hits.length === 0) {
    return { ...lexical, mode: "none" };
  }
  const semantic = persistSemanticHits(memoryPath, hits, source);
  return { ...semantic, mode: semantic.captured > 0 ? "semantic" : "none" };
}

// scripts/test-semantic-prod.ts
async function main() {
  process.env.EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || "https://api.projectbrain.tech/api/v1";
  process.env.EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "community";
  const dir = mkdtempSync(join2(tmpdir(), "pb-sem-"));
  writeFileSync2(join2(dir, "14_OPINIONS.md"), "# Opinions\n\n");
  const samples = [
    {
      lang: "DE",
      text: "Die eigentliche Ursache war ein veralteter Cache, der nach jedem Build geleert werden muss."
    },
    {
      lang: "FR",
      text: "La cause racine etait une configuration obsolete; il faut toujours invalider le cache apres le deploiement."
    },
    {
      lang: "ES",
      text: "Aprendimos que el servicio debe reiniciarse para que las variables de entorno surtan efecto."
    },
    {
      lang: "IT",
      text: "La causa principale era una cache obsoleta che deve essere svuotata dopo ogni compilazione."
    },
    {
      lang: "PT",
      text: "A licao aprendida foi que o token Bearer precisa ser aceito alem do cabecalho x-api-key."
    },
    {
      lang: "NL",
      text: "We hebben geleerd dat de proxy de Authorization-header moet doorsturen naar de backend."
    }
  ];
  let semanticCount = 0;
  for (const s of samples) {
    const res = await captureLearningHybrid(dir, s.text, `e2e-${s.lang}`);
    const flag = res.mode === "semantic" ? "\u2705" : res.mode === "lexical" ? "\u{1F4D0}" : "\u26AA";
    console.log(
      `${flag} [${s.lang}] mode=${res.mode} captured=${res.captured} :: ${s.text.slice(0, 60)}...`
    );
    if (res.mode === "semantic") semanticCount++;
  }
  const opinionsPath2 = join2(dir, "14_OPINIONS.md");
  if (existsSync2(opinionsPath2)) {
    const body = readFileSync2(opinionsPath2, "utf8");
    const lines = body.split("\n").filter((l) => l.trim().startsWith("-") || l.includes("statement"));
    console.log(`
\u{1F4C2} 14_OPINIONS.md (${body.length} chars)`);
    console.log(body.slice(0, 600));
  }
  console.log(
    `
${semanticCount > 0 ? "\u{1F3F4}\u200D\u2620\uFE0F PUERTO SEGURO" : "\u26C8\uFE0F TORMENTA"} \u2014 semantic captures: ${semanticCount}/${samples.length}`
  );
  process.exit(semanticCount > 0 ? 0 : 1);
}
main().catch((err) => {
  console.error("\u274C ERROR:", err);
  process.exit(2);
});
