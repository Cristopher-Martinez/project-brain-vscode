#!/usr/bin/env node
/**
 * smoke-test-analysis-context.mjs
 *
 * Tests the analysis context-building pipeline from CLI:
 *   1. Structural map generation
 *   2. Key files reading
 *   3. RAG search (per-agent queries)
 *   4. Agent query coverage (all 10 agents have queries)
 *
 * Does NOT test LLM inference (requires VS Code Extension Host + Copilot).
 *
 * Usage:
 *   node scripts/smoke-test-analysis-context.mjs [repoPath]
 *   Default repoPath: C:\Users\dev\...\forge-orchestrator
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── Config ────────────────────────────────────────────────────────────

const REPO_PATH =
  process.argv[2] ||
  "C:\\Users\\dev\\OneDrive\\Documentos\\Repositorios\\tovectorize\\forge-orchestrator";

const CLI_PATH = path.join(ROOT, "dist", "mcp-server", "cli.mjs");

const EXPECTED_AGENTS = [
  "architect",
  "patterns",
  "components",
  "business-logic",
  "infrastructure",
  "security",
  "performance",
  "devops",
  "cookbook",
  "auditor",
];

const EXPECTED_OUTPUT_FILES = [
  "01_arquitectura.md",
  "02_patrones_y_calidad.md",
  "03_componentes_reutilizables.md",
  "04_logica_negocio.md",
  "05_infraestructura.md",
  "06_seguridad.md",
  "07_performance.md",
  "08_devops_y_escalabilidad.md",
  "09_cookbook.md",
  "10_auditoria_final.md",
];

// ─── Test Runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let assertions = 0;

function assert(condition, msg) {
  assertions++;
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

// ─── Load compiled context module ───────────────────────────────────────

const require = createRequire(import.meta.url);
let contextModule;
try {
  contextModule = require(path.join(ROOT, "dist", "self-learning-context.js"));
} catch (err) {
  console.error(
    "❌ Could not load dist/self-learning-context.js — run npm run compile first",
  );
  console.error(`   ${err.message}`);
  process.exit(1);
}

const { buildStructuralMap, readKeyFiles, getAgentQueries } = contextModule;

// ─── Tests ──────────────────────────────────────────────────────────────

console.log("🏴‍☠️ Analysis Context Smoke Test");
console.log(`   Repo: ${REPO_PATH}`);
console.log(`   CLI:  ${CLI_PATH}`);

// ── 1. Repo validation ──

section("1. Repo Validation");

assert(fs.existsSync(REPO_PATH), `Repo exists at ${REPO_PATH}`);
if (!fs.existsSync(REPO_PATH)) {
  console.error("\n⛔ Repo not found. Aborting.");
  process.exit(1);
}

const repoName = path.basename(REPO_PATH);
assert(
  repoName === "forge-orchestrator",
  `Repo name is '${repoName}' (expected forge-orchestrator)`,
);
console.log(`  ✅ Repo validated: ${repoName}`);

// ── 2. Structural Map ──

section("2. Structural Map");

const structMap = buildStructuralMap(REPO_PATH);
assert(typeof structMap === "string", "buildStructuralMap returns string");
assert(
  structMap.length > 100,
  `Structural map has content (${structMap.length} chars)`,
);
assert(structMap.includes("Estructura del Proyecto"), "Contains header");
assert(structMap.includes("Estadísticas"), "Contains stats summary");

// Check for known forge-orchestrator files
const hasCargoToml = structMap.includes("Cargo.toml");
const hasSrc = structMap.includes("src/") || structMap.includes("src");
assert(hasCargoToml, "Structural map includes Cargo.toml");
assert(hasSrc, "Structural map includes src/");

// Count files in map
const fileCountMatch = /(\d+) archivos/.exec(structMap);
assert(fileCountMatch !== null, "Stats contains file count");
if (fileCountMatch) {
  const fileCount = parseInt(fileCountMatch[1], 10);
  assert(fileCount > 5, `File count > 5 (got ${fileCount})`);
  console.log(
    `  ✅ Structural map: ${fileCount} files, ${structMap.length} chars`,
  );
}

// ── 3. Key Files ──

section("3. Key Files");

const keyFiles = readKeyFiles(REPO_PATH);
assert(typeof keyFiles === "string", "readKeyFiles returns string");
assert(
  keyFiles.length > 50,
  `Key files has content (${keyFiles.length} chars)`,
);
assert(keyFiles.includes("Archivos Clave"), "Contains header");

// Check specific files
const hasReadme = keyFiles.includes("README.md");
const hasCargo = keyFiles.includes("Cargo.toml");
assert(hasReadme, "Key files includes README.md");
assert(hasCargo, "Key files includes Cargo.toml");
console.log(`  ✅ Key files read: ${keyFiles.length} chars`);

// ── 4. Agent Queries ──

section("4. Agent Query Coverage");

for (const agentId of EXPECTED_AGENTS) {
  const queries = getAgentQueries(agentId);
  assert(Array.isArray(queries), `Agent '${agentId}' has queries array`);
  assert(
    queries.length >= 2,
    `Agent '${agentId}' has ≥2 queries (got ${queries.length})`,
  );
}
console.log(`  ✅ All ${EXPECTED_AGENTS.length} agents have RAG queries`);

// ── 5. RAG Search (live CLI) ──

section("5. RAG Search (CLI)");

const cliExists = fs.existsSync(CLI_PATH);
assert(cliExists, `CLI exists at ${CLI_PATH}`);

if (cliExists) {
  const testQueries = [
    { query: "entry point main index routing", agent: "architect" },
    { query: "security authentication token", agent: "security" },
    { query: "error handling try catch", agent: "patterns" },
  ];

  for (const { query, agent } of testQueries) {
    let output = "";
    try {
      output = execFileSync(
        "node",
        [CLI_PATH, "search", query, "-p", REPO_PATH, "-k", "3"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, EMBEDDING_PROVIDER: "tfidf" },
        },
      );
    } catch (err) {
      // search may exit 1 but still have stdout
      output = err.stdout ?? "";
    }

    const hasResults = output.includes("Result") || output.includes("Score");
    assert(hasResults, `RAG search for '${agent}' returns results`);
    if (hasResults) {
      const scoreMatch = /Score:\s*([\d.]+)%/i.exec(output);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
      console.log(
        `  ✅ Agent '${agent}': "${query}" → Score ${score.toFixed(1)}%`,
      );
    }
  }
}

// ── 6. Output File Mapping ──

section("6. Output File Mapping");

assert(
  EXPECTED_AGENTS.length === EXPECTED_OUTPUT_FILES.length,
  `${EXPECTED_AGENTS.length} agents = ${EXPECTED_OUTPUT_FILES.length} output files`,
);

// Verify the mapping matches ANALYSIS_AGENTS from types
let typesModule;
try {
  typesModule = require(path.join(ROOT, "dist", "self-learning-types.js"));
  const agents = typesModule.ANALYSIS_AGENTS;
  assert(Array.isArray(agents), "ANALYSIS_AGENTS is array");
  assert(
    agents.length === 10,
    `ANALYSIS_AGENTS has 10 entries (got ${agents.length})`,
  );

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    assert(agent.id !== undefined, `Agent ${i} has id`);
    assert(agent.outputFile !== undefined, `Agent ${i} has outputFile`);
    assert(
      EXPECTED_OUTPUT_FILES.includes(agent.outputFile),
      `Agent '${agent.id}' outputFile '${agent.outputFile}' is in expected list`,
    );
  }
  console.log(`  ✅ All 10 agents mapped to output files`);
} catch (err) {
  console.error(`  ⚠️ Could not load types module: ${err.message}`);
}

// ── 7. Analysis Directory Structure ──

section("7. Analysis Directory");

const analysisBase = path.join(ROOT, ".project-brain", "analysis");
const repoAnalysisDir = path.join(analysisBase, "forge-orchestrator");

if (fs.existsSync(repoAnalysisDir)) {
  const files = fs
    .readdirSync(repoAnalysisDir)
    .filter((f) => f.endsWith(".md"));
  console.log(`  📂 Analysis output exists: ${files.length} files`);

  for (const expected of EXPECTED_OUTPUT_FILES) {
    const exists = files.includes(expected);
    assert(exists, `Output file exists: ${expected}`);

    if (exists) {
      const content = fs.readFileSync(
        path.join(repoAnalysisDir, expected),
        "utf-8",
      );
      assert(
        content.length > 100,
        `${expected} has content (${content.length} chars)`,
      );
    }
  }

  if (files.length === 10) {
    console.log(`  ✅ All 10 analysis files present and have content`);
  }
} else {
  console.log(`  ⚠️ No analysis output yet at ${repoAnalysisDir}`);
  console.log(`  → Run analysis from Brain HQ first (requires Copilot LM API)`);
}

// ── 8. Context Size Budget ──

section("8. Context Budget Validation");

const MAX_TOTAL = 30_000;
const MAX_KEY = 3_000;
const MAX_RAG = 4_000;

// Simulate what buildAgentContext does
const totalEstimate = structMap.length + keyFiles.length;
assert(
  totalEstimate < MAX_TOTAL,
  `Structural map + key files < ${MAX_TOTAL} (got ${totalEstimate})`,
);
console.log(
  `  ✅ Base context: ${totalEstimate} / ${MAX_TOTAL} chars (${((totalEstimate / MAX_TOTAL) * 100).toFixed(0)}% budget)`,
);

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed}/${assertions} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  console.error(`⛔ ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("🏴‍☠️ ¡Tierra a la vista! All analysis context tests passed.");
  process.exit(0);
}
