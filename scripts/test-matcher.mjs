/**
 * Test the skill DISCOVERY matcher against real natural-language prompts.
 * Simulates the skillMatchScore logic from lm-tools.ts to verify
 * that the right skill wins for each prompt.
 *
 * Usage: node scripts/test-matcher.mjs [--graph]
 *   --graph  Apply graph-based semantic boost using real knowledge graph
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const USE_GRAPH = process.argv.includes("--graph");

// ─── Replicate matcher logic from lm-tools.ts ───────────────────────

const SKILL_NAME_STOPWORDS = new Set([
  "end",
  "are",
  "use",
  "set",
  "the",
  "for",
  "and",
  "not",
  "all",
  "any",
  "has",
  "had",
  "was",
  "get",
  "put",
  "run",
  "let",
  "var",
  "new",
  "try",
  "can",
  "may",
  "did",
  "its",
  "own",
  "add",
  "now",
  "top",
  "log",
  "raw",
]);

function stemWord(word) {
  if (word.length < 5) return word;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4)
    return word.slice(0, -1);
  return word;
}

function skillMatchScore(word, text, isNameField) {
  const stemmed = stemWord(word);
  if (isNameField && word.length <= 3 && SKILL_NAME_STOPWORDS.has(word))
    return 0;
  if (text.includes(word) || text.includes(stemmed)) return isNameField ? 3 : 1;
  return 0;
}

// ─── Load all skills ─────────────────────────────────────────────────

const SKILL_DIRS = [
  path.join(ROOT, "docs", "memory", "skills"),
  path.join(ROOT, "static", "skills"),
  path.join(ROOT, ".github", "skills"),
];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const fm = match[1];
  const nameMatch = fm.match(/name:\s*(.+)/);
  // Handle multi-line descriptions wrapped with quotes or continuing to next field
  let description = "";
  const descMatch = fm.match(
    /description:\s*['"]?([\s\S]*?)['"]?\s*(?:\n[a-z]|\n---|\n$)/,
  );
  if (descMatch) {
    description = descMatch[1].replace(/\n\s*/g, " ").trim();
  } else {
    const simpleDesc = fm.match(/description:\s*(.+)/);
    if (simpleDesc) description = simpleDesc[1].trim();
  }
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    description,
  };
}

const skills = [];
const seen = new Set();

for (const dir of SKILL_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "strategies") continue;
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, "utf-8");
    const { name, description } = parseFrontmatter(content);
    const skillName = name || entry.name;
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    skills.push({ name: skillName, description });
  }
}

// ─── Matcher simulation ─────────────────────────────────────────────

function matchSkill(queryKeywords) {
  const queryWords = queryKeywords
    .toLowerCase()
    .split(/[\s\-_,]+/)
    .filter((w) => w.length > 1);

  const scored = skills
    .map((s) => {
      let score = 0;
      let coverage = 0;
      const name = s.name.toLowerCase();
      const desc = s.description.toLowerCase();
      for (const word of queryWords) {
        const ns = skillMatchScore(word, name, true);
        const ds = skillMatchScore(word, desc, false);
        score += ns + ds;
        if (ns > 0 || ds > 0) coverage++;
      }
      return {
        name: s.name,
        description: s.description,
        score,
        coverage,
        graphBoost: 0,
      };
    })
    .filter((s) => s.score > 0);

  // Apply graph boost if enabled and graph exists
  if (USE_GRAPH && graphData) {
    applyGraphBoost(scored, queryKeywords);
  }

  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  return scored;
}

// ─── Graph Boost (replicated from graph-utils.ts) ────────────────────

const GRAPH_BOOST_MAX = 3;
const GRAPH_BOOST_THRESHOLD = 0.3;

/** Filter graph nodes to exclude source file paths (structural, not semantic). */
function filterSemanticNodes(nodeIds) {
  return nodeIds.filter(
    (id) => !id.includes("/") && !id.includes("\\") && !/\.\w{2,4}$/.test(id),
  );
}

const BLACKLISTED_NODES = new Set(["document", "project", "topic", "agent"]);

const EDGE_TYPE_WEIGHTS = {
  DEPENDS_ON: 1.0,
  EXTENDS: 1.0,
  DEFINED_IN: 0.8,
  LINKS_TO: 0.7,
  REFERENCES: 0.7,
  RELATED_TO: 0.5,
  TAGGED_AS: 0.5,
  CO_OCCURS_WITH: 0.3,
  DESCRIBED_AS: 0.1,
  MENTIONS: 0.1,
};

const GRAPH_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "about",
  "as",
  "into",
  "through",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "en",
  "con",
  "por",
  "para",
  "al",
  "que",
  "es",
  "son",
  "ser",
  "estar",
  "como",
  "más",
  "pero",
  "sin",
  "sobre",
  "entre",
  "hasta",
  "desde",
  "este",
  "esta",
  "estos",
  "estas",
  "ese",
  "esa",
  "esos",
  "esas",
  "lo",
  "le",
  "se",
  "su",
  "sus",
  "nos",
  "les",
]);

function graphTokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s-]/g, " ")
    .split(/[\s\-_,]+/)
    .filter((w) => w.length >= 3 && !GRAPH_STOPWORDS.has(w));
}

function parseGraphologyExport(raw) {
  const gData = raw.graphology || raw;
  const nodes = [];
  const edges = [];
  if (gData.nodes) {
    for (const n of gData.nodes) {
      nodes.push({
        id: n.key || n.id || "",
        type: n.attributes?.type || "entity",
        metadata: n.attributes || {},
      });
    }
  }
  if (gData.edges) {
    for (const e of gData.edges) {
      edges.push({
        from: e.source || e.from || "",
        to: e.target || e.to || "",
        type: e.attributes?.relationship || e.type || "RELATED_TO",
        weight: e.attributes?.confidence ?? 1.0,
      });
    }
  }
  return { nodes, edges };
}

function findMatchingNodes(graph, tokens) {
  const matches = [];
  for (const node of graph.nodes) {
    if (BLACKLISTED_NODES.has(node.id.toLowerCase())) continue;
    const nodeId = node.id.toLowerCase();
    for (const token of tokens) {
      if (nodeId.includes(token) || token.includes(nodeId)) {
        matches.push(node.id);
        break;
      }
    }
  }
  return matches;
}

function buildWeightedAdjacency(graph) {
  const adj = new Map();
  for (const edge of graph.edges) {
    const edgeWeight = EDGE_TYPE_WEIGHTS[edge.type] ?? 0.3;
    const confidence = edge.weight ?? 1.0;
    const w = edgeWeight * confidence;
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from).push({ target: edge.to, weight: w });
    adj.get(edge.to).push({ target: edge.from, weight: w });
  }
  return adj;
}

function graphProximity(adjacency, taskNodes, strategyNodes, maxDepth) {
  if (taskNodes.length === 0 || strategyNodes.length === 0)
    return { score: 0, pathCount: 0 };
  const strategySet = new Set(strategyNodes.map((n) => n.toLowerCase()));
  let totalWeight = 0;
  let pathCount = 0;
  for (const startNode of taskNodes) {
    const visited = new Set();
    const queue = [{ node: startNode, depth: 0, accWeight: 1.0 }];
    while (queue.length > 0) {
      const { node, depth, accWeight } = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);
      if (depth > 0 && strategySet.has(node.toLowerCase())) {
        const depthPenalty = 1.0 / (depth + 1);
        totalWeight += accWeight * depthPenalty;
        pathCount++;
      }
      if (depth < maxDepth) {
        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
          if (
            !visited.has(neighbor.target) &&
            !BLACKLISTED_NODES.has(neighbor.target.toLowerCase())
          ) {
            queue.push({
              node: neighbor.target,
              depth: depth + 1,
              accWeight: accWeight * neighbor.weight,
            });
          }
        }
      }
    }
  }
  const maxExpected = taskNodes.length * strategyNodes.length;
  const score = maxExpected > 0 ? Math.min(totalWeight / maxExpected, 1.0) : 0;
  return { score, pathCount };
}

function applyGraphBoost(scoredSkills, query) {
  const queryTokens = graphTokenize(query);
  const queryNodes = filterSemanticNodes(
    findMatchingNodes(graphData, queryTokens),
  );
  if (queryNodes.length === 0) return;
  for (const entry of scoredSkills) {
    const skillTokens = graphTokenize(`${entry.name} ${entry.description}`);
    const skillNodes = filterSemanticNodes(
      findMatchingNodes(graphData, skillTokens),
    );
    if (skillNodes.length === 0) continue;
    const proximity = graphProximity(graphAdjacency, queryNodes, skillNodes, 2);
    const boost = proximity.score * GRAPH_BOOST_MAX;
    if (boost >= GRAPH_BOOST_THRESHOLD) {
      entry.score += boost;
      entry.graphBoost = boost;
    }
  }
}

// Load graph data if --graph flag is set
let graphData = null;
let graphAdjacency = null;
if (USE_GRAPH) {
  const homeDir =
    process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "";
  const projectId = createHash("md5")
    .update(ROOT.replace(/\\/g, "/").toLowerCase())
    .digest("hex")
    .slice(0, 12);
  const graphPath = path.join(
    homeDir,
    ".mcp-rag-docs",
    `${projectId}.graph.json`,
  );
  if (fs.existsSync(graphPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
      graphData = parseGraphologyExport(raw);
      graphAdjacency = buildWeightedAdjacency(graphData);
      console.log(
        `  📊 Graph loaded: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges\n`,
      );
    } catch (e) {
      console.log(`  ⚠️ Graph load failed: ${e.message}\n`);
    }
  } else {
    console.log(`  ⚠️ No graph file found at ${graphPath}\n`);
  }
}

// ─── Test cases ──────────────────────────────────────────────────────
// Format: [LLM-translated keywords, expected winning skill]

const testCases = [
  // === USER-FACING (5) ===
  {
    keywords: "teach convention pattern brain",
    expected: "teach-brain",
    category: "user-facing",
  },
  {
    keywords: "remember save convention",
    expected: "remember-this",
    category: "user-facing",
  },
  {
    keywords: "what changed recent commits",
    expected: "what-changed",
    category: "user-facing",
  },
  {
    keywords: "project status overview",
    expected: "project-status",
    category: "user-facing",
  },
  {
    keywords: "new developer onboarding understand",
    expected: "onboarding",
    category: "user-facing",
  },

  // === WORKFLOW (8) ===
  {
    keywords: "build compile deploy extension",
    expected: "extension-build",
    category: "workflow",
  },
  {
    keywords: "git commit branch workflow",
    expected: "git-workflow",
    category: "workflow",
  },
  {
    keywords: "session summary handoff recap",
    expected: "session-recap",
    category: "workflow",
  },
  {
    keywords: "update documentation docs",
    expected: "doc-updater",
    category: "workflow",
  },
  {
    keywords: "embedding setup vectorize memory",
    expected: "embedding-setup",
    category: "workflow",
  },
  {
    keywords: "release deploy ship",
    expected: "extension-build",
    category: "workflow",
  },
  {
    keywords: "compile typescript build",
    expected: "extension-build",
    category: "workflow",
  },
  {
    keywords: "vectorize memory embedding",
    expected: "embedding-setup",
    category: "workflow",
  },

  // === DIAGNOSTIC (10) ===
  {
    keywords: "extension not activating debug activate",
    expected: "debug-extension",
    category: "diagnostic",
  },
  {
    keywords: "write tests skill-manager test",
    expected: "test-generator",
    category: "diagnostic",
  },
  {
    keywords: "code review changes",
    expected: "code-review",
    category: "diagnostic",
  },
  {
    keywords: "debug help broken failing something",
    expected: "troubleshoot",
    category: "diagnostic",
  }, // Was ❌
  {
    keywords: "dependencies vulnerabilities audit",
    expected: "dependency-audit",
    category: "diagnostic",
  },
  {
    keywords: "QA full release",
    expected: "qa-master",
    category: "diagnostic",
  },
  {
    keywords: "cross-platform mac linux windows",
    expected: "cross-platform-audit",
    category: "diagnostic",
  },
  {
    keywords: "TypeError error lm-tools runtime",
    expected: ["troubleshoot", "debug-extension"],
    category: "diagnostic",
  },
  {
    keywords: "unused packages npm dependencies clean",
    expected: "dependency-audit",
    category: "diagnostic",
  },
  {
    keywords: "unit tests classifySkill test",
    expected: "test-generator",
    category: "diagnostic",
  },

  // === AGENT-INTERNAL (11) ===
  {
    keywords: "batch multiple commands tasks",
    expected: "batch-mode",
    category: "agent-internal",
  },
  {
    keywords: "done finished task complete thanks",
    expected: "completion-guard",
    category: "agent-internal",
  },
  {
    keywords: "context overflow filling worried",
    expected: "context-management",
    category: "agent-internal",
  },
  {
    keywords: "who identity name personality agent",
    expected: "identity-persistence",
    category: "agent-internal",
  },
  {
    keywords: "cheap model cost optimization task routing",
    expected: "model-router",
    category: "agent-internal",
  },
  {
    keywords: "delegate complex tasks split work delegation",
    expected: "orchestration-strategy",
    category: "agent-internal",
  },
  {
    keywords: "review changes session before finishing",
    expected: "review-loop",
    category: "agent-internal",
  }, // Was ❌
  {
    keywords: "improve agent instructions upgrade self",
    expected: "self-upgrade",
    category: "agent-internal",
  }, // Was ❌
  {
    keywords: "create skill teach migrations",
    expected: "skill-creator",
    category: "agent-internal",
  },
  {
    keywords: "open files workspace current",
    expected: "workspace-awareness",
    category: "agent-internal",
  },
  {
    keywords: "verify slave verification slaves responding",
    expected: "slave-verification",
    category: "agent-internal",
  },

  // === REFERENCE (6) ===
  {
    keywords: "refactoring techniques refactor",
    expected: "refactoring-guru",
    category: "reference",
  },
  {
    keywords: "dependencies graph visual",
    expected: "graph-patterns",
    category: "reference",
  },
  {
    keywords: "configure agent vscode agents",
    expected: "vscode-agents-mastery",
    category: "reference",
  },
  {
    keywords: "copilot chat participant pattern source",
    expected: "copilot-source-reference",
    category: "reference",
  },
  {
    keywords: "implement new MCP tool",
    expected: "mcp-tools-pattern",
    category: "reference",
  },
  {
    keywords: "66 refactoring techniques",
    expected: "refactoring-guru",
    category: "reference",
  },
];

// ─── Run tests ───────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  SKILL MATCHER — NATURAL LANGUAGE DISCOVERY TEST");
console.log(
  `  ${skills.length} skills loaded, ${testCases.length} prompts${USE_GRAPH ? " [GRAPH BOOST: ON]" : ""}`,
);
console.log("═══════════════════════════════════════════════════════════\n");

let pass = 0;
let fail = 0;
let fragile = 0;
const failures = [];
const risks = [];

for (const tc of testCases) {
  const results = matchSkill(tc.keywords);
  const winner = results[0];
  const runnerUp = results[1];

  const expectedArr = Array.isArray(tc.expected) ? tc.expected : [tc.expected];
  const isCorrect = winner && expectedArr.includes(winner.name);

  // Check fragility: margin < 3 points over runner-up
  const margin =
    winner && runnerUp
      ? winner.score - runnerUp.score
      : winner
        ? winner.score
        : 0;
  const isFragile = isCorrect && margin < 3;

  if (isCorrect) {
    if (isFragile) {
      fragile++;
      const boostTag =
        winner.graphBoost > 0 ? ` 🔗+${winner.graphBoost.toFixed(1)}` : "";
      const tag = `⚠️  ${tc.keywords.slice(0, 45).padEnd(47)} → ${winner.name} (${winner.score.toFixed(1)}${boostTag}) [margin: ${(winner.score - (runnerUp?.score ?? 0)).toFixed(1)} vs ${runnerUp?.name}(${runnerUp?.score?.toFixed(1)})]`;
      risks.push(tag);
      console.log(tag);
    } else {
      pass++;
      const boostTag =
        winner.graphBoost > 0 ? ` 🔗+${winner.graphBoost.toFixed(1)}` : "";
      console.log(
        `✅  ${tc.keywords.slice(0, 45).padEnd(47)} → ${winner.name} (${winner.score.toFixed(1)}${boostTag})`,
      );
    }
  } else {
    fail++;
    const actual = winner
      ? `${winner.name}(${winner.score.toFixed(1)})`
      : "NONE";
    const expected = expectedArr.join("|");
    const expectedScores = expectedArr
      .map((e) => {
        const found = results.find((r) => r.name === e);
        return found ? `${e}(${found.score.toFixed(1)})` : `${e}(0)`;
      })
      .join(", ");
    const tag = `❌  ${tc.keywords.slice(0, 45).padEnd(47)} → GOT ${actual}, WANTED ${expected} [${expectedScores}]`;
    failures.push(tag);
    console.log(tag);
  }
}

console.log(`\n─────────────────────────────────────────────────────────`);
console.log(
  `  ✅ Sólidos: ${pass}  |  ⚠️  Frágiles: ${fragile}  |  ❌ Fallas: ${fail}  |  Total: ${testCases.length}`,
);
console.log(
  `  Tasa de acierto: ${Math.round(((pass + fragile) / testCases.length) * 100)}%`,
);

if (failures.length > 0) {
  console.log(`\n🔴 FALLAS:`);
  failures.forEach((f) => console.log(`  ${f}`));
}
if (risks.length > 0) {
  console.log(`\n🟡 RIESGOS (margen < 3):`);
  risks.forEach((r) => console.log(`  ${r}`));
}

console.log("");
process.exit(fail > 0 ? 1 : 0);
